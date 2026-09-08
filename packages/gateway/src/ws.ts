/**
 * ws 适配器(M2,评审 M2-01/02/03 修订版):
 * - A3 首帧认证:认证态留存于连接闭包,认证前不处理任何业务帧(token 不进 URL,评审 I-16)
 * - 上行信封过 validateEnvelope + uplink 全程 try/catch —— 畸形帧不可能击穿进程(M2-01)
 * - 认证成功即接线收件箱补投(M2-02,评审 I-11/D24)
 * - 连接表以 connId 守卫:同节点新连接踢旧连接,旧连接的 close 不会误删新会话(M2-03)
 * - 非 active 节点连不开(M2-18);管理断连带语义 close code 4001/4002(A6)
 */
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { newId, validateEnvelope, type EnvelopeV1 } from '@qlong/core';
import type { GatewayCore } from './core.js';
import type { GatewayDirectorySnapshot } from './types.js';
import type { GatewayCluster } from './cluster.js';

export const AUTH_KEY = 'node_' + 'token';

export interface WsGatewayOptions {
  core: GatewayCore;
  /** A3:node token → 节点(注册中心 authByToken);无效或非 active = 拒绝(close 4003) */
  authenticate: (nodeToken: string) => { node_id: string; team_id: string; status: string } | undefined;
  /** 02 §12.1:集群路由(source ACL 已过,目标不在本网关时调用) */
  cluster?: GatewayCluster;
  /** 02 §12.1 总线:集群共享密钥(设置后本 server 暴露 POST /internal/envelope 中继端点) */
  clusterSecret?: string;
}

interface RegistryLike {
  snapshot(): GatewayDirectorySnapshot;
  getNode(nodeId: string): { status: string } | undefined;
}

interface ConnState {
  ws: WebSocket;
  nodeId: string;
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

  /** 单端口部署:附加挂载点路径(/gateway 等);'/' 由独立端口模式自动接管 */
  private readonly attachedPaths = new Set<string>();

  constructor(private readonly opts: WsGatewayOptions) {
    this.wss = new WebSocketServer({ noServer: true });
    // 独立端口模式:listen() 的 server 上 '/' 即网关入口
    this.bindUpgrade(this.server, '/');
    this.start();
  }

  /** 单端口部署(02 §12.1):把网关挂到业务 HTTP server 的指定路径(/gateway) */
  attach(server: import('node:http').Server, path: string): void {
    this.bindUpgrade(server, path);
  }

  private bindUpgrade(server: import('node:http').Server, path: string): void {
    this.attachedPaths.add(path);
    server.on('upgrade', (req, socket, head) => {
      const p = (req.url ?? '/').split('?')[0] ?? '';
      if (this.attachedPaths.has(p)) {
        this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
      }
    });
  }

  start(): void {
    this.registerInternalRelay();
    this.wss.on('connection', (ws) => {
      let connId: string | null = null;
      let nodeId = '';

      const cleanup = (): void => {
        if (connId === null) return;
        this.socketsByConn.delete(connId);
        // M2-03:仅当自己仍是该节点当前连接时才摘除在线态(防旧 close 误删新会话)
        if (this.currentConnByNode.get(nodeId) === connId) {
          this.currentConnByNode.delete(nodeId);
          this.opts.core.disconnect(nodeId);
        }
      };

      ws.on('message', (data) => {
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
            ws.close(4003, 'unauthorized');
            return;
          }
          const node = this.opts.authenticate(token);
          if (!node || node.status !== 'active') {
            ws.close(4003, 'unauthorized'); // M2-18:非 active 节点连不开
            return;
          }
          connId = newId();
          nodeId = node.node_id;
          // M2-03:同节点旧连接踢下线(新连接接管;旧 close 由守卫忽略)
          const oldConnId = this.currentConnByNode.get(nodeId);
          if (oldConnId !== undefined) {
            const old = this.socketsByConn.get(oldConnId);
            this.socketsByConn.delete(oldConnId);
            try {
              old?.ws.close(4000, 'replaced');
            } catch {
              /* ignore */
            }
          }
          this.currentConnByNode.set(nodeId, connId);
          this.socketsByConn.set(connId, { ws, nodeId });
          this.opts.core.connect({ connId, nodeId, teamId: node.team_id, connectedAt: Date.now() });
          // M2-02:认证成功即接线收件箱补投(离线期间排队的 project 单)
          const take = this.opts.core.takeInbox(nodeId, Date.now());
          for (const d of take.deliveries) {
            this.safeSend(ws, { frame: 'envelope', envelope: d.envelope });
          }
          this.safeSend(ws, { frame: 'auth_ok', node_id: nodeId, team_id: node.team_id });
          return;
        }

        // ---- 已认证:上行信封 ----
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
        try {
          ws.close(1011, 'error');
        } catch {
          /* already closing */
        }
      });
    });
  }

  /** 集群成员接口(02 §12.1 连接注册):是否持有节点连接 */
  has(nodeId: string): boolean {
    return this.currentConnByNode.has(nodeId);
  }

  /** 集群成员接口:向本网关在线节点投递(返回是否确有连接) */
  deliverTo(nodeId: string, envelope: EnvelopeV1): void {
    this.routeToNode(nodeId, { frame: 'envelope', envelope });
  }

  /**
   * 集群总线中继端点(02 §12.1):已过 source 网关 ACL 的信封转投本实例。
   * 在线 → 直投(delivered);离线 project → 入本实例收件箱(queued);aid 离线 → not_here。
   */
  internalDeliver(toNodeId: string, envelope: EnvelopeV1, now: number): 'delivered' | 'queued' | 'not_here' {
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
    return new Promise((resolve) => {
      this.server.listen(port, host, () => resolve((this.server.address() as { port: number }).port));
    });
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
          try {
            state.ws.close(st === 'suspended' ? 4001 : 4002, st);
          } catch {
            /* ignore */
          }
        }
        this.socketsByConn.delete(connId);
        this.currentConnByNode.delete(nodeId);
        this.opts.core.disconnect(nodeId);
      }
    }
  }

  startRegistrySync(registry: RegistryLike, intervalMs = 50): void {
    const tick = (): void => this.syncRegistry(registry.snapshot(), (id) => registry.getNode(id)?.status);
    tick();
    this.syncTimer = setInterval(tick, intervalMs);
  }

  private safeSend(ws: WebSocket, obj: unknown): void {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    } catch {
      /* 竞态忽略 */
    }
  }

  async close(): Promise<void> {
    if (this.syncTimer) clearInterval(this.syncTimer);
    for (const s of this.socketsByConn.values()) {
      try {
        s.ws.close(1001, 'gateway closing');
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    this.server.close();
  }
}