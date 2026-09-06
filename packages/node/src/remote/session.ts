/**
 * 远端会话(M3):把牵头方/执行方状态机接到真实网关传输(P2 的另一侧兑现)。
 * 职责:Outbound 规格 → 完整信封(JCS 签名/trace 透传/exp)→ GatewayClient;
 *      入站信封 → A5 复核(防御)→ 分发到对应状态机;定时器动作 → 真实 setTimeout。
 * 单机总线(SingleNodeHarness)保留用于确定性测试;本会话是 M3 双机链路的运行形态。
 */
import {
  DEFAULT_PARAMS,
  makeAudit,
  newId,
  newTraceContext,
  signEnvelope,
  validateEnvelope,
  type AuditRecord,
  type EnvelopeV1,
  type QlongParams,
  type TraceContext,
} from '@qlong/core';
import { ExecutorMachine, type ExecAction } from '../executor/machine.js';
import type { ExecutorDriver, DriverHost } from '../executor/driver.js';
import type { LocalPolicy, LoadSnapshot } from '../executor/gates.js';
import { LeadTaskMachine, type LeadAction } from '../lead/machine.js';
import type { GatewayClient } from '../gateway-client.js';

export interface RemoteSessionOptions {
  nodeId: string;
  teamId: string;
  keyEpoch: number;
  priv: Uint8Array;
  client: GatewayClient;
  params?: QlongParams;
  /** 牵头方(可选;startLeadTask 未给时自动创建) */
  lead?: LeadTaskMachine;
  executor?: ExecutorMachine;
  /** 执行驱动(可选;无驱动 = 仅协议层联调) */
  driver?: ExecutorDriver;
  policy?: LocalPolicy;
  capabilities?: () => string[];
  load?: () => LoadSnapshot | undefined;
  validateAcceptance?: (b: Record<string, unknown>) => boolean;
  /** R7/R8:改派目标选择;返回 undefined = 暂无候选(维持 drafting) */
  pickTarget?: (taskId: string, nextAttempt: number, excluded: Record<string, 'permanent' | 'once'>) => string | undefined;
  onTerminal?: (taskId: string, state: string, resultBody?: Record<string, unknown>) => void;
  onEscalate?: (summary: { task_id: string; attempts: unknown[]; final_reason: string }) => void;
  onAudit?: (a: AuditRecord) => void;
  onRoutingDenied?: (d: { rule: string; reason_code: string; msg_id: string }) => void;
}

interface OutboundSpec {
  type: string;
  to_node: string;
  task_id?: string;
  attempt?: number;
  body: Record<string, unknown>;
}

export class RemoteNodeSession {
  readonly nodeId: string;
  readonly teamId: string;
  lead?: LeadTaskMachine;
  exec: ExecutorMachine;
  /** A5 静默丢弃计数(防御性;网关 A1 已拦,正常应为 0) */
  rejectedInbound = 0;

  private readonly params: QlongParams;
  readonly opts: RemoteSessionOptions;
  private readonly traces = new Map<string, TraceContext>();
  private readonly lastOfferBody = new Map<string, Record<string, unknown>>();
  private readonly leadTimers = new Map<string, NodeJS.Timeout>();
  private readonly execTimers = new Map<string, NodeJS.Timeout>();
  private readonly driverTimers = new Map<string, NodeJS.Timeout>();

  constructor(opts: RemoteSessionOptions) {
    this.opts = opts;
    this.nodeId = opts.nodeId;
    this.teamId = opts.teamId;
    this.params = opts.params ?? DEFAULT_PARAMS;
    this.lead = opts.lead;
    this.exec =
      opts.executor ??
      new ExecutorMachine({
        params: this.params,
        capabilities: opts.capabilities,
        policy: opts.policy,
        load: opts.load,
      });
    opts.client.onEnvelope = (env) => this.onEnvelope(env);
    const prevDenied = opts.client.onRoutingDenied?.bind(opts.client);
    opts.client.onRoutingDenied = (d) => {
      this.opts.onRoutingDenied?.(d);
      prevDenied?.(d);
    };
  }

  private now(): number {
    return Date.now();
  }

  // ---------- 牵头方 ----------

  startLeadTask(taskId: string, kind: 'aid' | 'project', target: string, offerBody: Record<string, unknown>): void {
    if (!this.lead) {
      this.lead = new LeadTaskMachine({
        task_id: taskId,
        kind,
        params: this.params,
        validateAcceptance: this.opts.validateAcceptance,
      });
    }
    this.traces.set(taskId, newTraceContext(this.nodeId));
    this.lastOfferBody.set(taskId, offerBody);
    this.processLead(this.lead.dispatchTo(target, offerBody, this.now()));
  }

  redispatchLead(taskId: string, target: string): void {
    const body = this.lastOfferBody.get(taskId);
    if (!body || !this.lead) return;
    this.processLead(this.lead.redispatchTo(target, body, this.now()));
  }

  cancelLead(taskId: string): void {
    if (this.lead?.task_id === taskId) this.processLead(this.lead.cancelByUser(this.now()));
  }

  private processLead(actions: LeadAction[]): void {
    for (const a of actions) {
      switch (a.kind) {
        case 'send': {
          const trace = this.traces.get(a.msg.task_id ?? '') ?? newTraceContext(this.nodeId);
          this.traces.set(a.msg.task_id ?? '', trace);
          console.log('[exec send]', a.msg.type, '→', a.msg.to_node, 'task', a.msg.task_id);
          void this.deliver(this.seal(a.msg, trace)).catch((e) => console.log('[exec send error]', String(e)));
          break;
        }
        case 'audit':
          this.opts.onAudit?.(makeAudit(a.event, { node_id: this.nodeId, reason: a.reason }, () => new Date(this.now()).toISOString()));
          break;
        case 'schedule':
          this.arm(this.leadTimers, `lead:${a.timer}`, a.atMs, () => {
            const m = this.lead;
            if (m) this.processLead(m.onTimer(a.timer, Date.now()));
          });
          break;
        case 'cancelTimers':
          for (const t of a.timers) this.disarm(this.leadTimers, `lead:${t}`);
          break;
        case 'requestDispatch': {
          const m = this.lead;
          if (!m) break;
          const target = this.opts.pickTarget?.(m.task_id, a.nextAttempt, m.rec.excluded);
          if (target !== undefined) this.redispatchLead(m.task_id, target);
          break;
        }
        case 'terminal':
          this.opts.onTerminal?.(this.lead?.task_id ?? '', a.state, this.lead?.rec.resultBody);
          break;
        case 'escalate':
          this.opts.onEscalate?.(a.summary);
          break;
      }
    }
  }

  // ---------- 执行方 ----------

  private processExec(actions: ExecAction[], trace: TraceContext, offer: Record<string, unknown>, taskId: string, attempt: number): void {
    for (const a of actions) {
      switch (a.kind) {
        case 'send': {
          const env = this.seal({ type: a.msg.type, to_node: a.msg.to_node, task_id: a.msg.task_id, attempt: a.msg.attempt, body: a.msg.body }, trace);
          void this.deliver(env);
          break;
        }
        case 'audit':
          this.opts.onAudit?.(makeAudit(a.event, { node_id: this.nodeId, reason: a.reason }, () => new Date(this.now()).toISOString()));
          break;
        case 'startDriver':
          this.opts.driver?.start({ task_id: a.task_id, attempt: a.attempt, offer: a.offer }, this.driverHost(taskId, attempt, trace, offer));
          break;
        case 'stopDriver':
          this.opts.driver?.stop();
          break;
        case 'pauseDriver':
          this.opts.driver?.pause();
          break;
        case 'resumeDriver':
          this.opts.driver?.resume();
          break;
        case 'schedule':
          this.arm(this.execTimers, `exec:${taskId}:${a.timer}`, a.atMs, () => {
            const acts = (() => {
              if (a.timer === 'heartbeat') return this.exec.onHeartbeatDue(Date.now());
              if (a.timer === 'lease_self') return this.exec.onLeaseSelfTimeout(Date.now());
              return this.exec.onTtlCheck(Date.now());
            })();
            this.processExec(acts, trace, offer, taskId, attempt);
          });
          break;
        case 'cancelTimers':
          for (const t of a.timers) this.disarm(this.execTimers, `exec:${taskId}:${t}`);
          break;
      }
    }
  }

  private driverHost(taskId: string, attempt: number, trace: TraceContext, offer: Record<string, unknown>): DriverHost {
    return {
      now: () => this.now(),
      schedule: (atMs, cb) => {
        const key = `driver:${taskId}:${atMs}:${newId()}`;
        this.arm(this.driverTimers, key, atMs, cb);
        return () => this.disarm(this.driverTimers, key);
      },
      complete: (resultBody) => {
        const acts = this.exec.onDriverCompleted(resultBody);
        this.processExec(acts, trace, offer, taskId, attempt);
      },
      fail: (failBody) => {
        const acts = this.exec.onDriverFailed(failBody);
        this.processExec(acts, trace, offer, taskId, attempt);
      },
    };
  }

  // ---------- 入站 ----------

  onEnvelope(env: EnvelopeV1): void {
    // A5 防御(to 不符 / 跨队):静默丢弃(网关 A1 已拦,这里兜底)
    if (env.to.node_id !== this.nodeId) {
      this.rejectedInbound += 1;
      return;
    }
    if (env.from.team_id !== undefined && env.from.team_id !== this.teamId) {
      this.rejectedInbound += 1;
      return;
    }
    const now = this.now();
    if (env.type === 'task.offer') {
      const taskId = env.task_id ?? '';
      this.traces.set(`exec:${taskId}`, env.trace);
      const acts = this.exec.onOffer({
        from: env.from.node_id,
        task_id: taskId,
        attempt: env.attempt ?? 0,
        msg_id: env.msg_id,
        body: env.body,
        now,
        exp: env.exp,
      });
      this.processExec(acts, env.trace, env.body, taskId, env.attempt ?? 0);
      return;
    }
    if (env.type === 'task.cancel') {
      const taskId = env.task_id ?? '';
      const trace = this.traces.get(`exec:${taskId}`) ?? env.trace;
      this.processExec(this.exec.onCancel(env.from.node_id, env.attempt ?? 0), trace, env.body, taskId, env.attempt ?? 0);
      return;
    }
    if (this.lead) {
      this.processLead(this.lead.onMessage(env.type, env.from.node_id, env.attempt ?? 0, env.body, now));
    }
  }

  // ---------- 公共 ----------

  /** 信封封装 + 签名(签名域之外全字段校验;签名必在) */
  private seal(out: OutboundSpec, trace: TraceContext): EnvelopeV1 {
    const base = {
      v: 1,
      type: out.type,
      msg_id: newId(),
      ts: new Date(this.now()).toISOString(),
      exp: new Date(this.now() + this.params.expHorizonMs).toISOString(),
      from: { node_id: this.nodeId, team_id: this.teamId, key_epoch: this.opts.keyEpoch },
      to: { node_id: out.to_node, team_id: this.teamId },
      trace,
      ...(out.task_id !== undefined
        ? { hops: 0, task_id: out.task_id, attempt: out.attempt ?? 1 }
        : {}),
      body: out.body,
    };
    const chk = validateEnvelope(base as EnvelopeV1, this.params, { allowMissingSig: true });
    if (!chk.ok) throw new Error('出站信封校验失败:' + chk.errors.join(';'));
    return signEnvelope(chk.value, this.opts.priv);
  }

  private async deliver(env: EnvelopeV1): Promise<void> {
    try {
      await this.opts.client.send(env, { ackTimeoutMs: 2_000 });
    } catch {
      /* outbox 保留,R11 重发兜底 */
    }
  }

  private arm(pool: Map<string, NodeJS.Timeout>, key: string, atMs: number, cb: () => void): void {
    this.disarm(pool, key);
    const delay = Math.max(0, atMs - this.now());
    const t = setTimeout(() => {
      pool.delete(key);
      cb();
    }, delay);
    pool.set(key, t);
  }

  private disarm(pool: Map<string, NodeJS.Timeout>, key: string): void {
    const t = pool.get(key);
    if (t) {
      clearTimeout(t);
      pool.delete(key);
    }
  }

  /** 优雅停机:清全部定时器(连接由 client.close 负责) */
  dispose(): void {
    for (const pool of [this.leadTimers, this.execTimers, this.driverTimers]) {
      for (const t of pool.values()) clearTimeout(t);
      pool.clear();
    }
  }
}