/**
 * 网关核心(01 §9 / 02 §7/§8):连接表、上行 ACL 引擎、离线收件箱、回执帧、管理断连。
 * 目录快照带 epoch(§7.1):逐节点缓存条目携带 epoch,落后即重查 —— 换队/吊销后旧归属立即失效。
 * 传输(ws)是边缘适配器;本核心不感知 socket,便于假连接做确定性断言。
 */
import type { AuditRecord, EnvelopeV1, QlongParams } from '@qlong/core';
import { DEFAULT_PARAMS, isExpiredByExp, makeAudit } from '@qlong/core';
import { evaluateUplink, type DirectoryLookup } from './acl.js';
import { InboxStore } from './mailbox.js';
import type { GatewayAck, GatewayConnection, GatewayDirectorySnapshot, RoutingDenied } from './types.js';

export interface GatewayCoreOptions {
  params?: QlongParams;
  inboxCapacity?: number;
  /** 注入收件箱(支持落盘持久化:InboxStore({persistFile}));缺省内存实例 */
  inbox?: InboxStore<EnvelopeV1>;
}

export interface UplinkDeferred {
  toNodeId: string;
  envelope: EnvelopeV1;
}

export interface UplinkResult {
  /** 回执帧:发往发送方(诊断/改派触发;不参与可靠性)。A0/过期 = 无回执(A6 静默) */
  ack?: GatewayAck;
  /** 集群模式(deferOffline):目标不在本网关 —— 交由集群路由(02 §12.1) */
  deferred?: UplinkDeferred;
  routingDenied?: RoutingDenied;
  audits: AuditRecord[];
  /** 在线投递(目标已连接) */
  deliveries: Array<{ toNodeId: string; envelope: EnvelopeV1 }>;
  /** 入收件箱(离线 project 类) */
  queued: Array<{ toNodeId: string; envelope: EnvelopeV1 }>;
}

export interface AdminClose {
  nodeId: string;
  code: 4001 | 4002;
  status: 'suspended' | 'revoked';
}

export interface TakeInboxResult<E extends EnvelopeV1> {
  deliveries: Array<{ toNodeId: string; envelope: E }>;
  audits: AuditRecord[];
}

export class GatewayCore {
  readonly connections = new Map<string, GatewayConnection>();
  readonly inbox: InboxStore<EnvelopeV1>;
  private directory: GatewayDirectorySnapshot = { epoch: 0, nodes: [] };
  /** 逐节点目录缓存:条目携带快照 epoch,落后即重查(§7.1) */
  private dirCache = new Map<string, { epoch: number; entry?: import('./types.js').GatewayDirectoryEntry }>();
  private readonly params: QlongParams;
  grantLookup: ((from: string, to: string) => boolean) | undefined = undefined;

  constructor(opts: GatewayCoreOptions = {}) {
    this.params = opts.params ?? DEFAULT_PARAMS;
    this.inbox = opts.inbox ?? new InboxStore<EnvelopeV1>(opts.inboxCapacity ?? 200);
  }

  /** 订阅目录快照(注册中心推送,§7.1);epoch 单调才接受 */
  setDirectory(snapshot: GatewayDirectorySnapshot): void {
    if (snapshot.epoch < this.directory.epoch) return;
    this.directory = snapshot;
    this.dirCache.clear();
  }

  get directoryEpoch(): number {
    return this.directory.epoch;
  }

  private lookup(nodeId: string): import('./types.js').GatewayDirectoryEntry | undefined {
    const cached = this.dirCache.get(nodeId);
    if (cached && cached.epoch === this.directory.epoch) return cached.entry;
    const entry = this.directory.nodes.find((n) => n.node_id === nodeId);
    this.dirCache.set(nodeId, { epoch: this.directory.epoch, entry });
    return entry;
  }

  /** A3 之后调用:连接入表,presence 置真(02 §8 在线权威) */
  connect(conn: GatewayConnection): void {
    this.connections.set(conn.nodeId, conn);
  }

  disconnect(nodeId: string): void {
    this.connections.delete(nodeId);
  }

  /** 注册中心管理事件:suspend/revoke → 语义 close code 主动断连(A6,评审 I-14) */
  applyAdminEvent(nodeId: string, status: 'suspended' | 'revoked'): AdminClose[] {
    const conn = this.connections.get(nodeId);
    this.connections.delete(nodeId);
    if (!conn) return [];
    return [{ nodeId, code: status === 'suspended' ? 4001 : 4002, status }];
  }

  /**
   * 上行信封:ACL(A0/A1/A2)→ 在线投递 / 离线暂存(aid 不暂存,评审 I-11)/ 拒绝。
   * A0 与过期 = A6 静默(无回执);A1/A2 = 回执 rejected + routing.denied(仅发往发送方本人)。
   */
  uplink(fromNodeId: string, envelope: EnvelopeV1, now: number, opts?: { deferOffline?: boolean }): UplinkResult {
    const audits: AuditRecord[] = [];
    const result: UplinkResult = { audits, deliveries: [], queued: [] };

    // D24:exp 过期 → 静默丢弃 + 审计(A6 未认证/伪造类,无回声)
    if (envelope.exp !== undefined && isExpiredByExp(envelope.exp, now)) {
      audits.push(makeAudit('exp_rejected', { node_id: fromNodeId, envelope, reason: 'exp + 漂移预算已过' }, () => new Date(now).toISOString()));
      return result;
    }

    const conn = this.connections.get(fromNodeId);
    if (!conn) {
      // 无连接 = 未认证(A3 上游已失守的防御分支):静默
      audits.push(makeAudit('acl_rejected_from_pin', { node_id: fromNodeId, envelope, reason: '无认证连接' }, () => new Date(now).toISOString()));
      return result;
    }

    const head = {
      msg_id: envelope.msg_id,
      type: envelope.type,
      from: envelope.from,
      to: envelope.to,
      exp: envelope.exp,
      body: envelope.body,
      envelope,
    };
    const verdict = evaluateUplink({
      conn,
      head,
      dir: { snapshotEpoch: this.directory.epoch, lookup: (id) => this.lookup(id), grantLookup: this.grantLookup },
    });

    if (verdict.verdict === 'silent_drop') {
      audits.push(makeAudit(verdict.auditEvent, { node_id: fromNodeId, envelope, reason: verdict.reason }, () => new Date(now).toISOString()));
      return result; // A6:静默,无回执
    }
    if (verdict.verdict === 'routing_denied') {
      audits.push(makeAudit(verdict.auditEvent, { node_id: fromNodeId, envelope, reason: verdict.reason }, () => new Date(now).toISOString()));
      const ack: GatewayAck = { ack_type: 'rejected', msg_id: envelope.msg_id, reason: 'acl_rejected' };
      const routingDenied: RoutingDenied = {
        rule: verdict.rule,
        reason_code: verdict.reasonCode,
        msg_id: envelope.msg_id,
      };
      return { ...result, ack, routingDenied };
    }

    // 路由
    const toNodeId = envelope.to.node_id;
    if (this.connections.has(toNodeId)) {
      result.deliveries.push({ toNodeId, envelope });
      result.ack = { ack_type: 'delivered', msg_id: envelope.msg_id };
      return result;
    }

    // 集群(02 §12.1):deferOffline 时本网关不落箱,交由上层集群路由
    // —— 直投到他网关在线节点,或入 home 分片网关收件箱
    if (opts?.deferOffline) {
      return { ...result, deferred: { toNodeId, envelope } };
    }

    // 离线:aid 不暂存(01 §9/评审 I-11);project 暂存
    const kind = envelope.body.kind;
    if (kind === 'aid') {
      result.ack = { ack_type: 'rejected', msg_id: envelope.msg_id, reason: 'offline_not_stored' };
      return result;
    }
    this.inbox.offer(toNodeId, envelope, now);
    result.queued.push({ toNodeId, envelope });
    result.ack = { ack_type: 'queued', msg_id: envelope.msg_id };
    return result;
  }

  /** 集群/管理:直接入收件箱(home 分片网关落箱用) */
  queueInbox(envelope: EnvelopeV1, now: number): void {
    this.inbox.offer(envelope.to.node_id, envelope, now);
  }

  /** 集群:本网关是否持有该节点连接 */
  isConnected(nodeId: string): boolean {
    return this.connections.has(nodeId);
  }

  /** 重连补投(02 §8):返回到期可投条目;过期剔除 + 审计 exp_rejected */
  takeInbox(nodeId: string, now: number): TakeInboxResult<EnvelopeV1> {
    const { deliver, droppedExpired } = this.inbox.drain(nodeId, (e) =>
      e.exp !== undefined ? isExpiredByExp(e.exp, now) : false,
    );
    const audits = droppedExpired.map((e) =>
      makeAudit('exp_rejected', { node_id: nodeId, envelope: e.envelope, reason: '补投时已过期' }, () => new Date(now).toISOString()),
    );
    return {
      deliveries: deliver.map((e) => ({ toNodeId: nodeId, envelope: e.envelope })),
      audits,
    };
  }
}