/**
 * 持久牵头方(B1b):v2 runtime 上的最小任务牵头生命周期 + 事务化投影上报的生产半。
 *
 * 这是 B1 上报的生产半——与 report.ts 的消费半(DurableTaskReporter)配对:牵头方在每次生命周期
 * 转移的同一事务内 append 一条 kind='task.report' 的持久 intent(复用 node_effects,无需 schema 迁移),
 * 提交后由泵投递到中心 /v1/teams/:id/tasks。设计对齐 executor.ts 的 v2 durable 机器约定:
 *  - 每个被牵头的任务一份持久状态(state key = lead:v2:<task_id>),revision CAS 保护;
 *  - 签名/ID 分配一律在 SQL 事务之外完成(seal 预先闭包),transform 只是数据;
 *  - task_seq 持久于状态、每次上报单调 +1,重启后原样对齐,绝不伪造或重置(CENTER-STORAGE line 47);
 *  - 入站回执经 custody 摘要复核后 consume;非目标节点/attempt 不符/未授权一律忽略,绝不推进状态;
 *  - 畸形持久状态 → 抛错并 fail-closed(损坏进入恢复而非静默重建,存储层铁律)。
 *
 * B1b 范围(最小闭环):originate(drafting)→ dispatch(task.offer + 'offered' 上报)→
 * consume 回执(accept→running、result→done、fail→failed,各产下一上报修订)。
 * 定时器/回收(reclaim)/升级(escalate)/多 attempt 改派(redispatch)与 project 验收在 B1c 补齐;
 * createDurableNode 泵接线与真实 HTTP 汇在 B1d。
 */
import { DEFAULT_PARAMS, envelopeDigest, isUuid, newId, type EnvelopeV1, type QlongParams } from '@qlong/core';
import type { LeadState } from '../lead/machine.js';
import type { Outbound } from '../wire.js';
import { taskReportEffect } from './report.js';
import type { EffectIntent, NodeRuntimeStore, RuntimeJson, RuntimeState, RuntimeTransition } from './store.js';

const LEAD_STATE_PREFIX = 'lead:v2:';
const LEAD_STATES: readonly string[] = [
  'drafting', 'offered', 'running', 'reclaiming', 'cancelling', 'done', 'failed', 'escalated', 'closed',
];

/** 每个被牵头任务的持久 state key(与执行方的单 'executor:v2' 相对,牵头方按 task_id 分片)。 */
export function leadStateKey(taskId: string): string { return `${LEAD_STATE_PREFIX}${taskId}`; }

export interface DurableLeadTask {
  version: 2;
  task_id: string;
  kind: 'aid' | 'project';
  /** 生命周期状态,与中心投影上报的 status 同源(LeadState ≡ TaskReportStatus)。 */
  state: LeadState;
  /** 0 = 已发起未派发;≥1 = 当前派发轮次(B1c 的 redispatch 递增)。 */
  attempt: number;
  /** 当前派发目标执行方节点;未派发时为 null。 */
  target: string | null;
  leaseMs: number;
  /** 已产出的上报修订计数,持久、单调,重启后原样对齐;绝不伪造。 */
  task_seq: number;
  /** 最近一次 task.offer 的 msg_id(回执关联用);未派发时为 null。 */
  offerMsgId: string | null;
}

export interface DurableLeadOptions {
  store: NodeRuntimeStore;
  nodeId: string;
  teamId: string;
  params?: QlongParams;
  /** 出站签名(与执行方同一注入);事务外预先装配信封。 */
  seal: (out: Outbound) => EnvelopeV1;
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

/**
 * 校验持久牵头状态。结构字段 + 最小跨字段不变量(attempt 0 ⟺ 全新 drafting;attempt ≥1 必有 target/
 * offerMsgId 且已产出至少一条上报)。不约束 attempt ≥1 时可达的具体状态,给 B1c 的 reclaim/cancel 留口。
 */
function validTask(value: unknown): value is DurableLeadTask {
  if (!record(value) || value.version !== 2 || !isUuid(value.task_id) ||
      !(value.kind === 'aid' || value.kind === 'project') || !LEAD_STATES.includes(value.state as string) ||
      !nonnegative(value.attempt) || (value.target !== null && !isUuid(value.target)) ||
      !positive(value.leaseMs) || !nonnegative(value.task_seq) ||
      (value.offerMsgId !== null && !isUuid(value.offerMsgId))) return false;
  if (value.attempt === 0) {
    return value.state === 'drafting' && value.target === null && value.offerMsgId === null && value.task_seq === 0;
  }
  return value.target !== null && value.offerMsgId !== null && value.task_seq >= 1;
}

/**
 * 单所有者、无内部定时器/驱动:生命周期转移皆为同步事务,异步上报投递交给 DurableTaskReporter(B1a),
 * 由 createDurableNode 泵周期驱动(B1d)。故障一律 fail-closed 并回调,绝不删除现场或伪造推进。
 */
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
    // Payloads and storage exception text never enter the callback.
    try { this.opts.onFault?.(); } catch { /* Preserve the original failure. */ }
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
    const state = row.value;
    if (!validTask(state)) throw new Error('Invalid durable lead state; explicit recovery required');
    return structuredClone(state) as unknown as DurableLeadTask;
  }

  /** Detached snapshot of one led task, or null when this node does not lead it. */
  snapshot(taskId: string): DurableLeadTask | null {
    return this.checked(() => this.decode(this.opts.store.state(leadStateKey(taskId))) ?? null);
  }

  /** task_seq 单调 +1 并 append 一条持久上报 intent;status 与当前生命周期状态同源。 */
  private report(task: DurableLeadTask, effects: EffectIntent[]): void {
    if (!Number.isSafeInteger(task.task_seq + 1)) throw new Error('Lead task_seq exhausted');
    task.task_seq += 1;
    effects.push(taskReportEffect({
      task_id: task.task_id, team_id: this.opts.teamId, lead: this.opts.nodeId, exec: task.target,
      attempt: task.attempt, status: task.state, type: task.kind, task_seq: task.task_seq,
    }, newId()));
  }

  /** 本地发起(drafting):不产上报、不出站,派发前纯本地。已存在则幂等返回 false。 */
  originate(taskId: string, kind: 'aid' | 'project'): boolean {
    return this.checked(() => {
      this.assertHealthy();
      if (!isUuid(taskId)) throw new TypeError('originate taskId must be a UUID');
      if (kind !== 'aid' && kind !== 'project') throw new TypeError('originate kind must be aid or project');
      const stateKey = leadStateKey(taskId);
      if (this.opts.store.state(stateKey)) return false;
      const task: DurableLeadTask = {
        version: 2, task_id: taskId, kind, state: 'drafting', attempt: 0, target: null,
        leaseMs: kind === 'aid' ? this.params.leaseMsAid : this.params.leaseMsProject,
        task_seq: 0, offerMsgId: null,
      };
      // ID 分配在此(事务外);transform 只是数据。
      this.opts.store.transition(stateKey, 0, () => ({ state: task as unknown as RuntimeJson }));
      return true;
    });
  }

  /** 首次派发(attempt 1):装配 task.offer 并在同一事务内 append 'offered' 上报修订。 */
  dispatch(taskId: string, target: string, offerBody: Record<string, unknown>): boolean {
    return this.checked(() => {
      this.assertHealthy();
      if (!isUuid(taskId)) throw new TypeError('dispatch taskId must be a UUID');
      if (!isUuid(target)) throw new TypeError('dispatch target must be a UUID');
      const stateKey = leadStateKey(taskId);
      const row = this.opts.store.state(stateKey);
      const task = this.decode(row);
      if (!row || !task) throw new Error('Cannot dispatch a task that was not originated');
      if (task.state !== 'drafting' || task.attempt !== 0) return false;
      task.attempt = 1;
      task.target = target;
      task.state = 'offered';
      // 签名在事务外完成;offerMsgId 绑定回执关联。
      const offer = this.opts.seal({ type: 'task.offer', to_node: target, task_id: taskId, attempt: 1, body: offerBody });
      task.offerMsgId = offer.msg_id;
      const effects: EffectIntent[] = [];
      this.report(task, effects);
      const output: RuntimeTransition = { state: task as unknown as RuntimeJson, outbox: [offer], effects };
      this.opts.store.transition(stateKey, row.revision, () => output);
      return true;
    });
  }

  /**
   * 消费一条入站执行方回执(accept/result/fail),在同一事务内推进状态并 append 上报修订。
   * custody/crypto 校验先于本调用;authorized 由收件箱泵刷新。非本节点牵头任务直接返回(路由是泵的职责)。
   */
  consume(envelope: EnvelopeV1, authorized: boolean): void {
    this.checked(() => {
      this.assertHealthy();
      if (envelope.to.node_id !== this.opts.nodeId || !isUuid(envelope.task_id)) return;
      const stateKey = leadStateKey(envelope.task_id);
      const row = this.opts.store.state(stateKey);
      if (!row) return; // 本节点未牵头该任务;是否消费交给泵的路由(B1d)。
      const task = this.decode(row);
      if (!task) return; // row 存在则 decode 返回任务或抛错;此分支仅为类型收敛。
      const outbox: EnvelopeV1[] = [];
      const effects: EffectIntent[] = [];
      const now = Date.now();
      const allowed = envelope.from.team_id === this.opts.teamId && authorized && !!envelope.sig;
      const fresh = envelope.exp !== undefined && Date.parse(envelope.exp) > now;
      if (allowed && fresh) this.receipt(task, envelope, effects);
      const digest = envelopeDigest(envelope);
      const output: RuntimeTransition = { state: task as unknown as RuntimeJson, outbox, effects };
      this.opts.store.consume({ fromNode: envelope.from.node_id, msgId: envelope.msg_id,
        stateKey, expectedRevision: row.revision }, ({ envelope: committed }) => {
        if (envelopeDigest(committed) !== digest) throw new Error('Lead custody mismatch');
        return output;
      });
    });
  }

  /** 回执状态推进(最小闭环):仅认当前 target + 当前 attempt;其余留给 B1c。 */
  private receipt(task: DurableLeadTask, envelope: EnvelopeV1, effects: EffectIntent[]): void {
    if (envelope.from.node_id !== task.target || envelope.attempt !== task.attempt) return;
    const body = envelope.body;
    if (envelope.type === 'task.accept' && task.state === 'offered') {
      if (positive(body.lease_ms)) task.leaseMs = body.lease_ms;
      task.state = 'running';
      this.report(task, effects);
    } else if (envelope.type === 'task.result' && task.state === 'running') {
      task.state = 'done';
      this.report(task, effects);
    } else if (envelope.type === 'task.fail' && task.state === 'running') {
      // B1b 最小:任何 fail 均终态化。B1c 在此插入 retryable 的 reclaim/redispatch 分支。
      task.state = 'failed';
      this.report(task, effects);
    }
    // task.progress / task.reject / task.cancel.ack:定时器、预算与回收语义在 B1c 落地。
  }
}
