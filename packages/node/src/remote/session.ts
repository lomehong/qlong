/**
 * 远端会话(M3,P0 修订版):状态机 × 真实网关传输。
 * 评审 M3 修订:①心跳回执续租接线(R3,blocker);②A4 入站验签缺省拒绝(P12/SEC-1);
 * ③R1 去重管线 + 执行方已决防重跑(ARCH-2);④未知 type 结构化兜底(§8)。
 */
import {
  DEFAULT_PARAMS,
  DedupStore,
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
import type { DriverHost, ExecutorDriver } from '../executor/driver.js';
import type { LocalPolicy, LoadSnapshot } from '../executor/gates.js';
import { LeadTaskMachine, type LeadAction } from '../lead/machine.js';
import { WorkspaceManager, type WorkspaceHandle } from '../collab/workspace.js';
import type { GatewayClient } from '../gateway-client.js';

export interface RemoteSessionOptions {
  nodeId: string;
  teamId: string;
  keyEpoch: number;
  priv: Uint8Array;
  client: GatewayClient;
  params?: QlongParams;
  lead?: LeadTaskMachine;
  executor?: ExecutorMachine;
  driver?: ExecutorDriver;
  /** v0.2 §8.4:传入后 startDriver 时自动创建工作区;不传则跳过 */
  workspaceManager?: WorkspaceManager;
  policy?: LocalPolicy;
  capabilities?: () => string[];
  load?: () => LoadSnapshot | undefined;
  validateAcceptance?: (b: Record<string, unknown>) => boolean;
  /** A4 闸1:入站验签(公钥按纪元查目录)。P12:未配置 = 入站全拒 */
  verifyInbound?: (env: EnvelopeV1) => Promise<boolean>;
  /** 闸5:confirm 级 requires 的本地人确认通道(缺省 = 无通道 → 一律拒绝) */
  confirmHandler?: (req: { cls: string; value: string; reason: string }, offer: Record<string, unknown>) => boolean;
  pickTarget?: (taskId: string, nextAttempt: number, excluded: Record<string, 'permanent' | 'once'>) => string | undefined;
  /** rpc.ask 应答器(01 §4.1):缺省用内置 caps.query/status.query;自定义则完全接管 */
  rpcHandler?: (q: { from: string; request_id: string; question: string; timeout_ms?: number }) => Promise<unknown> | unknown;
  onTerminal?: (taskId: string, state: string, resultBody?: Record<string, unknown>) => void;
  /** v0.2:任务状态上报到 registry(供 console Tasks 页查询) */
  taskStatusReporter?: (t: { task_id: string; type: string; team_id: string; lead: string; exec: string; attempt: number; status: string }) => void;
  onEscalate?: (summary: { task_id: string; attempts: unknown[]; final_reason: string }) => void;
  onAudit?: (a: AuditRecord) => void;
  onRoutingDenied?: (d: { rule: string; reason_code: string; msg_id: string }) => void;
}

interface OutboundSpec {
  type: string;
  to_node: string;
  task_id?: string;
  attempt?: number;
  reply_to?: string;
  body: Record<string, unknown>;
}

interface ExecContext {
  taskId: string;
  attempt: number;
  trace: TraceContext;
  offer: Record<string, unknown>;
}

export class RemoteNodeSession {
  readonly nodeId: string;
  readonly teamId: string;
  readonly opts: RemoteSessionOptions;
  lead?: LeadTaskMachine;
  exec: ExecutorMachine;
  /** A5 静默丢弃/去重丢弃 计数 */
  rejectedInbound = 0;

  private readonly params: QlongParams;
  private readonly dedup = new DedupStore(3_600_000);
  private readonly traces = new Map<string, TraceContext>();
  private readonly lastOfferBody = new Map<string, Record<string, unknown>>();
  private readonly leadTimers = new Map<string, NodeJS.Timeout>();
  private readonly execTimers = new Map<string, NodeJS.Timeout>();
  private readonly driverTimers = new Map<string, NodeJS.Timeout>();
  private readonly activeWorkspaces = new Map<string, WorkspaceHandle>();
  private lastProgressMsgId = '';
  private execCtx: ExecContext | null = null;
  /** 牵头方"节点-能力"记忆(03 §7):来源 = reject(unsupported_caps).missing 与 fail(caps_missing).missing_caps;软降权用,协议排除仍由 R8 承担 */
  private readonly capMemory = new Map<string, Set<string>>();
  /** rpc.ask 去重(重投只答一次)+ 外发问题登记(01 §4.1:按 request_id 关联应答) */
  private readonly answeredRpc = new Set<string>();
  private readonly pendingAsks = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

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
        confirmHandler: opts.confirmHandler,
      });
    // A4(评审 M3-SEC-1):入站验签缺省拒绝 —— 未配置 verifyInbound 不接收任何任务
    opts.client.verifyInbound = async (env) => {
      if (!opts.verifyInbound) return false;
      return opts.verifyInbound(env);
    };
    // R3(blocker 评审 M3-DIST-1):progress 的回执 → 执行方续租
    const prevAck = opts.client.onAck;
    // A6:routing.denied 转发(会话层可观测,评审 M3-DIST)
    const prevDenied = opts.client.onRoutingDenied;
    opts.client.onRoutingDenied = (d) => {
      this.opts.onRoutingDenied?.(d);
      prevDenied?.(d);
    };
    opts.client.onAck = (ack) => {
      this.onGatewayAck(ack);
      prevAck(ack);
    };
    opts.client.onEnvelope = (env) => this.onEnvelope(env);
  }

  private now(): number {
    return Date.now();
  }

  /** 网关回执:progress 的送达回执 → 执行方续租;其余回执交上层 */
  private onGatewayAck(ack: { msg_id: string }): void {
    if (this.lastProgressMsgId !== '' && ack.msg_id === this.lastProgressMsgId && this.execCtx) {
      this.lastProgressMsgId = '';
      const ctx = this.execCtx;
      const acts = this.exec.onHeartbeatAcked(this.now());
      this.processExec(acts, ctx);
    }
  }

  // ---------- 牵头方 ----------

  startLeadTask(taskId: string, kind: 'aid' | 'project', target: string, offerBody: Record<string, unknown>): void {
    if (this.lead && this.lead.task_id === taskId) throw new Error('session: 任务已存在 ' + taskId);
    if (!this.lead || this.lead.terminal) {
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
          void this.deliver(this.seal(a.msg, trace));
          break;
        }
        case 'audit':
          this.opts.onAudit?.(makeAudit(a.event, { node_id: this.nodeId, reason: a.reason }, () => new Date(this.now()).toISOString()));
          break;
        case 'schedule':
          this.arm(this.leadTimers, 'lead:' + a.timer, a.atMs, () => {
            const m = this.lead;
            if (m) this.processLead(m.onTimer(a.timer, Date.now()));
          });
          break;
        case 'cancelTimers':
          for (const t of a.timers) this.disarm(this.leadTimers, 'lead:' + t);
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
        this.opts.taskStatusReporter?.({ task_id: this.lead?.task_id ?? '', type: 'project', team_id: this.opts.teamId, lead: this.opts.nodeId, exec: this.lead?.rec.target ?? '', attempt: this.lead?.rec.attempt ?? 0, status: a.state });
          break;
        case 'escalate':
          this.opts.onEscalate?.(a.summary);
          break;
      }
    }
  }

  // ---------- 执行方 ----------

  private processExec(actions: ExecAction[], ctx: ExecContext): void {
    for (const a of actions) {
      switch (a.kind) {
        case 'send': {
          const env = this.seal(a.msg, ctx.trace);
          if (a.msg.type === 'task.progress') this.lastProgressMsgId = env.msg_id;
          void this.deliver(env);
          break;
        }
        case 'audit':
          this.opts.onAudit?.(makeAudit(a.event, { node_id: this.nodeId, reason: a.reason }, () => new Date(this.now()).toISOString()));
          break;
        case 'startDriver':
          this.execCtx = { taskId: ctx.taskId, attempt: ctx.attempt, trace: ctx.trace, offer: ctx.offer };
          if (this.opts.workspaceManager) {
            try {
              const wsHandle = this.opts.workspaceManager.create(ctx.taskId, ctx.offer);
              this.activeWorkspaces.set(ctx.taskId, wsHandle);
            } catch (e) {
              this.opts.onTerminal?.(ctx.taskId, 'workspace_error');
              break;
            }
          }
          this.opts.driver?.start({ task_id: a.task_id, attempt: a.attempt, offer: a.offer }, this.driverHost(a.task_id, a.attempt, ctx));
          break;
        case 'stopDriver':
          if (this.opts.workspaceManager) { this.opts.workspaceManager.destroy(ctx.taskId); this.activeWorkspaces.delete(ctx.taskId); }
          this.opts.driver?.stop();
          break;
        case 'pauseDriver':
          this.opts.driver?.pause();
          break;
        case 'resumeDriver':
          this.opts.driver?.resume();
          break;
        case 'schedule':
          this.arm(this.execTimers, 'exec:' + ctx.taskId + ':' + a.timer, a.atMs, () => {
            let acts: ExecAction[] = [];
            if (a.timer === 'heartbeat') acts = this.exec.onHeartbeatDue(Date.now());
            else if (a.timer === 'lease_self') acts = this.exec.onLeaseSelfTimeout(Date.now());
            else acts = this.exec.onTtlCheck(Date.now());
            this.processExec(acts, ctx);
          });
          break;
        case 'cancelTimers':
          for (const t of a.timers) this.disarm(this.execTimers, 'exec:' + ctx.taskId + ':' + t);
          break;
      }
    }
  }

  private driverHost(taskId: string, attempt: number, ctx: ExecContext): DriverHost {
    return {
      now: () => this.now(),
      schedule: (atMs, cb) => {
        const key = 'driver:' + taskId + ':' + atMs + ':' + newId();
        this.arm(this.driverTimers, key, atMs, cb);
        return () => this.disarm(this.driverTimers, key);
      },
      complete: (resultBody) => this.processExec(this.exec.onDriverCompleted(resultBody), ctx),
      fail: (failBody) => this.processExec(this.exec.onDriverFailed(failBody), ctx),
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
    // R1 去重管线(评审 M3-ARCH-2):补投/重放同键信封止步;progress 豁免
    if (env.type.split('.')[0] === 'task' && env.type !== 'task.progress') {
      const d = this.dedup.checkAndRecord(env.task_id ?? '', env.attempt ?? 0, env.type, env.body);
      if (d.verdict !== 'first') {
        this.rejectedInbound += 1;
        return;
      }
    }
    const fam = env.type.split('.')[0];
    if (fam !== 'task' && fam !== 'rpc') {
      // §8:未知 type → 结构化 reject(上游已完成验签与 team 复核)
      const rej = this.seal(
        { type: 'task.reject', to_node: env.from.node_id, task_id: env.task_id, attempt: env.attempt, body: { reason_code: 'unsupported_type' } },
        env.trace,
      );
      void this.deliver(rej);
      return;
    }
    const now = this.now();
    if (env.type === 'task.offer') {
      const taskId = env.task_id ?? '';
      this.traces.set('exec:' + taskId, env.trace);
      const acts = this.exec.onOffer({
        from: env.from.node_id,
        task_id: taskId,
        attempt: env.attempt ?? 0,
        msg_id: env.msg_id,
        body: env.body,
        now,
        exp: env.exp,
      });
      this.processExec(acts, { taskId, attempt: env.attempt ?? 0, trace: env.trace, offer: env.body });
      return;
    }
    if (env.type === 'task.cancel') {
      const taskId = env.task_id ?? '';
      const ctx: ExecContext = {
        taskId,
        attempt: env.attempt ?? 0,
        trace: this.traces.get('exec:' + taskId) ?? env.trace,
        offer: {},
      };
      this.processExec(this.exec.onCancel(env.from.node_id, env.attempt ?? 0), ctx);
      return;
    }
    if (env.type === 'rpc.ask') {
      this.onRpcAsk(env);
      return;
    }
    if (env.type === 'rpc.answer') {
      this.onRpcAnswer(env);
      return;
    }
    if (this.lead) {
      // 能力记忆采集(03 §7):失败回执中的缺失标签 → 节点画像,供改派候选软降权
      if (env.type === 'task.reject' && (env.body as { reason_code?: string }).reason_code === 'unsupported_caps') {
        this.recordCapMemory(env.from.node_id, (env.body as { missing?: unknown }).missing);
      } else if (env.type === 'task.fail' && (env.body as { reason_code?: string }).reason_code === 'caps_missing') {
        this.recordCapMemory(env.from.node_id, (env.body as { missing_caps?: unknown }).missing_caps);
      }
      this.processLead(this.lead.onMessage(env.type, env.from.node_id, env.attempt ?? 0, env.body, now));
    }
  }

  private recordCapMemory(nodeId: string, missing: unknown): void {
    if (!Array.isArray(missing)) return;
    const tags = missing.filter((t): t is string => typeof t === 'string');
    if (tags.length === 0) return;
    const set = this.capMemory.get(nodeId) ?? new Set<string>();
    for (const t of tags) set.add(t);
    this.capMemory.set(nodeId, set);
  }

  /** 节点 → 已观测缺失的能力标签(只增不减;快照形式,供 pickTarget 软降权参考) */
  capabilityMemory(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [k, v] of this.capMemory) out[k] = [...v];
    return out;
  }

  // ---------- rpc.*(01 §4.1:问答,轻量只读,不进状态机) ----------

  /** 问对端一个问题;以 body.request_id 关联应答(reply_to 仅辅助),timeout 兜底拒绝 */
  ask(target: string, question: string, timeoutMs = 5_000): Promise<unknown> {
    const request_id = newId();
    const p = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAsks.delete(request_id);
        reject(new Error(`rpc ask 超时(${timeoutMs}ms): ${question}`));
      }, timeoutMs);
      this.pendingAsks.set(request_id, { resolve, reject, timer });
    });
    const trace = newTraceContext(this.nodeId);
    void this.deliver(
      this.seal({ type: 'rpc.ask', to_node: target, body: { request_id, question, timeout_ms: timeoutMs } }, trace),
    );
    return p;
  }

  private async onRpcAsk(env: EnvelopeV1): Promise<void> {
    const b = env.body as { request_id?: string; question?: string; timeout_ms?: number };
    const request_id = typeof b.request_id === 'string' ? b.request_id : '';
    if (request_id === '') return; // 缺 request_id 无法关联,静默丢弃
    // 重投去重:同一 request_id 只答一次(R1 精神的 rpc 版;answer 发送由 outbox 兜底)
    if (this.answeredRpc.has(request_id)) return;
    this.answeredRpc.add(request_id);
    if (this.answeredRpc.size > 1_000) {
      const first = this.answeredRpc.values().next().value;
      if (first !== undefined) this.answeredRpc.delete(first);
    }
    const q = { from: env.from.node_id, request_id, question: b.question ?? '', timeout_ms: b.timeout_ms };
    let answer: unknown;
    try {
      answer = this.opts.rpcHandler ? await this.opts.rpcHandler(q) : this.builtinRpcAnswer(q.question);
    } catch {
      answer = { error: 'handler_error' };
    }
    void this.deliver(
      this.seal(
        { type: 'rpc.answer', to_node: env.from.node_id, reply_to: env.msg_id, body: { request_id, answer, refs: [] } },
        env.trace,
      ),
    );
  }

  /** 内置应答器:能力探询(03 §5 兜底通道)与节点状态 */
  private builtinRpcAnswer(question: string): unknown {
    if (question === 'caps.query') {
      return { caps: this.opts.capabilities?.() ?? [], load: this.opts.load?.() ?? null };
    }
    if (question === 'status.query') {
      return {
        node_id: this.nodeId,
        team_id: this.teamId,
        exec_state: this.exec.rec.state,
        lead_state: this.lead?.rec.state ?? null,
      };
    }
    return { error: 'no_handler' };
  }

  private onRpcAnswer(env: EnvelopeV1): void {
    const b = env.body as { request_id?: string; answer?: unknown };
    const request_id = typeof b.request_id === 'string' ? b.request_id : '';
    const pending = this.pendingAsks.get(request_id);
    if (!pending) return; // 迟到/未知应答:忽略
    clearTimeout(pending.timer);
    this.pendingAsks.delete(request_id);
    pending.resolve(b.answer);
  }

  // ---------- 公共 ----------

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
      ...(out.reply_to !== undefined ? { reply_to: out.reply_to } : {}),
      ...(out.task_id !== undefined ? { hops: 0, task_id: out.task_id, attempt: out.attempt ?? 1 } : {}),
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

  dispose(): void {
    for (const pool of [this.leadTimers, this.execTimers, this.driverTimers]) {
      for (const t of pool.values()) clearTimeout(t);
      pool.clear();
    }
    for (const p of this.pendingAsks.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('session disposed'));
    }
    this.pendingAsks.clear();
  }
}