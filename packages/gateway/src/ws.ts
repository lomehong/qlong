/**
 * ws 适配器(M2,评审 M2-01/02/03 修订版):
 * - A3 首帧认证:认证态留存于连接闭包,认证前不处理任何业务帧(token 不进 URL,评审 I-16)
 * - 上行信封过 validateEnvelope + uplink 全程 try/catch —— 畸形帧不可能击穿进程(M2-01)
 * - 认证成功即接线收件箱补投(M2-02,评审 I-11/D24)
 * - 连接表以 connId 守卫:同节点新连接踢旧连接,旧连接的 close 不会误删新会话(M2-03)
 * - 非 active 节点连不开(M2-18);管理断连带语义 close code 4001/4002(A6)
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import {
  CUSTODY_FEATURES, TRANSPORT_VERSION, MAX_TRANSPORT_BYTES,
  envelopeDigest, hasCustodyFeatures, isReceiptFrame, newId, validateEnvelope,
  type EnvelopeV1, type ReceiptFrame,
} from '@qlong/core';
import type { GatewayCore } from './core.js';
import type { GatewayDirectorySnapshot } from './types.js';
import type { GatewayCluster } from './cluster.js';
import type { SqliteCustodyStore } from './custody-store.js';
import { LocalClaimRegistry, type ClaimRegistry } from './claim.js';

export const AUTH_KEY = 'node_' + 'token';
// Allow framing overhead without accepting arbitrarily large JSON or send queues.
const MAX_FRAME_BYTES = MAX_TRANSPORT_BYTES + 4_096;
const MAX_BUFFERED_BYTES = MAX_FRAME_BYTES * 2;
const MAX_WINDOW = 16;

export interface WsGatewayOptions {
  core: GatewayCore;
  /** Supplying custody requires transport v2; legacy routing is never used. */
  custody?: SqliteCustodyStore;
  /** Test tuning: positive integer milliseconds; defaults to 1 second. */
  retryIntervalMs?: number;
  /** Test tuning: integer in [1, 16]; defaults to 16. */
  window?: number;
  /** Cached ACL/connection state must not outlive an unavailable authority. */
  assertAuthorityAvailable?: () => void;
  /** A3:node token → 节点(注册中心 authByToken);无效或非 active = 拒绝(close 4003) */
  authenticate: (nodeToken: string) => { node_id: string; team_id: string; status: string } | undefined;
  /** 单实例在线态:connect 后、auth_ok 前置真;仅当前 connId 清理时置假。异常将断连。 */
  onPresenceChange?: (nodeId: string, online: boolean, connId: string) => void;
  /** 02 §12.1:集群路由(source ACL 已过,目标不在本网关时调用) */
  cluster?: GatewayCluster;
  /** 02 §12.1 总线:集群共享密钥(设置后本 server 暴露 POST /internal/envelope 中继端点) */
  clusterSecret?: string;
  /** D1:连接 claim 注册表(generation 归属仲裁);缺省单 authority 内存实现(LocalClaimRegistry)。 */
  claimRegistry?: ClaimRegistry;
  /** D1:本网关进程稳定标识(claim 归属方);缺省 'gw1'。生产须传唯一值(如 clusterName)。 */
  authorityId?: string;
  /**
   * D1b:claim 租约续期/回收定时器周期(ms);缺省 10_000(远小于 LocalClaimRegistry 缺省 TTL 30s)。
   * 约束:必须 < claimRegistry 的 leaseTtlMs,否则活连接会在两次续租间被误 reap。测试可调小。
   */
  claimRenewIntervalMs?: number;
}

interface RegistryLike {
  snapshot(): GatewayDirectorySnapshot;
  getNode(nodeId: string): { status: string } | undefined;
}

interface ConnState {
  ws: WebSocket;
  nodeId: string;
  connId: string;
  /** D1a:本连接的 claim fencing token(claim 时分配;disconnect 时据此 release)。 */
  generation: number;
  ready: boolean;
  /** Opaque ticket → delivery, scoped to this authenticated connection only. */
  inflight: Map<string, { envelope: EnvelopeV1; digest: string; lastSentAt: number }>;
}

export class WsGateway {
  readonly server = createServer((req, res) => {
    // 中继端点(registerInternalRelay)认领的请求不在回 426(中继等 body 异步应答)
    if (this.opts.clusterSecret && req.method === 'POST' && (req.url ?? '').split('?')[0] === '/internal/envelope') {
      return;
    }
    res.writeHead(426);
    res.end();
  });
  readonly wss: WebSocketServer;
  /** connId → 连接(守卫键:M2-03) */
  private socketsByConn = new Map<string, ConnState>();
  /** nodeId → 当前 connId(同节点新连接踢旧) */
  private currentConnByNode = new Map<string, string>();
  private syncTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private readonly retryIntervalMs: number;
  private readonly window: number;
  /** D1:claim 注册表(generation 归属)+ 本进程 authorityId;缺省单 authority 内存实现。 */
  private readonly claimRegistry: ClaimRegistry;
  private readonly authorityId: string;
  /** D1b:claim 租约续期/回收定时器周期(ms)。 */
  private readonly claimRenewIntervalMs: number;
  /** D1b:authority-liveness 续租定时器(无条件运行——claim 在 auth/disconnect 无条件接线)。 */
  private renewTimer?: NodeJS.Timeout;
  private unavailable = false;
  private started = false;
  private closing = false;
  private pendingListen?: Promise<number>;
  private closePromise?: Promise<void>;

  /** 每个 HTTP server 只注册一个 upgrade listener,关闭时仅拆除自己的挂载。 */
  private readonly upgradeBindings = new Map<Server, {
    paths: Set<string>;
    listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  }>();

  constructor(private readonly opts: WsGatewayOptions) {
    if (opts.custody && (opts.cluster !== undefined || opts.clusterSecret !== undefined)) {
      throw new Error('Durable custody does not support cluster routing');
    }
    this.retryIntervalMs = opts.retryIntervalMs === undefined ? 1_000 : opts.retryIntervalMs;
    this.window = opts.window === undefined ? MAX_WINDOW : opts.window;
    this.claimRegistry = opts.claimRegistry ?? new LocalClaimRegistry();
    this.authorityId = opts.authorityId ?? 'gw1';
    this.claimRenewIntervalMs = opts.claimRenewIntervalMs === undefined ? 10_000 : opts.claimRenewIntervalMs;
    if (!Number.isSafeInteger(this.retryIntervalMs) || this.retryIntervalMs < 1 || this.retryIntervalMs > 2_147_483_647) {
      throw new RangeError('retryIntervalMs must be a positive timer interval');
    }
    if (!Number.isSafeInteger(this.window) || this.window < 1 || this.window > MAX_WINDOW) {
      throw new RangeError('window must be an integer between 1 and 16');
    }
    if (!Number.isSafeInteger(this.claimRenewIntervalMs) || this.claimRenewIntervalMs < 1 || this.claimRenewIntervalMs > 2_147_483_647) {
      throw new RangeError('claimRenewIntervalMs must be a positive timer interval');
    }
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
    // 独立端口模式:listen() 的 server 上 '/' 即网关入口
    this.bindUpgrade(this.server, '/');
    this.start();
  }

  /** 单端口部署(02 §12.1):把网关挂到业务 HTTP server 的指定路径(/gateway) */
  attach(server: Server, path: string): void {
    this.bindUpgrade(server, path);
  }

  private bindUpgrade(server: Server, path: string): void {
    if (this.closing) throw new Error('Gateway is closing');
    const existing = this.upgradeBindings.get(server);
    if (existing) {
      existing.paths.add(path);
      return;
    }
    const paths = new Set([path]);
    const listener = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
      const p = (req.url ?? '/').split('?')[0] ?? '';
      if (paths.has(p)) {
        if (this.closing || this.unavailable) {
          socket.destroy();
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
      }
    };
    this.upgradeBindings.set(server, { paths, listener });
    server.on('upgrade', listener);
  }

  start(): void {
    if (this.started || this.closing || this.unavailable) return;
    this.started = true;
    this.registerInternalRelay();
    this.wss.on('connection', (ws) => {
      let connId: string | null = null;
      let nodeId = '';

      const cleanup = (): void => {
        if (connId === null) return;
        this.disconnect(connId, nodeId);
      };

      ws.on('message', (data) => {
        if (this.closing || this.unavailable || ws.readyState !== WebSocket.OPEN) return;
        try { this.opts.assertAuthorityAvailable?.(); } catch {
          if (this.opts.custody) {
            this.failClosed();
            return;
          }
          cleanup();
          // No success/rejection ACK: sender must retain custody until authority recovers.
          this.closeSocket(ws, 1011, 'authority unavailable');
          return;
        }
        let frame: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(String(data));
          // M2-01:null/数组/原始类型一律按垃圾帧静默 —— 不得在后续属性访问中炸出未捕获异常
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
          frame = parsed as Record<string, unknown>;
        } catch {
          return; // 非 JSON:认证前静默;认证后按未知帧静默(协议演进位)
        }

        // ---- A3 认证帧(connId === null 表示尚未认证)----
        if (connId === null) {
          const token = frame[AUTH_KEY];
          if (frame.frame !== 'auth' || typeof token !== 'string') {
            this.closeSocket(ws, 4003, 'unauthorized');
            return;
          }
          const compatible = this.opts.custody
            ? frame.transport_version === TRANSPORT_VERSION && hasCustodyFeatures(frame.features)
            : frame.transport_version === undefined || frame.transport_version === 1;
          if (!compatible) {
            this.closeSocket(ws, 4004, 'version_mismatch');
            return;
          }
          let node: ReturnType<WsGatewayOptions['authenticate']>;
          try {
            node = this.opts.authenticate(token);
          } catch {
            this.closeSocket(ws, 4003, 'unauthorized');
            return;
          }
          if (!node || node.status !== 'active') {
            this.closeSocket(ws, 4003, 'unauthorized'); // M2-18:非 active 节点连不开
            return;
          }
          connId = newId();
          nodeId = node.node_id;
          // D1a:认领归属(generation 单调 fencing token)——先于踢旧,新 generation 立即超越旧主。
          // D1c:共享 SqliteClaimStore 的 claim 可能故障/损坏(STORE_FAULTED/DATABASE_CORRUPT)。无法认领即无法
          // 仲裁归属,fail-closed(与 assertAuthorityAvailable/renewTimer 一致);非 custody 用内存注册表(不抛),
          // 退化为拒绝本连接。认领前尚无连接登记,故直接关闭本 socket 即可。
          let generation: number;
          try {
            generation = this.claimRegistry.claim(nodeId, this.authorityId, Date.now()).generation;
          } catch {
            if (this.opts.custody) {
              this.failClosed();
              return;
            }
            this.closeSocket(ws, 1011, 'claim unavailable');
            return;
          }
          // M2-03:同节点旧连接踢下线(新连接接管;旧 close 由守卫忽略)
          const oldConnId = this.currentConnByNode.get(nodeId);
          this.currentConnByNode.set(nodeId, connId);
          const state: ConnState = { ws, nodeId, connId, generation, ready: false, inflight: new Map() };
          this.socketsByConn.set(connId, state);
          if (oldConnId !== undefined) {
            const old = this.socketsByConn.get(oldConnId);
            this.socketsByConn.delete(oldConnId);
            if (old) {
              old.inflight.clear();
              this.closeSocket(old.ws, 4000, 'replaced');
            }
          }
          try {
            this.opts.core.connect({ connId, nodeId, teamId: node.team_id, connectedAt: Date.now(), generation });
            this.opts.onPresenceChange?.(nodeId, true, connId);
            // 回调可能同步触发管理断连或关闭;不得再确认认证成功。
            if (this.closing || this.currentConnByNode.get(nodeId) !== connId || ws.readyState !== WebSocket.OPEN) return;
            // Negotiation always precedes delivery, including offline replay.
            if (!this.safeSend(ws, {
              frame: 'auth_ok', node_id: nodeId, team_id: node.team_id,
              ...(this.opts.custody ? { transport_version: TRANSPORT_VERSION, features: CUSTODY_FEATURES } : {}),
            })) throw new Error('Authentication response failed');
            state.ready = true;
            if (this.opts.custody) {
              this.pumpCustody(state, Date.now());
            } else {
              const take = this.opts.core.takeInbox(nodeId, Date.now());
              for (const d of take.deliveries) {
                this.safeSend(ws, { frame: 'envelope', envelope: d.envelope });
              }
            }
          } catch {
            if (this.opts.custody) {
              this.failClosed();
              return;
            }
            cleanup();
            this.closeSocket(ws, 1011, 'connection failed');
          }
          return;
        }

        // ---- 已认证:上行信封 ----
        if (this.currentConnByNode.get(nodeId) !== connId) return;
        if (this.opts.custody) {
          const state = this.socketsByConn.get(connId);
          if (!state?.ready) return;
          try {
            if (isReceiptFrame(frame)) this.receiveReceipt(state, frame, Date.now());
            else if (frame.frame === 'envelope') this.admitCustody(state, frame.envelope, Date.now());
          } catch {
            // A failed DB operation must never turn into a legacy rejected ACK.
            this.failClosed();
          }
          return;
        }
        if (frame.frame !== 'envelope' || typeof frame.envelope !== 'object' || frame.envelope === null) {
          return; // 未知帧:静默(协议演进位,§8 兼容承诺)
        }
        const env = frame.envelope as EnvelopeV1;
        const chk = validateEnvelope(env);
        if (!chk.ok) {
          // M2-01:结构非法 → 结构化拒绝(已认证发送方;连接与进程不受影响)
          this.safeSend(ws, {
            frame: 'ack',
            ack_type: 'rejected',
            msg_id: typeof env.msg_id === 'string' ? env.msg_id : 'unknown',
            reason: 'bad_frame',
          });
          return;
        }
        let result;
        try {
          result = this.opts.core.uplink(nodeId, env, Date.now(), { deferOffline: this.opts.cluster !== undefined });
        } catch {
          // M2-01:兜底 —— 进程与连接必须存活
          this.safeSend(ws, { frame: 'ack', ack_type: 'rejected', msg_id: env.msg_id, reason: 'internal_error' });
          return;
        }
        for (const a of result.audits) void a;
        if (result.ack) this.safeSend(ws, { frame: 'ack', ...result.ack });
        if (result.routingDenied) this.safeSend(ws, { frame: 'routing.denied', ...result.routingDenied });
        for (const d of result.deliveries) {
          this.routeToNode(d.toNodeId, { frame: 'envelope', envelope: d.envelope });
        }
        // 集群路由(02 §12.1):本网关 miss → 直投在线成员 / home 分片入箱
        if (result.deferred) {
          // v0.8:集群 routeAsync —— in-process 成员 → 总线(跨进程)→ home 分片入箱
          void this.opts.cluster
            ?.routeAsync(result.deferred.envelope, result.deferred.toNodeId, Date.now())
            .then((outcome) => {
              if (outcome === 'unknown') {
                this.opts.core.queueInbox(env, Date.now());
              }
              this.safeSend(ws, {
                frame: 'ack',
                ack_type: outcome === 'delivered' ? 'delivered' : 'queued',
                msg_id: env.msg_id,
              });
            })
            .catch(() => {
              this.safeSend(ws, { frame: 'ack', ack_type: 'rejected', msg_id: env.msg_id, reason: 'cluster_error' });
            });
        }
      });

      ws.on('close', () => cleanup());
      ws.on('error', () => {
        cleanup();
        this.closeSocket(ws, 1011, 'error');
      });
      if (this.closing) this.closeSocket(ws, 1001, 'gateway closing');
      else if (this.unavailable) this.closeSocket(ws, 1011, 'gateway unavailable');
    });
    if (this.opts.custody) {
      // A short shared sweep avoids stretching a one-second retry to two seconds
      // when admission happens just after an interval boundary.
      this.retryTimer = setInterval(() => {
        if (this.closing || this.unavailable) return;
        try {
          this.opts.assertAuthorityAvailable?.();
          const now = Date.now();
          for (const state of this.socketsByConn.values()) this.pumpCustody(state, now);
        } catch {
          this.failClosed();
        }
      }, Math.min(this.retryIntervalMs, 100));
      this.retryTimer.unref();
    }
    // D1b:authority-liveness 续租/回收定时器(无条件——claim 在 auth/disconnect 无条件接线)。
    // 每周期:先为每个"当前连接"续租(延长 leaseExpiresAt);renew 返回 false = 已被更高 generation
    // 超越(或 claim 已失)→ fence-drop 丢弃本地僵尸连接(半开/僵死自愈,分裂脑收敛;跨进程价值在 d1c);
    // 续租后回收过期租约(reapExpired)——死亡 authority 停止续租 → 租约到期被回收,令归属可判定。
    // 节点不发任何额外帧(§8 一致):这是网关对自身持有的活 socket 的续租,非第二套节点心跳。
    this.renewTimer = setInterval(() => {
      if (this.closing || this.unavailable) return;
      try {
        const now = Date.now();
        for (const state of [...this.socketsByConn.values()]) {
          // M2-03:仅当前连接代表归属;被踢旧连接不续租(其 close 由守卫忽略)。
          if (this.currentConnByNode.get(state.nodeId) !== state.connId) continue;
          if (!this.claimRegistry.renew(state.nodeId, this.authorityId, state.generation, now)) {
            this.closeSocket(state.ws, 4000, 'superseded');
            this.disconnect(state.connId, state.nodeId);
          }
        }
        this.claimRegistry.reapExpired(now);
      } catch {
        // claim 注册表故障(如 d1c 共享 SQLite 不可用)→ 无法仲裁归属,fail-closed(与 retryTimer 一致)。
        this.failClosed();
      }
    }, this.claimRenewIntervalMs);
    this.renewTimer.unref();
  }

  private admitCustody(state: ConnState, raw: unknown, now: number): void {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return;
    const envelope = raw as EnvelopeV1;
    let digest: string;
    let valid: boolean;
    try {
      digest = envelopeDigest(envelope);
      valid = validateEnvelope(envelope).ok;
    } catch {
      this.closeSocket(state.ws, 1008, 'invalid envelope');
      return;
    }
    const identity = {
      from_node: state.nodeId,
      msg_id: typeof envelope.msg_id === 'string' ? envelope.msg_id : 'unknown',
      digest,
    };
    const nack = (reason: string): void => {
      this.safeSend(state.ws, { frame: 'nack', ...identity, reason, retry_after_ms: 1_000 });
    };
    if (!valid) {
      nack('invalid');
      return;
    }
    const verdict = this.opts.core.authorizeUplink(state.nodeId, envelope);
    if (verdict.verdict === 'silent_drop') return;
    if (verdict.verdict === 'routing_denied') {
      nack('acl_rejected');
      this.safeSend(state.ws, {
        frame: 'routing.denied', rule: verdict.rule, reason_code: verdict.reasonCode, msg_id: envelope.msg_id,
      });
      return;
    }
    const result = this.opts.custody!.offer(envelope, now);
    if (result !== 'stored') {
      nack(result);
      return;
    }
    // offer returns only after commit, for both online and offline recipients.
    this.safeSend(state.ws, { frame: 'stored', ...identity });
    const targetConn = this.currentConnByNode.get(envelope.to.node_id);
    const target = targetConn === undefined ? undefined : this.socketsByConn.get(targetConn);
    if (target) this.pumpCustody(target, now);
  }

  private pumpCustody(state: ConnState, now: number): void {
    if (this.closing || this.unavailable || !state.ready || state.ws.readyState !== WebSocket.OPEN ||
        this.currentConnByNode.get(state.nodeId) !== state.connId || state.ws.bufferedAmount >= MAX_BUFFERED_BYTES) return;
    // Peeking is bounded and never transfers custody. Expired/terminal rows drop
    // out of this snapshot; their tickets cannot be reused to acknowledge a row.
    const pending = this.opts.custody!.pending(state.nodeId, now, this.window);
    const matches = (a: { envelope: EnvelopeV1; digest: string }, b: { envelope: EnvelopeV1; digest: string }): boolean =>
      a.envelope.from.node_id === b.envelope.from.node_id && a.envelope.msg_id === b.envelope.msg_id && a.digest === b.digest;
    for (const [ticket, delivery] of state.inflight) {
      if (!pending.some((item) => matches(item, delivery))) state.inflight.delete(ticket);
    }
    for (const item of pending) {
      let entry = [...state.inflight].find(([, delivery]) => matches(delivery, item));
      if (!entry) {
        if (state.inflight.size >= this.window) break;
        const ticket = randomBytes(32).toString('hex');
        const delivery = { ...item, lastSentAt: Number.NEGATIVE_INFINITY };
        state.inflight.set(ticket, delivery);
        entry = [ticket, delivery];
      }
      const [ticket, delivery] = entry;
      if (now - delivery.lastSentAt < this.retryIntervalMs) continue;
      if (!this.safeSend(state.ws, { frame: 'delivery', envelope: delivery.envelope, digest: delivery.digest, ticket })) break;
      delivery.lastSentAt = now;
    }
  }

  private receiveReceipt(state: ConnState, frame: ReceiptFrame, now: number): void {
    if (this.currentConnByNode.get(state.nodeId) !== state.connId) return;
    const delivery = state.inflight.get(frame.ticket);
    if (!delivery || delivery.envelope.to.node_id !== state.nodeId || delivery.envelope.from.node_id !== frame.from_node ||
        delivery.envelope.msg_id !== frame.msg_id || delivery.digest !== frame.digest) return;
    if (this.opts.custody!.acknowledge(state.nodeId, frame.from_node, frame.msg_id, frame.digest, now)) {
      // Free the window only after the receiver's DB receipt has committed.
      state.inflight.delete(frame.ticket);
      this.pumpCustody(state, now);
    }
  }

  /** Stop admission and background work after authority/storage failure. */
  private failClosed(): void {
    if (this.unavailable || this.closing) return;
    this.unavailable = true;
    if (this.retryTimer) clearInterval(this.retryTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.retryTimer = undefined;
    this.syncTimer = undefined;
    this.renewTimer = undefined;
    for (const [nodeId, connId] of [...this.currentConnByNode]) this.disconnect(connId, nodeId);
    for (const ws of this.wss.clients) this.closeSocket(ws, 1011, 'gateway unavailable');
  }

  private disconnect(connId: string, nodeId: string): void {
    const state = this.socketsByConn.get(connId);
    state?.inflight.clear();
    this.socketsByConn.delete(connId);
    // M2-03:旧 close/error 不得清除新连接,同一连接最多发一次离线通知。
    if (this.currentConnByNode.get(nodeId) !== connId) return;
    this.currentConnByNode.delete(nodeId);
    this.opts.core.disconnect(nodeId);
    // D1a:释放 claim(仅当前连接经 M2-03 守卫到达此处;被 fence 的旧 generation 由 release 内部拒绝)。
    // D1c:release 属 best-effort——failClosed 路径下中心 storage 已 faulted,SqliteClaimStore.release 会抛错;
    // 连接清理与随后的 1011 关闭必须继续(陈旧 claim 由 reapExpired/TTL 或更高 generation 接管),
    // 归属仲裁层的失败绝不可破坏 fail-closed 安全路径。
    if (state) {
      try {
        this.claimRegistry.release(nodeId, this.authorityId, state.generation);
      } catch {
        // 存储故障/损坏:claim 变陈旧,由 TTL 回收或后续 claim 接管;不影响断连清理。
      }
    }
    try {
      this.opts.onPresenceChange?.(nodeId, false, connId);
    } catch {
      if (state) this.closeSocket(state.ws, 1011, 'presence failed');
    }
  }

  /** 集群成员接口(02 §12.1 连接注册):是否持有节点连接 */
  has(nodeId: string): boolean {
    return this.currentConnByNode.has(nodeId);
  }

  /** 集群成员接口:向本网关在线节点投递(返回是否确有连接) */
  deliverTo(nodeId: string, envelope: EnvelopeV1): void {
    if (this.opts.custody) throw new Error('Legacy delivery is unavailable in custody mode');
    this.routeToNode(nodeId, { frame: 'envelope', envelope });
  }

  /**
   * 集群总线中继端点(02 §12.1):已过 source 网关 ACL 的信封转投本实例。
   * 在线 → 直投(delivered);离线 project → 入本实例收件箱(queued);aid 离线 → not_here。
   */
  internalDeliver(toNodeId: string, envelope: EnvelopeV1, now: number): 'delivered' | 'queued' | 'not_here' {
    if (this.opts.custody) throw new Error('Legacy relay is unavailable in custody mode');
    this.opts.assertAuthorityAvailable?.();
    if (this.has(toNodeId)) {
      this.deliverTo(toNodeId, envelope);
      return 'delivered';
    }
    const kind = (envelope.body as { kind?: string } | undefined)?.kind;
    if (kind === 'aid') return 'not_here';
    this.opts.core.queueInbox(envelope, now);
    return 'queued';
  }

  private registerInternalRelay(): void {
    if (!this.opts.clusterSecret) return;
    const secret = this.opts.clusterSecret;
    // prepend:先于默认 426 处理器执行(独立端口形态;单端口形态走 registry http.ts 的同名路由)
    this.server.prependListener('request', (req, res) => {
      const p = (req.url ?? '').split('?')[0];
      if (p !== '/internal/envelope' || req.method !== 'POST') return;
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        if (req.headers['x-qlong-cluster-secret'] !== secret) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
        try {
          const parsed = JSON.parse(raw) as { to_node_id?: string; envelope?: EnvelopeV1 };
          if (!parsed.to_node_id || !parsed.envelope) throw new Error('bad body');
          // 信任域内仍校验结构(M2-01 同源原则):畸形信封不入收件箱、不上连接
          if (!validateEnvelope(parsed.envelope).ok) throw new Error('bad envelope');
          const result = this.internalDeliver(parsed.to_node_id, parsed.envelope as EnvelopeV1, Date.now());
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ result }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad_request' }));
        }
      });
    });
  }

  private routeToNode(nodeId: string, frame: unknown): void {
    const connId = this.currentConnByNode.get(nodeId);
    if (connId === undefined) return;
    const state = this.socketsByConn.get(connId);
    if (state) this.safeSend(state.ws, frame);
  }

  listen(port = 0, host = '127.0.0.1'): Promise<number> {
    if (this.closing) return Promise.reject(new Error('Gateway is closing'));
    if (this.pendingListen || this.server.listening) return Promise.reject(new Error('Gateway is already listening'));
    const pending = new Promise<number>((resolve, reject) => {
      const cleanup = (): void => {
        this.server.off('error', onError);
        this.server.off('listening', onListening);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onListening = (): void => {
        cleanup();
        resolve((this.server.address() as { port: number }).port);
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      try {
        this.server.listen(port, host);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
    this.pendingListen = pending;
    void pending.then(
      () => { this.pendingListen = undefined; },
      () => { this.pendingListen = undefined; },
    );
    return pending;
  }

  /** 目录同步 + 悬挂管理断连(connId 守卫版,§7.1) */
  syncRegistry(snapshot: GatewayDirectorySnapshot, statusOf: (nodeId: string) => string | undefined): void {
    this.opts.core.setDirectory(snapshot);
    for (const [nodeId, connId] of [...this.currentConnByNode]) {
      const st = statusOf(nodeId);
      if (st === 'suspended' || st === 'revoked') {
        this.opts.core.applyAdminEvent(nodeId, st);
        const state = this.socketsByConn.get(connId);
        if (state) {
          this.safeSend(state.ws, { frame: 'closing', code: st === 'suspended' ? 4001 : 4002, reason: st });
          this.closeSocket(state.ws, st === 'suspended' ? 4001 : 4002, st);
        }
        this.disconnect(connId, nodeId);
      }
    }
  }

  startRegistrySync(registry: RegistryLike, intervalMs = 50): void {
    if (this.closing || this.unavailable) return;
    if (this.syncTimer) clearInterval(this.syncTimer);
    const tick = (): void => {
      try { this.syncRegistry(registry.snapshot(), (id) => registry.getNode(id)?.status); }
      catch { this.failClosed(); }
    };
    tick();
    if (!this.unavailable) this.syncTimer = setInterval(tick, intervalMs);
  }

  private safeSend(ws: WebSocket, obj: unknown): boolean {
    try {
      if (ws.readyState !== WebSocket.OPEN) return false;
      const serialized = JSON.stringify(obj);
      if (ws.bufferedAmount + Buffer.byteLength(serialized) > MAX_BUFFERED_BYTES) return false;
      ws.send(serialized);
      return true;
    } catch {
      return false;
    }
  }

  private closeSocket(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      ws.terminate();
    }
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closing = true;
      // 先留存 Promise,回调内重入 close() 也只执行一次清理。
      this.closePromise = Promise.resolve().then(() => this.shutdown());
    }
    return this.closePromise;
  }

  private async shutdown(): Promise<void> {
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.retryTimer) clearInterval(this.retryTimer);
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.syncTimer = undefined;
    this.retryTimer = undefined;
    this.renewTimer = undefined;
    for (const [server, binding] of this.upgradeBindings) {
      server.off('upgrade', binding.listener);
    }
    this.upgradeBindings.clear();
    for (const [nodeId, connId] of [...this.currentConnByNode]) this.disconnect(connId, nodeId);
    this.socketsByConn.clear();
    this.currentConnByNode.clear();

    // 包括未认证与被替换但尚未完成 close 握手的连接,不依赖认证连接表。
    const timer = setTimeout(() => {
      for (const ws of this.wss.clients) ws.terminate();
      this.server.closeAllConnections();
    }, 1_000);
    timer.unref();
    try {
      const wsClosed = new Promise<void>((resolve) => this.wss.close(() => resolve()));
      for (const ws of this.wss.clients) this.closeSocket(ws, 1001, 'gateway closing');
      const serverClosed = (async (): Promise<void> => {
        // close() 可与尚在解析 host/绑定端口的 listen() 并发。
        await this.pendingListen?.catch(() => undefined);
        await new Promise<void>((resolve, reject) => this.server.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else resolve();
        }));
      })();
      await Promise.all([wsClosed, serverClosed]);
    } finally {
      clearTimeout(timer);
    }
  }
}