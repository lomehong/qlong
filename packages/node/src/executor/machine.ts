/**
 * 执行方状态机(01 篇 §5.2)+ 接单四道闸(03 §6:闸2 策略/闸3 能力/闸4 负载;
 * 闸1 验签在传输层,闸5 执行档案 M4)。R0 特别则/R5 僵尸防护/R6 NACK 优先。
 */
import type { AuditEvent, QlongParams } from '@qlong/core';
import { DEFAULT_PARAMS } from '@qlong/core';
import { gateCaps, gateLoad, gatePolicy, type LoadSnapshot, type LocalPolicy } from './gates.js';
import { matchCaps } from './caps.js';
import type { Outbound } from '../wire.js';

export type ExecState =
  | 'idle'
  | 'offered'
  | 'running'
  | 'result_sent'
  | 'fail_sent'
  | 'rejected'
  | 'stopped'
  | 'cleaned';

export interface ExecRecord {
  state: ExecState;
  task_id?: string;
  attempt?: number;
  from?: string;
  msg_id?: string;
  offerBody?: Record<string, unknown>;
  receivedAt?: number;
  ttlMs?: number;
  leaseConfirmedMs?: number;
  leaseSelfDeadline?: number;
  lastSeq: number;
  driverCompleted: boolean;
  cancelReceived: boolean;
  paused: boolean;
  resultBody?: Record<string, unknown>;
}

export type ExecAction =
  | { kind: 'send'; msg: Outbound }
  | { kind: 'audit'; event: AuditEvent; reason?: string }
  | { kind: 'startDriver'; task_id: string; attempt: number; offer: Record<string, unknown> }
  | { kind: 'stopDriver' }
  | { kind: 'pauseDriver' }
  | { kind: 'schedule'; timer: 'ttl' | 'lease_self' | 'heartbeat'; atMs: number }
  | { kind: 'cancelTimers'; timers: Array<'ttl' | 'lease_self' | 'heartbeat'> };

export interface ExecutorOptions {
  params?: QlongParams;
  capabilities?: () => string[];
  policy?: LocalPolicy;
  load?: () => LoadSnapshot | undefined;
}

const ALL_TIMERS: Array<'ttl' | 'lease_self' | 'heartbeat'> = ['ttl', 'lease_self', 'heartbeat'];

export class ExecutorMachine {
  rec: ExecRecord;
  readonly params: QlongParams;
  private readonly opts: ExecutorOptions;

  constructor(opts: ExecutorOptions = {}) {
    this.opts = opts;
    this.params = opts.params ?? DEFAULT_PARAMS;
    this.rec = { state: 'idle', lastSeq: 0, driverCompleted: false, cancelReceived: false, paused: false };
  }

  private out(type: string, to: string, body: Record<string, unknown>, replyTo?: string): ExecAction {
    return {
      kind: 'send',
      msg: {
        type,
        to_node: to,
        task_id: this.rec.task_id,
        attempt: this.rec.attempt,
        reply_to: replyTo,
        body,
      },
    };
  }

  private stopAllTimers(): ExecAction {
    return { kind: 'cancelTimers', timers: [...ALL_TIMERS] };
  }

  /**
   * 入站 offer(R0:更高 attempt = 隐式取消旧态;相同 attempt = 重复忽略;更低 = stale)。
   * 通过五道闸(闸1 在传输层)后接受并启动驱动。
   */
  onOffer(o: {
    from: string;
    task_id: string;
    attempt: number;
    msg_id: string;
    body: Record<string, unknown>;
    now: number;
    localTeamId?: string;
    fromTeamId?: string;
  }): ExecAction[] {
    // 已有同任务在途:R0 特别则
    if (
      (this.rec.state === 'offered' || this.rec.state === 'running') &&
      this.rec.task_id === o.task_id
    ) {
      if (o.attempt === this.rec.attempt) return []; // 重复 offer:已 accept 则忽略(R1)
      if (o.attempt < (this.rec.attempt ?? 0)) {
        return [
          this.out('task.reject', o.from, { reason_code: 'stale_attempt' }),
          { kind: 'audit', event: 'stale_attempt_rejected', reason: 'inbound attempt < local' },
        ];
      }
      // 更高 attempt:隐式取消旧态 → reject(stale_attempt)+旧态摘要 → 按新 offer 评估(R0③/I-04③)
      // 注意:先用旧态字段装配出站,再重置记录
      const staleReject: Outbound = {
        type: 'task.reject',
        to_node: o.from,
        task_id: o.task_id,
        attempt: this.rec.attempt,
        body: { reason_code: 'stale_attempt', detail: { old_attempt: this.rec.attempt, old_state: this.rec.state } },
      };
      const cleanups: ExecAction[] =
        this.rec.state === 'running' && !this.rec.driverCompleted ? [{ kind: 'stopDriver' }] : [];
      this.rec = { state: 'idle', lastSeq: 0, driverCompleted: false, cancelReceived: false, paused: false };
      return [
        ...cleanups,
        this.stopAllTimers(),
        { kind: 'send', msg: staleReject },
        { kind: 'audit', event: 'stale_attempt_rejected', reason: 'implicit cancel by higher attempt' },
        ...this.evaluateOffer(o),
      ];
    }

    const r = this.evaluateOffer(o);
    return r;
  }

  private evaluateOffer(o: {
    from: string;
    task_id: string;
    attempt: number;
    msg_id: string;
    body: Record<string, unknown>;
    now: number;
    localTeamId?: string;
    fromTeamId?: string;
  }): ExecAction[] {
    // 闸2:team 复核失败在 A6 属静默丢弃(上层);本地策略 → policy_denied
    const policy = gatePolicy(this.opts.policy, o.body);
    if (!policy.ok) {
      this.rec = { state: 'rejected', lastSeq: 0, driverCompleted: false, cancelReceived: false, paused: false };
      const rejectBody: Record<string, unknown> = { reason_code: 'policy_denied', ...(policy.detail ?? {}) };
      return [this.outFor(o, 'task.reject', rejectBody)];
    }
    // 闸3:能力
    const required = Array.isArray(o.body.required_caps) ? (o.body.required_caps as string[]) : [];
    const caps = gateCaps(required, this.opts.capabilities?.() ?? []);
    if (!caps.ok) {
      this.rec = { state: 'rejected', lastSeq: 0, driverCompleted: false, cancelReceived: false, paused: false };
      return [this.outFor(o, 'task.reject', { reason_code: 'unsupported_caps', ...(caps.detail ?? {}) })];
    }
    // 闸4:负载
    const load = gateLoad(this.opts.load?.());
    if (!load.ok) {
      this.rec = { state: 'rejected', lastSeq: 0, driverCompleted: false, cancelReceived: false, paused: false };
      return [this.outFor(o, 'task.reject', { reason_code: 'busy', ...(load.detail ?? {}) })];
    }
    // 接单:确认租约(v1 原值确认;下调为执行方策略位)
    const offeredLease = typeof o.body.lease_ms === 'number' ? o.body.lease_ms : this.params.leaseMsProject;
    this.rec = {
      state: 'running',
      task_id: o.task_id,
      attempt: o.attempt,
      from: o.from,
      msg_id: o.msg_id,
      offerBody: o.body,
      receivedAt: o.now,
      ttlMs: typeof o.body.offer_ttl_ms === 'number' ? o.body.offer_ttl_ms : undefined,
      leaseConfirmedMs: offeredLease,
      leaseSelfDeadline: o.now + offeredLease,
      lastSeq: 0,
      driverCompleted: false,
      cancelReceived: false,
      paused: false,
    };
    const hb = Math.floor(offeredLease / 3);
    return [
      this.outFor(o, 'task.accept', { lease_ms: offeredLease, started_at: new Date(o.now).toISOString() }),
      { kind: 'startDriver', task_id: o.task_id, attempt: o.attempt, offer: o.body },
      { kind: 'schedule', timer: 'heartbeat', atMs: o.now + hb },
      { kind: 'schedule', timer: 'lease_self', atMs: o.now + offeredLease },
    ];
  }

  private outFor(
    o: { from: string; task_id: string; attempt: number; msg_id: string },
    type: string,
    body: Record<string, unknown>,
  ): ExecAction {
    return {
      kind: 'send',
      msg: { type, to_node: o.from, task_id: o.task_id, attempt: o.attempt, reply_to: o.msg_id, body },
    };
  }

  /** offer_ttl 到期(R2):晚于才过期;过期必须立刻 reject(expired),禁止沉默 */
  onTtlCheck(now: number): ExecAction[] {
    if (this.rec.state !== 'offered' || this.rec.receivedAt === undefined) return [];
    const ttl = this.rec.ttlMs ?? this.params.offerTtlMsAid;
    if (now > (this.rec.receivedAt ?? 0) + ttl) {
      this.rec.state = 'rejected';
      const from = this.rec.from ?? '';
      return [this.out('task.reject', from, { reason_code: 'expired' })];
    }
    return [];
  }

  /** 心跳到期:发出 progress(seq 单调递增),续自身租约由回执驱动(R11/M3) */
  onHeartbeatDue(now: number): ExecAction[] {
    if (this.rec.state !== 'running' || this.rec.paused) return [];
    this.rec.lastSeq += 1;
    const seq = this.rec.lastSeq;
    const from = this.rec.from ?? '';
    const actions: ExecAction[] = [
      this.out('task.progress', from, { state: 'working', seq }),
      { kind: 'schedule', timer: 'heartbeat', atMs: now + Math.floor((this.rec.leaseConfirmedMs ?? this.params.leaseMsProject) / 3) },
    ];
    return actions;
  }

  /** 心跳获网关回执 → 自身租约续期(R3 执行方对称计时器) */
  onHeartbeatAcked(now: number): ExecAction[] {
    if (this.rec.state !== 'running') return [];
    this.rec.leaseSelfDeadline = now + (this.rec.leaseConfirmedMs ?? this.params.leaseMsProject);
    return [
      { kind: 'cancelTimers', timers: ['lease_self'] },
      { kind: 'schedule', timer: 'lease_self', atMs: this.rec.leaseSelfDeadline },
    ];
  }

  /** 自身租约超时:暂停产生新副作用(R3),不强求杀进程 */
  onLeaseSelfTimeout(now: number): ExecAction[] {
    if (this.rec.state !== 'running') return [];
    if ((this.rec.leaseSelfDeadline ?? 0) > now) {
      return [{ kind: 'schedule', timer: 'lease_self', atMs: this.rec.leaseSelfDeadline ?? now }];
    }
    this.rec.paused = true;
    return [{ kind: 'pauseDriver' }];
  }

  /** 驱动完成:R5 自检 —— 已收到 cancel(执行中)→ 不发 result 回 ack;否则发 result(赌赛跑窗口) */
  onDriverCompleted(resultBody: Record<string, unknown>): ExecAction[] {
    if (this.rec.state !== 'running') return [];
    this.rec.driverCompleted = true;
    this.rec.resultBody = resultBody;
    if (this.rec.cancelReceived) {
      this.rec.state = 'stopped';
      const from = this.rec.from ?? '';
      return [
        this.stopAllTimers(),
        this.out('task.cancel.ack', from, {}),
      ];
    }
    this.rec.state = 'result_sent';
    const from = this.rec.from ?? '';
    return [
      this.stopAllTimers(),
      this.out('task.result', from, { status: 'done', ...resultBody }),
    ];
  }

  /** 驱动失败:发 fail(码走 §4.3 登记表) */
  onDriverFailed(failBody: Record<string, unknown>): ExecAction[] {
    if (this.rec.state !== 'running') return [];
    this.rec.state = 'fail_sent';
    const from = this.rec.from ?? '';
    return [this.stopAllTimers(), this.out('task.fail', from, failBody)];
  }

  /** 入站 cancel(01 §5.2/R5):running → 停止+ack;已完成未交付 → result+completed_before_cancel;result_sent → ack 带标记不重发 */
  onCancel(fromNode: string, attempt: number): ExecAction[] {
    if (this.rec.state === 'running' && attempt === this.rec.attempt) {
      this.rec.cancelReceived = true;
      if (this.rec.driverCompleted) {
        // 已完成但尚未交付时收到 cancel → 仍发 result 并标 completed_before_cancel(R5)
        this.rec.state = 'result_sent';
        const result = { status: 'done', ...(this.rec.resultBody ?? {}), completed_before_cancel: true };
        return [this.stopAllTimers(), this.out('task.result', fromNode, result)];
      }
      this.rec.state = 'stopped';
      return [
        this.stopAllTimers(),
        { kind: 'stopDriver' },
        this.out('task.cancel.ack', fromNode, {}),
      ];
    }
    if (this.rec.state === 'offered' && attempt === this.rec.attempt) {
      this.rec.state = 'stopped';
      return [this.stopAllTimers(), this.out('task.cancel.ack', fromNode, {})];
    }
    if (this.rec.state === 'result_sent') {
      // R5(评审 I-39):已发 result 后收到 cancel → 回 ack 带标记,不重发 result
      return [this.out('task.cancel.ack', fromNode, { completed_before_cancel: true })];
    }
    return [];
  }

  /** 收到 reject(stale_attempt):本地记账/清理 → 终态(R0/R5) */
  onStaleReject(): ExecAction[] {
    if (this.rec.state === 'running' || this.rec.state === 'offered') {
      const actions: ExecAction[] = [];
      if (this.rec.state === 'running') actions.push({ kind: 'stopDriver' });
      this.rec.state = 'cleaned';
      return [...actions, this.stopAllTimers()];
    }
    return [];
  }
}