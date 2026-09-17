/**
 * 持久任务上报(B1):节点 runtime 事务化上报的消费半。
 *
 * 缺口(CENTER-STORAGE.md line 47):当前节点仅在终态 best-effort 上报,中间状态、重启后的
 * revision、持久重试与 shutdown flush 待节点 runtime 事务实现。本模块把上报做成 node_effects 上的
 * 持久 intent(kind='task.report'),与 executor.run 同一套 fenced effect 机制:
 *  - 生产半(牵头方事务内 append intent)见 B1b 的 DurableLead;这里只做消费半(泵送/重试/关停 flush)。
 *  - intent 随 node_effects 落盘,跨重启存活;投递失败绝不删除,留在 pending 等下一次 flush(存储层铁律)。
 *  - 投递保持存储插入序(rowid),生产半按 task_seq 递增记录,故中心按序见到各修订;某修订被拒时只挡住
 *    该任务的后续修订,不阻塞其他任务。
 *  - 完成走 completeEffect(allowSuperseded):每个新修订都 supersede 上一上报状态;409 表示中心已处于
 *    该/更高修订(幂等或已被更新覆盖),据此完成而非无限重试。
 * 真实 HTTP 汇(/v1/teams/:id/tasks POST)与 createDurableNode 泵接线见 B1d。
 */
import { isUuid } from '@qlong/core';
import type { EffectIntent, NodeRuntimeStore, RuntimeJson } from './store.js';

/** 持久任务上报 intent 的 effect kind(B1);与 executor.run 共存于 node_effects。 */
export const TASK_REPORT_KIND = 'task.report';

/** 牵头方声明的任务生命周期状态,镜像中心投影 API 接受的 TASK_STATUSES。 */
export type TaskReportStatus =
  | 'drafting' | 'offered' | 'running' | 'reclaiming' | 'cancelling'
  | 'done' | 'failed' | 'escalated' | 'closed';

const TASK_REPORT_STATUSES: readonly string[] = [
  'drafting', 'offered', 'running', 'reclaiming', 'cancelling', 'done', 'failed', 'escalated', 'closed',
];

/** 牵头方持久上报给中心的单条任务投影修订;lead 恒为上报节点本身(中心投影为 lead 专属)。 */
export interface TaskReport {
  task_id: string;
  team_id: string;
  lead: string;
  exec: string | null;
  attempt: number;
  status: TaskReportStatus;
  type: 'aid' | 'project';
  task_seq: number;
}

export interface TaskReportSinkResult {
  /** 2xx:中心已记录该修订。 */
  ok: boolean;
  /** HTTP 状态码;0 = 传输/网络失败(无响应)。 */
  status: number;
}

/** 可注入投递汇;生产接线为 /v1/teams/:id/tasks 的 HTTP POST(见 B1d)。 */
export type TaskReportSink = (report: TaskReport) => Promise<TaskReportSinkResult>;

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nonnegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** 构造牵头方事务内 append 的持久 intent;payload 即该条投影修订的精确字段。 */
export function taskReportEffect(report: TaskReport, effectId: string): EffectIntent {
  return { id: effectId, kind: TASK_REPORT_KIND, payload: { ...report } as unknown as RuntimeJson };
}

/**
 * 投递前校验持久化的上报 payload。畸形 intent 属损坏而非瞬时失败:抛错让泵 fail-closed,
 * 绝不把垃圾 POST 给中心,也绝不静默丢弃(存储层铁律:损坏进入恢复而非静默重建)。
 */
export function parseTaskReport(payload: RuntimeJson): TaskReport {
  const body = payload as Record<string, unknown>;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload) ||
      !isUuid(body.task_id) || !nonempty(body.team_id) || !isUuid(body.lead) ||
      !(body.exec === null || isUuid(body.exec)) || !positiveInt(body.attempt) ||
      !nonnegativeInt(body.task_seq) || !TASK_REPORT_STATUSES.includes(body.status as string) ||
      !(body.type === 'aid' || body.type === 'project')) {
    throw new Error('Invalid durable task report intent; explicit recovery required');
  }
  return {
    task_id: body.task_id as string, team_id: body.team_id as string, lead: body.lead as string,
    exec: body.exec as string | null, attempt: body.attempt as number,
    status: body.status as TaskReportStatus, type: body.type as 'aid' | 'project',
    task_seq: body.task_seq as number,
  };
}

export interface DurableTaskReporterOptions {
  store: NodeRuntimeStore;
  post: TaskReportSink;
  /** 单次 flush 检视的 intent 上限;缺省用存储自身上限。 */
  limit?: number;
}

/**
 * 消费持久 task.report intent(B1 泵送半)。单所有者、无内部定时器:调用方(createDurableNode pump)
 * 周期驱动 flush(),关停时 close(deadline) 有界排空。投递失败留在 pending 等下次;绝不先完成后投递。
 */
export class DurableTaskReporter {
  constructor(private readonly opts: DurableTaskReporterOptions) {}

  /** 待投递 intent,按存储插入序(rowid)——生产半保证其等同每任务的 task_seq 序。 */
  private intents() {
    return this.opts.store.pendingEffects(this.opts.limit, true)
      .filter((effect) => effect.kind === TASK_REPORT_KIND);
  }

  /** 一趟泵送:按序投递,某任务失败即挡住其后续修订(不阻塞其他任务),返回本趟投递数与剩余待投递数。 */
  async flush(): Promise<{ delivered: number; pending: number }> {
    const blocked = new Set<string>();
    let delivered = 0;
    for (const effect of this.intents()) {
      const report = parseTaskReport(effect.payload as RuntimeJson);
      if (blocked.has(report.task_id)) continue;
      let result: TaskReportSinkResult;
      try {
        result = await this.opts.post(report);
      } catch {
        result = { ok: false, status: 0 }; // 传输异常按可重试处理,绝不伪造状态码或丢弃
      }
      if (result.ok || result.status === 409) {
        // 409 = 中心已处于该/更高修订(幂等重放或已被更新覆盖);据 task_seq 单调,完成而非重试。
        this.opts.store.completeEffect(effect.id, effect.stateKey, effect.revision, true);
        delivered += 1;
      } else {
        blocked.add(report.task_id);
      }
    }
    return { delivered, pending: this.intents().length };
  }

  /** 有界关停排空:反复 flush 直到清空或超过 deadline;超时也绝不丢弃 pending(留待下次进程)。 */
  async close(deadlineMs: number): Promise<{ delivered: number; pending: number }> {
    if (!nonnegativeInt(deadlineMs)) throw new TypeError('close deadlineMs must be a nonnegative safe integer');
    const deadline = Date.now() + deadlineMs;
    let delivered = 0;
    for (;;) {
      const pass = await this.flush();
      delivered += pass.delivered;
      if (pass.pending === 0) return { delivered, pending: 0 };
      if (Date.now() >= deadline) return { delivered, pending: pass.pending };
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
