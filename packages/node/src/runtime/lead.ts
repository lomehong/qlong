/**
 * 持久牵头方(v2 durable 栈的生产半)。
 *
 * 设计取舍(B1c):牵头方的生命周期规则(R2/R3/R4/R7/R8、I-06/07/08、M1-DIST-1、D25)已由纯状态机
 * LeadTaskMachine 实现并被 lead.spec.ts 充分固化。与其在持久层重写这 400+ 行安全攸关逻辑(极易与已验证
 * 规则分叉),本类作为该纯机器的“持久适配器”:
 *   · 状态 = 机器的 LeadRecord + 单调 task_seq,持久化到 node_state(键 lead:v2:<task_id>);
 *   · 每个事件(派发/入站/定时器/取消)在事务外预先跑机器得到动作,再翻译成持久产物:
 *       send → 签名入 outbox;requestDispatch → 注入的目标选择器改派;状态净变化 → 追加 task.report 意图;
 *   · 定时器不依赖内存计时:死线(offerTtlUntil/leaseDeadline/drainUntil/cancelWaitUntil)随 LeadRecord
 *     持久化,tick(now) 依据 (状态, 死线) 派生到期定时器并驱动,重启后从持久死线续跑,绝不提前/伪造触发;
 *   · 上报意图交由 DurableTaskReporter(B1a)持久重试,createDurableNode 泵周期驱动(B1d)。
 * 故障一律 fail-closed 并回调,绝不删除现场或伪造推进。
 */
import { DEFAULT_PARAMS, envelopeDigest, isUuid, newId, type EnvelopeV1, type QlongParams } from '@qlong/core';
import { LeadTaskMachine, type LeadAction, type LeadRecord, type LeadState, type TimerName } from '../lead/machine.js';
import type { Outbound } from '../wire.js';
import { taskReportEffect } from './report.js';
import type { EffectIntent, NodeRuntimeStore, RuntimeJson, RuntimeState, RuntimeTransition } from './store.js';

const LEAD_STATE_PREFIX = 'lead:v2:';
const LEAD_STATES: readonly string[] = [
  'drafting', 'offered', 'running', 'reclaiming', 'cancelling', 'done', 'failed', 'escalated', 'closed',
];
const TERMINAL_STATES: readonly LeadState[] = ['done', 'failed', 'escalated', 'closed'];

export function leadStateKey(taskId: string): string {
  return `${LEAD_STATE_PREFIX}${taskId}`;
}

/** 持久牵头状态:机器的 LeadRecord(含死线/预算/排除/历史)叠加版本与单调上报序号。 */
export interface DurableLeadTask extends LeadRecord {
  version: 2;
  /** 已产出的上报修订计数,持久、单调,重启后原样对齐;绝不伪造。 */
  task_seq: number;
}

/**
 * 跨机牵头接管 bundle(C2a;v1 lead/takeover.ts 的持久端口,01 §4.4 / 评审 I-35)。
 * 携带每个牵头任务的持久快照(含 attempt 高水位 + task_seq),供导入方 fence 与序号续接。
 */
export interface DurableLeadTakeoverBundle {
  v: 1;
  exported_at: string;
  /** 导入前必须停止原机 qlong(操作纪律;导入侧再以 attempt 高水位兜底防双主回退)。 */
  requires_origin_stopped: true;
  tasks: Array<{ task_id: string; task: DurableLeadTask }>;
}

export interface DurableLeadImportResult {
  /** fence 后归位 drafting、待重派的在途任务(含从未派发的 attempt=0)。 */
  imported: string[];
  /** 本地 attempt 高水位 ≥ 导入 → 跳过(禁双主回退)。 */
  fenced: string[];
  /** 已是终态、仅归档不接管重跑。 */
  archived: string[];
}

export interface RedispatchRequest {
  task_id: string;
  /** 机器请求的下一轮次(= 当前 attempt + 1)。 */
  nextAttempt: number;
  /** R8 排除表快照,选择器必须避开被排除节点。 */
  excluded: Record<string, 'permanent' | 'once'>;
  kind: 'aid' | 'project';
}

/** 改派目标选择(响应 requestDispatch);返回 null 表示暂无目标,任务留在 drafting 等下次 tick 重试。 */
export type TargetSelector = (request: RedispatchRequest) => { target: string; offerBody: Record<string, unknown> } | null;

export interface DurableLeadOptions {
  store: NodeRuntimeStore;
  nodeId: string;
  teamId: string;
  params?: QlongParams;
  /** 出站签名(与执行方同一注入);事务外预先装配信封。 */
  seal: (out: Outbound) => EnvelopeV1;
  /** 改派目标选择器;缺省则 reclaim 后停留在 drafting 直至注入选择器。 */
  selectTarget?: TargetSelector;
  /** PROJECT 验收判据注入(缺省用机器默认:project 拒绝、aid 兼容 acceptance_results)。 */
  validateAcceptance?: (resultBody: Record<string, unknown>) => boolean;
  onFault?: () => void;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nonnegative(value: unknown): value is number {
  return value === 0 || positive(value);
}

/** 死线字段:缺省(未排程)或正安全整数。 */
function optionalDeadline(value: unknown): boolean {
  return value === undefined || positive(value);
}

/**
 * 校验持久牵头状态。结构字段 + 最小跨字段不变量(attempt 0 ⟺ 全新 drafting;attempt ≥1 必有 target 且
 * 已产出至少一条上报)。不约束 attempt ≥1 时可达的具体状态/死线组合,给机器的 reclaim/cancel 语义留口。
 */
function validTask(value: unknown): value is DurableLeadTask {
  if (!record(value) || value.version !== 2 || !nonnegative(value.task_seq)) return false;
  if (!isUuid(value.task_id) || !(value.kind === 'aid' || value.kind === 'project') ||
      !LEAD_STATES.includes(value.state as string) || !nonnegative(value.attempt) ||
      (value.target !== null && !isUuid(value.target)) || !positive(value.leaseMs) ||
      typeof value.acceptedThisAttempt !== 'boolean' || !nonnegative(value.acceptedFailedBudget) ||
      !nonnegative(value.dispatchRounds) || !nonnegative(value.renewalSeq) ||
      !record(value.excluded) || !Array.isArray(value.history)) return false;
  if (!optionalDeadline(value.offerTtlUntil) || !optionalDeadline(value.leaseDeadline) ||
      !optionalDeadline(value.drainUntil) || !optionalDeadline(value.cancelWaitUntil)) return false;
  if (value.drainClosed !== undefined && typeof value.drainClosed !== 'boolean') return false;
  if (value.completedBeforeCancel !== undefined && typeof value.completedBeforeCancel !== 'boolean') return false;
  for (const scope of Object.values(value.excluded)) if (scope !== 'permanent' && scope !== 'once') return false;
  if (value.attempt === 0) {
    return value.state === 'drafting' && value.target === null && value.task_seq === 0;
  }
  return value.target !== null && value.task_seq >= 1;
}

export class DurableLead {
  private readonly params: QlongParams;
  private faulted = false;

  constructor(private readonly opts: DurableLeadOptions) {
    if (opts.store.nodeId !== opts.nodeId || !opts.teamId) throw new TypeError('Invalid lead identity');
    this.params = { ...(opts.params ?? DEFAULT_PARAMS) };
    if (!positive(this.params.leaseMsAid) || !positive(this.params.leaseMsProject)) {
      throw new TypeError('Invalid lead lease parameters');
    }
  }

  private notifyFault(): void {
    try { this.opts.onFault?.(); } catch { /* Preserve original failure. */ }
  }

  private failClosed(): void {
    const first = !this.faulted;
    this.faulted = true;
    if (first) this.notifyFault();
  }

  private assertHealthy(): void {
    if (this.faulted) throw new Error('Lead faulted; explicit recovery required');
  }

  private checked<T>(action: () => T): T {
    try { return action(); } catch (error) { this.failClosed(); throw error; }
  }

  private decode(row: RuntimeState | undefined): DurableLeadTask | undefined {
    if (!row) return undefined;
    const value = row.value;
    if (!validTask(value)) throw new Error('Invalid durable lead state; explicit recovery required');
    return structuredClone(value) as unknown as DurableLeadTask;
  }

  /** 从持久状态复原一台纯机器(深拷贝,避免别名污染已持久快照)。 */
  private machine(task: DurableLeadTask): LeadTaskMachine {
    const machine = new LeadTaskMachine({
      task_id: task.task_id, kind: task.kind, params: this.params, validateAcceptance: this.opts.validateAcceptance,
    });
    machine.rec = structuredClone(task) as LeadRecord;
    machine.terminal = TERMINAL_STATES.includes(task.state);
    return machine;
  }

  /** 追加一条上报意图;task_seq 由调用方在状态净变化时自增后传入。 */
  private report(rec: LeadRecord, task_seq: number, effects: EffectIntent[]): void {
    if (!Number.isSafeInteger(task_seq)) throw new Error('Lead task_seq exhausted');
    effects.push(taskReportEffect({
      task_id: rec.task_id, team_id: this.opts.teamId, lead: this.opts.nodeId, exec: rec.target,
      attempt: rec.attempt, status: rec.state, type: rec.kind, task_seq,
    }, newId()));
  }

  /** 就地把 requestDispatch 解析成改派(可能链式);无目标则保留 drafting,由后续 tick 重试。 */
  private driveRedispatch(machine: LeadTaskMachine, actions: LeadAction[], now: number): LeadAction[] {
    const out = [...actions];
    for (let i = 0; i < out.length; i++) {
      const action = out[i];
      if (!action || action.kind !== 'requestDispatch') continue;
      const selected = this.opts.selectTarget?.({
        task_id: machine.rec.task_id, nextAttempt: action.nextAttempt,
        excluded: machine.rec.excluded, kind: machine.rec.kind,
      }) ?? null;
      if (!selected) continue;
      out.push(...machine.redispatchTo(selected.target, selected.offerBody, now));
    }
    return out;
  }

  /**
   * 在事务外跑一次机器事件,翻译成持久产物。返回待提交的值/出站/意图,以及状态是否净变化(changed)与
   * 是否有任何副作用(acted,决定是否值得提交一次修订)。
   */
  private runEvent(
    task: DurableLeadTask, runner: (machine: LeadTaskMachine) => LeadAction[], now: number,
  ): { value: DurableLeadTask; outbox: EnvelopeV1[]; effects: EffectIntent[]; changed: boolean; acted: boolean } {
    const before = task.state;
    const machine = this.machine(task);
    const actions = this.driveRedispatch(machine, runner(machine), now);
    const outbox: EnvelopeV1[] = [];
    for (const action of actions) if (action.kind === 'send') outbox.push(this.opts.seal(action.msg));
    const changed = machine.rec.state !== before;
    const task_seq = changed ? task.task_seq + 1 : task.task_seq;
    const effects: EffectIntent[] = [];
    if (changed) this.report(machine.rec, task_seq, effects);
    // 展开机器记录后覆盖 version/task_seq,避免克隆残留的旧序号盖掉新值。
    const value = { ...machine.rec, version: 2, task_seq } as unknown as DurableLeadTask;
    return { value, outbox, effects, changed, acted: changed || actions.length > 0 };
  }

  /** 依据 (状态, 持久死线) 派生当前到期定时器;镜像机器 onTimer 的状态守卫,绝不触发不匹配的定时器。 */
  private dueTimer(task: DurableLeadTask, now: number): TimerName | undefined {
    if (task.state === 'offered' && task.offerTtlUntil !== undefined && now >= task.offerTtlUntil) return 'offer_ttl';
    if (task.state === 'running' && task.leaseDeadline !== undefined && now >= task.leaseDeadline) return 'lease';
    if (task.state === 'reclaiming' && !task.drainClosed && task.drainUntil !== undefined && now >= task.drainUntil) return 'drain';
    if (task.state === 'cancelling' && task.cancelWaitUntil !== undefined && now >= task.cancelWaitUntil) return 'cancel_wait';
    return undefined;
  }

  /** drafting(attempt≥1)= 上一轮预算判定后等待改派;tick 重试选择器,拿到目标即 attempt+1 重新派发。 */
  private tryRedispatch(machine: LeadTaskMachine, now: number): LeadAction[] {
    const selected = this.opts.selectTarget?.({
      task_id: machine.rec.task_id, nextAttempt: machine.rec.attempt + 1,
      excluded: machine.rec.excluded, kind: machine.rec.kind,
    }) ?? null;
    if (!selected) return [];
    return machine.redispatchTo(selected.target, selected.offerBody, now);
  }

  snapshot(taskId: string): DurableLeadTask | null {
    return this.checked(() => this.decode(this.opts.store.state(leadStateKey(taskId))) ?? null);
  }

  /** 发起一个由本节点牵头的任务(drafting,attempt 0);幂等,已存在则不改。 */
  originate(taskId: string, kind: 'aid' | 'project'): boolean {
    return this.checked(() => {
      this.assertHealthy();
      if (!isUuid(taskId)) throw new TypeError('originate taskId must be a UUID');
      if (kind !== 'aid' && kind !== 'project') throw new TypeError('originate kind must be aid or project');
      const stateKey = leadStateKey(taskId);
      if (this.opts.store.state(stateKey)) return false;
      const machine = new LeadTaskMachine({
        task_id: taskId, kind, params: this.params, validateAcceptance: this.opts.validateAcceptance,
      });
      const value = { ...machine.rec, version: 2, task_seq: 0 } as unknown as DurableLeadTask;
      this.opts.store.transition(stateKey, 0, () => ({ state: value as unknown as RuntimeJson }));
      return true;
    });
  }

  /** 首次派发(attempt 1):装配 task.offer 并在同一事务内追加 offered 上报修订。 */
  dispatch(taskId: string, target: string, offerBody: Record<string, unknown>, now = Date.now()): boolean {
    return this.checked(() => {
      this.assertHealthy();
      if (!isUuid(taskId)) throw new TypeError('dispatch taskId must be a UUID');
      if (!isUuid(target)) throw new TypeError('dispatch target must be a UUID');
      return this.transitionEvent(taskId, (machine) => machine.dispatchTo(target, offerBody, now), now);
    });
  }

  /** 用户取消(I-06):进入 cancelling 并发 task.cancel;ack 或 cancel_wait 超时收口为 closed。 */
  cancel(taskId: string, now = Date.now()): boolean {
    return this.checked(() => {
      this.assertHealthy();
      if (!isUuid(taskId)) throw new TypeError('cancel taskId must be a UUID');
      return this.transitionEvent(taskId, (machine) => machine.cancelByUser(now), now);
    });
  }

  /** 单任务事务:读→跑事件→(有副作用则)CAS 提交;返回状态是否净变化。 */
  private transitionEvent(taskId: string, runner: (machine: LeadTaskMachine) => LeadAction[], now: number): boolean {
    const stateKey = leadStateKey(taskId);
    const row = this.opts.store.state(stateKey);
    const task = this.decode(row);
    if (!row || !task) throw new Error('Cannot operate on a task that was not originated');
    const result = this.runEvent(task, runner, now);
    if (!result.acted) return false;
    this.opts.store.transition(stateKey, row.revision, () => ({
      state: result.value as unknown as RuntimeJson, outbox: result.outbox, effects: result.effects,
    }));
    return result.changed;
  }

  /**
   * 驱动所有本节点牵头任务的持久定时器与待改派重试。由 createDurableNode 泵周期调用(B1d)。
   * 任一任务状态损坏即 fail-closed(抛出),绝不静默跳过或伪造触发。
   */
  tick(now = Date.now()): void {
    this.checked(() => {
      this.assertHealthy();
      for (const row of this.opts.store.states(LEAD_STATE_PREFIX)) {
        const task = this.decode(row);
        if (!task) continue;
        const timer = this.dueTimer(task, now);
        const runner = timer
          ? (machine: LeadTaskMachine) => machine.onTimer(timer, now)
          : task.state === 'drafting' && task.attempt >= 1
            ? (machine: LeadTaskMachine) => this.tryRedispatch(machine, now)
            : undefined;
        if (!runner) continue;
        const result = this.runEvent(task, runner, now);
        if (!result.acted) continue;
        this.opts.store.transition(row.key, row.revision, () => ({
          state: result.value as unknown as RuntimeJson, outbox: result.outbox, effects: result.effects,
        }));
      }
    });
  }

  /**
   * 导出本节点牵头的全部任务为跨机接管 bundle(含 attempt 高水位 + task_seq)。
   * 任一任务状态损坏即 fail-closed(抛出),绝不导出半损坏现场。
   */
  exportTasks(exportedAt: Date = new Date()): DurableLeadTakeoverBundle {
    return this.checked(() => {
      this.assertHealthy();
      const tasks: Array<{ task_id: string; task: DurableLeadTask }> = [];
      for (const row of this.opts.store.states(LEAD_STATE_PREFIX)) {
        const task = this.decode(row); // 损坏 → 抛出(fail-closed)
        if (task) tasks.push({ task_id: task.task_id, task });
      }
      return { v: 1, exported_at: exportedAt.toISOString(), requires_origin_stopped: true, tasks };
    });
  }

  /**
   * 导入 + fence(C2a;v1 lead/takeover.ts 的持久端口,01 §4.4 / 评审 I-35):逐任务按 attempt
   * 高水位仲裁——本地 ≥ 导入 → fenced(禁双主回退);终态 → archived(不重跑);在途 → attempt+1
   * 归位 drafting(旧执行方迟到消息即刻 R0 stale_attempt),task_seq 原样保留供序号单调续接;
   * 从未派发(attempt=0,无在途执行权)→ 原样导入待派发。损坏 bundle 或本地状态一律 fail-closed,
   * 绝不静默跳过、伪造推进或删除现场。导入不产上报:接管后首条修订由后续 tick 重派时续接 task_seq。
   */
  importTasks(bundle: DurableLeadTakeoverBundle): DurableLeadImportResult {
    return this.checked(() => {
      this.assertHealthy();
      if (!record(bundle) || bundle.v !== 1 || !Array.isArray(bundle.tasks)) {
        throw new Error('takeover: 不支持的 bundle;拒绝导入');
      }
      const result: DurableLeadImportResult = { imported: [], fenced: [], archived: [] };
      for (const entry of bundle.tasks) {
        // 严格校验入站任务(结构 + 跨字段不变量);非法即拒绝整批导入,绝不据坏数据伪造接管。
        if (!record(entry) || !validTask(entry.task)) {
          throw new Error('takeover: bundle 任务损坏或非法;拒绝导入(绝不静默跳过或伪造)');
        }
        const task = entry.task;
        const stateKey = leadStateKey(task.task_id);
        const row = this.opts.store.state(stateKey);
        if (row) {
          const local = this.decode(row); // 本地损坏 → 抛出(fail-closed)
          // fence:本地高水位 ≥ 导入 → 拒绝回退(禁双主);相等亦跳过(本地可能已续跑到更高序号)。
          if (local && local.attempt >= task.attempt) { result.fenced.push(task.task_id); continue; }
        }
        if (TERMINAL_STATES.includes(task.state)) {
          // 终态归档,接管不重跑;origin 侧上报早已投递,导入不重复产修订。
          this.opts.store.transition(stateKey, row?.revision ?? 0, () => ({ state: task as unknown as RuntimeJson }));
          result.archived.push(task.task_id);
          continue;
        }
        // 在途 fence:attempt≥1 → 高水位 +1 归位 drafting(保留 target,满足 validTask 且旧执行权即刻 stale);
        // attempt=0(从未派发,无 target)→ 原样导入,由后续 dispatch 起 attempt=1,避免越界伪造 target。
        const fenced: DurableLeadTask = task.attempt === 0
          ? task
          : { ...task, attempt: task.attempt + 1, state: 'drafting' };
        this.opts.store.transition(stateKey, row?.revision ?? 0, () => ({ state: fenced as unknown as RuntimeJson }));
        result.imported.push(task.task_id);
      }
      return result;
    });
  }

  /**
   * 消费一条指向本节点、且本节点牵头的入站信封。授权/新鲜度复核后交机器转移;无论是否转移,都原子记录
   * 收件箱判定(R1 去重 + 保管复核),与执行方 consume 同一模式。未牵头的任务在此忽略(路由交由 B1d 泵)。
   */
  consume(envelope: EnvelopeV1, authorized: boolean): void {
    this.checked(() => {
      this.assertHealthy();
      if (envelope.to.node_id !== this.opts.nodeId || !isUuid(envelope.task_id)) return;
      const stateKey = leadStateKey(envelope.task_id);
      const row = this.opts.store.state(stateKey);
      if (!row) return; // 本节点未牵头该任务
      const task = this.decode(row);
      if (!task) return; // 类型收敛:row 存在则 decode 返回任务或抛错
      const now = Date.now();
      const allowed = envelope.from.team_id === this.opts.teamId && authorized && !!envelope.sig;
      const fresh = envelope.exp !== undefined && Date.parse(envelope.exp) > now;
      let value: DurableLeadTask = task;
      const outbox: EnvelopeV1[] = [];
      const effects: EffectIntent[] = [];
      if (allowed && fresh) {
        const result = this.runEvent(
          task,
          (machine) => machine.onMessage(envelope.type, envelope.from.node_id, envelope.attempt ?? 0, envelope.body, now, envelope.msg_id),
          now,
        );
        value = result.value;
        outbox.push(...result.outbox);
        effects.push(...result.effects);
      }
      const digest = envelopeDigest(envelope);
      const output: RuntimeTransition = { state: value as unknown as RuntimeJson, outbox, effects };
      this.opts.store.consume({
        fromNode: envelope.from.node_id, msgId: envelope.msg_id, stateKey, expectedRevision: row.revision,
      }, ({ envelope: committed }) => {
        if (envelopeDigest(committed) !== digest) throw new Error('Lead custody mismatch');
        return output;
      });
    });
  }
}
