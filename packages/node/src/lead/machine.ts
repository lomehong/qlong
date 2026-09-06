/**
 * 牵头方状态机(01 篇 §5.1,每个 task_id 一份)。
 * 纯转移逻辑:入站=消息/定时器/指令,出站=动作(发消息规格/审计/排程/终态/改派请求)。
 * 时间一律绝对 ms(由调用方注入 now),定时器通过 schedule 动作交给上层调度。
 * 依据:R0/R2/R3/R4/R5/R6/R7/R8/D25;终态优先级 done > closed > failed > escalated。
 */
import type { AuditEvent, FailCode, QlongParams } from '@qlong/core';
import { DEFAULT_PARAMS, defaultOfferTtlMs, lostAfterMs } from '@qlong/core';
import type { Outbound } from '../wire.js';

export type LeadState =
  | 'drafting'
  | 'offered'
  | 'running'
  | 'reclaiming'
  | 'cancelling'
  | 'done'
  | 'failed'
  | 'escalated'
  | 'closed';

export type LeadTerminal = Extract<LeadState, 'done' | 'failed' | 'escalated' | 'closed'>;

export interface LeadHistoryEntry {
  node: string;
  attempt: number;
  outcome: 'offered' | 'accepted' | 'rejected' | 'expired' | 'lost' | 'fail_retryable' | 'fail_fatal' | 'acceptance_failed' | 'result_delivered';
  reason_code?: string;
}

export interface LeadRecord {
  task_id: string;
  kind: 'aid' | 'project';
  leaseMs: number;
  state: LeadState;
  attempt: number;
  target: string | null;
  acceptedThisAttempt: boolean;
  /** R7:已 accept 之后失败的改派预算 */
  acceptedFailedBudget: number;
  /** R7:未被接受过的改派轮次预算 */
  dispatchRounds: number;
  /** R8:节点排除(持久=本 task 生命周期;once=瞬时失败排除一次) */
  excluded: Record<string, 'permanent' | 'once'>;
  history: LeadHistoryEntry[];
  offerTtlUntil?: number;
  leaseDeadline?: number;
  drainUntil?: number;
  drainClosed?: boolean;
  cancelWaitUntil?: number;
  /** 已发出而未收口的撤销(竞态:reclaiming 收 result → done) */
  completedBeforeCancel?: boolean;
  resultBody?: Record<string, unknown>;
  cancelReason?: 'user' | 'reclaim' | 'acceptance_failed' | 'project_aborted';
}

export type TimerName = 'offer_ttl' | 'lease' | 'drain' | 'cancel_wait';

export type LeadAction =
  | { kind: 'send'; msg: Outbound }
  | { kind: 'audit'; event: AuditEvent; reason?: string }
  | { kind: 'requestDispatch'; nextAttempt: number }
  | { kind: 'schedule'; timer: TimerName; atMs: number }
  | { kind: 'cancelTimers'; timers: TimerName[] }
  | { kind: 'terminal'; state: LeadTerminal }
  | { kind: 'escalate'; summary: { task_id: string; attempts: LeadHistoryEntry[]; final_reason: string } };

export interface LeadInit {
  task_id: string;
  kind: 'aid' | 'project';
  params?: QlongParams;
  /** 验收判据(评审 I-24):contract.acceptance 的机器可检部分;缺省=通过(v1 aid 常态) */
  validateAcceptance?: (resultBody: Record<string, unknown>) => boolean;
}

const ACTIVE_TIMERS: TimerName[] = ['offer_ttl', 'lease', 'drain', 'cancel_wait'];

export class LeadTaskMachine {
  readonly task_id: string;
  rec: LeadRecord;
  readonly params: QlongParams;
  terminal = false;
  private readonly validateAcceptance: (resultBody: Record<string, unknown>) => boolean;

  constructor(init: LeadInit) {
    this.task_id = init.task_id;
    this.params = init.params ?? DEFAULT_PARAMS;
    this.validateAcceptance =
      init.validateAcceptance ?? ((b) => {
        const arr = b.acceptance_results;
        if (!Array.isArray(arr)) return true;
        return arr.every((x) => (x as { pass?: boolean } | null)?.pass !== false);
      });
    this.rec = {
      task_id: init.task_id,
      kind: init.kind,
      leaseMs: init.kind === 'aid' ? this.params.leaseMsAid : this.params.leaseMsProject,
      state: 'drafting',
      attempt: 0,
      target: null,
      acceptedThisAttempt: false,
      acceptedFailedBudget: 0,
      dispatchRounds: 0,
      excluded: {},
      history: [],
    };
  }

  private out(type: string, to: string, body: Record<string, unknown>, replyTo?: string): LeadAction {
    return {
      kind: 'send',
      msg: { type, to_node: to, task_id: this.task_id, attempt: this.rec.attempt, reply_to: replyTo, body },
    };
  }

  private stopTimers(): LeadAction {
    return { kind: 'cancelTimers', timers: [...ACTIVE_TIMERS] };
  }

  private finish(state: LeadTerminal): LeadAction[] {
    this.terminal = true;
    this.rec.state = state;
    return [this.stopTimers(), { kind: 'terminal', state }];
  }

  /** 初始派发(attempt=1)或对 requestDispatch 的应答(attempt+1)。R4:撤销已在进入本调用前完成。 */
  dispatchTo(target: string, offerBody: Record<string, unknown>, now: number): LeadAction[] {
    if (this.terminal) return [];
    if (this.rec.state !== 'drafting') return []; // 初始派发仅限 drafting;改派走 redispatchTo
    this.rec.attempt = 1;
    this.rec.target = target;
    this.rec.acceptedThisAttempt = false;
    this.rec.state = 'offered';
    const ttl = typeof offerBody.offer_ttl_ms === 'number' ? offerBody.offer_ttl_ms : defaultOfferTtlMs(this.rec.kind, this.params);
    this.rec.offerTtlUntil = now + ttl;
    delete this.rec.drainUntil;
    delete this.rec.drainClosed;
    return [
      this.stopTimers(),
      this.out('task.offer', target, offerBody),
      { kind: 'schedule', timer: 'offer_ttl', atMs: this.rec.offerTtlUntil },
    ];
  }

  /** 对 requestDispatch 的应答:attempt+1 重新派发(R4 撤销已完成) */
  redispatchTo(target: string, offerBody: Record<string, unknown>, now: number): LeadAction[] {
    if (this.terminal || this.rec.state !== 'drafting') return [];
    this.rec.attempt += 1;
    this.rec.target = target;
    this.rec.acceptedThisAttempt = false;
    this.rec.state = 'offered';
    const ttl =
      typeof offerBody.offer_ttl_ms === 'number'
        ? offerBody.offer_ttl_ms
        : defaultOfferTtlMs(this.rec.kind, this.params);
    this.rec.offerTtlUntil = now + ttl;
    delete this.rec.drainUntil;
    delete this.rec.drainClosed;
    return [
      this.stopTimers(),
      this.out('task.offer', target, offerBody),
      { kind: 'schedule', timer: 'offer_ttl', atMs: this.rec.offerTtlUntil },
    ];
  }
  /** 入站 task.*(attempt 已对齐本记录;attempt 不符的先行处置见 onForeignAttempt) */
  onMessage(type: string, fromNode: string, attempt: number, body: Record<string, unknown>, now: number): LeadAction[] {
    if (this.terminal) return [];
    // R0:attempt 不符
    if (attempt !== this.rec.attempt) {
      if (attempt < this.rec.attempt) {
        return [
          this.out('task.reject', fromNode, { reason_code: 'stale_attempt' }),
          { kind: 'audit', event: 'stale_attempt_rejected', reason: `inbound attempt ${attempt} < current ${this.rec.attempt}` },
        ];
      }
      return [{ kind: 'audit', event: 'stale_attempt_rejected', reason: `inbound attempt ${attempt} > current` }];
    }

    switch (this.rec.state) {
      case 'offered':
        return this.onOfferedMessage(type, fromNode, body, now);
      case 'running':
        return this.onRunningMessage(type, fromNode, body, now);
      case 'reclaiming':
        return this.onReclaimingMessage(type, body, now);
      case 'cancelling':
        return this.onCancellingMessage(type, body);
      default:
        return [];
    }
  }

  private onOfferedMessage(type: string, fromNode: string, body: Record<string, unknown>, now: number): LeadAction[] {
    if (type === 'task.accept' && fromNode === this.rec.target) {
      this.rec.acceptedThisAttempt = true;
      this.rec.state = 'running';
      const lease = typeof body.lease_ms === 'number' ? body.lease_ms : this.rec.leaseMs;
      this.rec.leaseMs = lease;
      this.rec.leaseDeadline = now + lostAfterMs(lease, this.params);
      this.rec.history.push({ node: fromNode, attempt: this.rec.attempt, outcome: 'accepted' });
      return [
        this.stopTimers(),
        { kind: 'schedule', timer: 'lease', atMs: this.rec.leaseDeadline },
      ];
    }
    if (type === 'task.reject' && fromNode === this.rec.target) {
      const { code } = normalizeFailCodeOrReject(body.reason_code);
      this.rec.history.push({ node: fromNode, attempt: this.rec.attempt, outcome: 'rejected', reason_code: code });
      this.applyExclusion(code, body);
      // reject 不在 R4 先撤销清单内(节点明确拒绝,无在途执行)→ 直接预算判定
      return this.budgetOrEscalate(now, false);
    }
    return [];
  }

  private onRunningMessage(type: string, fromNode: string, body: Record<string, unknown>, now: number): LeadAction[] {
    if (fromNode !== this.rec.target) return [];
    if (type === 'task.progress') {
      // 心跳即续租(R3);progress 不驱动状态机,seq/乱序由去重层与展示层处理
      this.rec.leaseDeadline = now + lostAfterMs(this.rec.leaseMs, this.params);
      return [{ kind: 'schedule', timer: 'lease', atMs: this.rec.leaseDeadline }];
    }
    if (type === 'task.result') {
      this.rec.resultBody = body;
      if (this.validateAcceptance(body)) {
        this.rec.history.push({ node: fromNode, attempt: this.rec.attempt, outcome: 'result_delivered' });
        return this.finish('done');
      }
      // 验收失败归途(D25/I-24):cancel(acceptance_failed) → 改派
      return this.beginReclaim('acceptance_failed', now, {
        node: fromNode,
        attempt: this.rec.attempt,
        outcome: 'acceptance_failed',
      });
    }
    if (type === 'task.fail') {
      const { code } = normalizeFailCodeOrReject(body.reason_code);
      const retryable = body.retryable !== false;
      if (!retryable) {
        this.rec.history.push({ node: fromNode, attempt: this.rec.attempt, outcome: 'fail_fatal', reason_code: code });
        return this.finish('failed');
      }
      return this.beginReclaim('reclaim', now, {
        node: fromNode,
        attempt: this.rec.attempt,
        outcome: 'fail_retryable',
        reason_code: code,
      });
    }
    if (type === 'task.cancel.ack') {
      // I-07:cancel.ack 仅在 cancelling/reclaiming 有语义;running 收到 → 忽略(日志层可记)
      return [];
    }
    return [];
  }

  private onReclaimingMessage(type: string, body: Record<string, unknown>, now: number): LeadAction[] {
    if (this.rec.drainClosed) return [];
    if (type === 'task.result') {
      // R4 赛跑窗口:reclaiming 收 result → done(I-06)
      this.rec.resultBody = body;
      this.rec.history.push({ node: this.rec.target ?? '?', attempt: this.rec.attempt, outcome: 'result_delivered' });
      return this.finish('done');
    }
    if (type === 'task.fail') {
      const { code } = normalizeFailCodeOrReject(body.reason_code);
      if (body.retryable === false) {
        // R4:窗口内收到 retryable=false 的 fail → 不改派,直接 failed
        this.rec.history.push({ node: this.rec.target ?? '?', attempt: this.rec.attempt, outcome: 'fail_fatal', reason_code: code });
        return this.finish('failed');
      }
      this.rec.history.push({ node: this.rec.target ?? '?', attempt: this.rec.attempt, outcome: 'fail_retryable', reason_code: code });
      return [];
    }
    if (type === 'task.cancel.ack') {
      // R4:首个 cancel.ack 提前收口(评审 I-39)
      this.rec.drainClosed = true;
      return this.budgetOrEscalate(now, this.rec.acceptedThisAttempt);
    }
    return [];
  }

  private onCancellingMessage(type: string, body: Record<string, unknown>): LeadAction[] {
    if (type === 'task.result') {
      this.rec.resultBody = body;
      this.rec.history.push({ node: this.rec.target ?? '?', attempt: this.rec.attempt, outcome: 'result_delivered' });
      return this.finish('done');
    }
    if (type === 'task.fail') {
      return this.finish('closed');
    }
    if (type === 'task.cancel.ack') {
      return this.finish('closed');
    }
    return [];
  }

  onTimer(timer: TimerName, now: number): LeadAction[] {
    if (this.terminal) return [];
    if (timer === 'offer_ttl' && this.rec.state === 'offered') {
      // R2/R4:expired 也先撤销、后改派(评审 I-08)
      this.rec.history.push({ node: this.rec.target ?? '?', attempt: this.rec.attempt, outcome: 'expired' });
      return this.beginReclaim('reclaim', now);
    }
    if (timer === 'lease' && this.rec.state === 'running') {
      // R3 判 lost → reclaim(R4)
      this.rec.history.push({ node: this.rec.target ?? '?', attempt: this.rec.attempt, outcome: 'lost' });
      const actions = this.beginReclaim('reclaim', now);
      return [{ kind: 'audit', event: 'reclaim', reason: 'lease lost' }, ...actions];
    }
    if (timer === 'drain' && this.rec.state === 'reclaiming' && !this.rec.drainClosed) {
      this.rec.drainClosed = true;
      return this.budgetOrEscalate(now, this.rec.acceptedThisAttempt);
    }
    if (timer === 'cancel_wait' && this.rec.state === 'cancelling') {
      // I-06:cancelling 出口超时 → 强制 closed
      return this.finish('closed');
    }
    return [];
  }

  cancelByUser(now: number): LeadAction[] {
    if (this.terminal) return [];
    if (this.rec.state === 'cancelling') return [];
    this.rec.cancelReason = 'user';
    const target = this.rec.target;
    const sendCancel: LeadAction[] = target
      ? [this.out('task.cancel', target, { reason: 'user' })]
      : [];
    this.rec.cancelWaitUntil = now + this.params.cancelWaitMs;
    this.rec.state = 'cancelling';
    return [
      this.stopTimers(),
      ...sendCancel,
      { kind: 'schedule', timer: 'cancel_wait', atMs: this.rec.cancelWaitUntil },
    ];
  }

  /** R4:一切回收路径统一 先撤销、后改派 */
  private beginReclaim(
    reason: 'reclaim' | 'acceptance_failed',
    now: number,
    historyEntry?: LeadHistoryEntry,
  ): LeadAction[] {
    if (historyEntry) this.rec.history.push(historyEntry);
    this.rec.state = 'reclaiming';
    this.rec.drainClosed = false;
    this.rec.drainUntil = now + this.params.drainMs;
    const cancelBody: Record<string, unknown> = { reason };
    const target = this.rec.target;
    return [
      this.stopTimers(),
      ...(target ? [this.out('task.cancel', target, cancelBody)] : []),
      { kind: 'audit', event: 'reclaim', reason },
      { kind: 'schedule', timer: 'drain', atMs: this.rec.drainUntil },
    ];
  }

  /** R7:双预算(已接受失败 / 未接受改派轮次);耗尽 → escalate(结构化事件,§11) */
  private budgetOrEscalate(_now: number, acceptedThisAttempt: boolean): LeadAction[] {
    if (acceptedThisAttempt) this.rec.acceptedFailedBudget += 1;
    else this.rec.dispatchRounds += 1;
    const exhausted =
      this.rec.acceptedFailedBudget >= this.params.maxAttempts ||
      this.rec.dispatchRounds >= this.params.maxDispatchRounds;
    if (exhausted) {
      const summary = {
        task_id: this.task_id,
        attempts: [...this.rec.history],
        final_reason: acceptedThisAttempt
          ? `accepted-failure budget exhausted (${this.rec.acceptedFailedBudget}/${this.params.maxAttempts})`
          : `dispatch-round budget exhausted (${this.rec.dispatchRounds}/${this.params.maxDispatchRounds})`,
      };
      this.terminal = true;
      this.rec.state = 'escalated';
      return [
        this.stopTimers(),
        { kind: 'audit', event: 'escalate', reason: summary.final_reason },
        { kind: 'escalate', summary },
        { kind: 'terminal', state: 'escalated' },
      ];
    }
    // 等待 supervisor 提供下一目标(redispatchTo);期间不接收任何消息语义
    this.rec.state = 'drafting';
    return [{ kind: 'requestDispatch', nextAttempt: this.rec.attempt + 1 }];
  }

  /** R8:按失败性质区分排除 */
  private applyExclusion(code: FailCode | 'other' | string, body: Record<string, unknown>): void {
    if (!this.rec.target) return;
    const persistent = code === 'unsupported_caps' || code === 'policy_denied' || code === 'refused_loop';
    if (persistent) {
      this.rec.excluded[this.rec.target] = 'permanent';
      return;
    }
    if (code === 'busy' && typeof body.retry_after_ms === 'number') return; // 带 retry_after 不排除(R8)
    if (code === 'busy') return; // busy 本身不排除,由 retry_after/本地策略决定重试时机
    this.rec.excluded[this.rec.target] = 'once';
  }
}

/** reject/fail 码均走各自登记表归一(未知码按 other,不报错) */
function normalizeFailCodeOrReject(raw: unknown): { code: string } {
  return { code: typeof raw === 'string' ? raw : 'other' };
}
