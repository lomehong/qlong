/**
 * 单机总线(A2 单机版):进程内把牵头方/执行方两台状态机接起来。
 * 消息即时送达(loopback,送达即回执 = R11 per-msg ACK 的局域回环形态);
 * 定时器由确定性虚拟时钟驱动,vitest 内直接推演到任意时刻。
 * 正式传输层(M2/M3)替换 deliverTo* 的实现,状态机不动(P2 传输无关)。
 */
import type { AuditRecord, QlongParams } from '@qlong/core';
import { DEFAULT_PARAMS, defaultLeaseMs, defaultOfferTtlMs, makeAudit, newId } from '@qlong/core';
import { LeadTaskMachine, type LeadAction, type LeadTerminal, type TimerName } from '../lead/machine.js';
import { pendingTimers, restoreLeadMachine } from '../lead/checkpoint.js';
import { ExecutorMachine, type ExecAction } from '../executor/machine.js';
import { ScriptStubDriver, type DriverHost, type StubScript } from '../executor/driver.js';
import type { LocalPolicy, LoadSnapshot } from '../executor/gates.js';
import type { Outbound } from '../wire.js';

interface TimerEntry {
  owner: 'lead' | 'exec' | 'driver';
  name: string;
  at: number;
  cb: () => void;
  cancelled: boolean;
}

export interface HarnessOptions {
  taskId?: string;
  kind?: 'aid' | 'project';
  params?: QlongParams;
  script?: StubScript | StubScript[];
  capabilities?: () => string[];
  policy?: LocalPolicy;
  load?: () => LoadSnapshot | undefined;
  validateAcceptance?: (b: Record<string, unknown>) => boolean;
}

export class SingleNodeHarness {
  readonly taskId: string;
  readonly kind: 'aid' | 'project';
  readonly nodeAId: string;
  readonly nodeBId: string;
  readonly params: QlongParams;
  private readonly opts: HarnessOptions;
  lead: LeadTaskMachine;
  readonly exec: ExecutorMachine;
  readonly driver: ScriptStubDriver;
  audits: AuditRecord[] = [];
  escalateSummary?: { task_id: string; attempts: unknown[]; final_reason: string };
  terminalState?: LeadTerminal;
  heartbeatCount = 0;
  clock = 0;

  private timers: TimerEntry[] = [];
  private lastOfferBody: Record<string, unknown>;

  constructor(opts: HarnessOptions = {}) {
    this.opts = opts;
    this.params = opts.params ?? DEFAULT_PARAMS;
    this.kind = opts.kind ?? 'project';
    this.taskId = opts.taskId ?? newId();
    this.nodeAId = newId();
    this.nodeBId = newId();
    this.lead = new LeadTaskMachine({
      task_id: this.taskId,
      kind: this.kind,
      params: this.params,
      validateAcceptance: opts.validateAcceptance,
    });
    this.exec = new ExecutorMachine({
      params: this.params,
      capabilities: opts.capabilities ?? (() => ['tool:node@20']),
      policy: opts.policy,
      load: opts.load,
    });
    this.driver = new ScriptStubDriver(Array.isArray(opts.script) ? opts.script : [opts.script ?? {}]);
    this.lastOfferBody = this.defaultOfferBody();
  }

  private defaultOfferBody(): Record<string, unknown> {
    return {
      kind: this.kind,
      summary: 'stub 任务:单机总线集成',
      lease_ms: defaultLeaseMs(this.kind, this.params),
      offer_ttl_ms: defaultOfferTtlMs(this.kind, this.params),
    };
  }

  startTask(offerBody?: Record<string, unknown>): void {
    this.lastOfferBody = offerBody ?? this.defaultOfferBody();
    this.processLead(this.lead.dispatchTo(this.nodeBId, this.lastOfferBody, this.clock), this.clock);
  }

  cancelTask(): void {
    this.processLead(this.lead.cancelByUser(this.clock), this.clock);
  }

  /**
   * 同机进程重启接管:从检查点恢复牵头方,并按 pendingTimers 重挂定时器
   * (评审 M1-ARCH-1/M1-QA-5:恢复不重挂 = 接管特性不可用)。
   * 执行方/驱动不恢复 —— 重启后其工作即丢失,由牵头方租约超时 → 改派闭环兜底。
   */
  adoptRestoredLead(blob: string): void {
    this.lead = restoreLeadMachine(blob, {
      params: this.params,
      validateAcceptance: this.opts.validateAcceptance,
    });
    for (const t of pendingTimers(this.lead)) {
      const timer = t.timer as TimerName;
      this.schedule('lead', timer, t.atMs, () => this.processLead(this.lead.onTimer(timer, t.atMs), t.atMs));
    }
    if (this.lead.rec.state === 'drafting') {
      // 改派意图在崩溃中丢失 → 恢复后重新请求派发(评审 M1-QA-5)
      this.processLead(this.lead.redispatchTo(this.nodeBId, this.lastOfferBody, this.clock), this.clock);
    }
  }

  /** 推演时钟:按时间序触发全部到期定时器(含过程中新排程的) */
  advanceTo(ms: number): void {
    for (;;) {
      const due = this.timers
        .filter((t) => !t.cancelled && t.at <= ms)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.clock = Math.max(this.clock, due.at);
      due.cb();
    }
    this.clock = Math.max(this.clock, ms);
  }

  private schedule(owner: TimerEntry['owner'], name: string, at: number, cb: () => void): void {
    this.timers.push({ owner, name, at, cb, cancelled: false });
  }

  private cancelTimers(owner: TimerEntry['owner'], names: readonly string[]): void {
    for (const t of this.timers) {
      if (t.owner === owner && names.includes(t.name)) t.cancelled = true;
    }
  }

  private processLead(actions: LeadAction[], now: number): void {
    for (const a of actions) {
      switch (a.kind) {
        case 'send':
          this.deliverToExecutor(a.msg, now);
          break;
        case 'audit':
          this.audits.push(makeAudit(a.event, { node_id: this.nodeAId, reason: a.reason }, () => new Date(now).toISOString()));
          break;
        case 'requestDispatch':
          this.processLead(this.lead.redispatchTo(this.nodeBId, this.lastOfferBody, now), now);
          break;
        case 'schedule':
          this.schedule('lead', a.timer, a.atMs, () => this.processLead(this.lead.onTimer(a.timer, a.atMs), a.atMs));
          break;
        case 'cancelTimers':
          this.cancelTimers('lead', a.timers);
          break;
        case 'terminal':
          this.terminalState = a.state;
          break;
        case 'escalate':
          this.escalateSummary = a.summary;
          break;
      }
    }
  }

  private deliverToExecutor(msg: Outbound, now: number): void {
    if (msg.type === 'task.offer') {
      this.processExec(
        this.exec.onOffer({
          from: this.nodeAId,
          task_id: msg.task_id as string,
          attempt: msg.attempt as number,
          msg_id: newId(),
          body: msg.body,
          now,
          exp: new Date(now + this.params.expHorizonMs).toISOString(),
        }),
        now,
      );
    } else if (msg.type === 'task.cancel') {
      this.processExec(this.exec.onCancel(this.nodeAId, msg.attempt ?? 0), now);
    } else if (msg.type === 'task.reject') {
      this.processExec(this.exec.onStaleReject(), now);
    }
  }

  private deliverToLead(msg: Outbound, now: number): void {
    if (msg.type === 'task.progress') this.heartbeatCount += 1;
    this.processLead(
      this.lead.onMessage(msg.type, this.nodeBId, msg.attempt ?? this.lead.rec.attempt, msg.body, now),
      now,
    );
    if (msg.type === 'task.progress') {
      // loopback 立即回执(R11 per-msg ACK 的回环形态)
      this.processExec(this.exec.onHeartbeatAcked(now), now);
    }
  }

  private processExec(actions: ExecAction[], now: number): void {
    for (const a of actions) {
      switch (a.kind) {
        case 'send':
          this.deliverToLead(a.msg, now);
          break;
        case 'audit':
          this.audits.push(makeAudit(a.event, { node_id: this.nodeBId, reason: a.reason }, () => new Date(now).toISOString()));
          break;
        case 'startDriver':
          this.driver.start({ task_id: a.task_id, attempt: a.attempt, offer: a.offer }, this.driverHost());
          break;
        case 'stopDriver':
          this.driver.stop();
          break;
        case 'pauseDriver':
          this.driver.pause();
          break;
        case 'resumeDriver':
          this.driver.resume();
          break;
        case 'schedule':
          this.schedule('exec', a.timer, a.atMs, () => this.fireExecTimer(a.timer, a.atMs));
          break;
        case 'cancelTimers':
          this.cancelTimers('exec', a.timers);
          break;
      }
    }
  }

  private fireExecTimer(timer: 'ttl' | 'lease_self' | 'heartbeat', at: number): void {
    if (timer === 'heartbeat') {
      this.processExec(this.exec.onHeartbeatDue(at), at);
      this.processExec(this.exec.onHeartbeatAcked(at), at);
    } else if (timer === 'lease_self') {
      this.processExec(this.exec.onLeaseSelfTimeout(at), at);
    } else {
      this.processExec(this.exec.onTtlCheck(at), at);
    }
  }

  private driverHost(): DriverHost {
    return {
      now: () => this.clock,
      schedule: (at, cb) => {
        const entry: TimerEntry = { owner: 'driver', name: 'cb', at, cb, cancelled: false };
        this.timers.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
      complete: (b) => this.processExec(this.exec.onDriverCompleted(b), this.clock),
      fail: (b) => this.processExec(this.exec.onDriverFailed(b), this.clock),
    };
  }
}