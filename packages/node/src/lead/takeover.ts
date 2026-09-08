/**
 * 跨机 leader 接管(01 §4.4 开放问题的最小兑现:检查点导出/导入候选)。
 *
 * 设计依据(评审 I-35 定案):
 * - 检查点自带 attempt 高水位与在途 (task_id, attempt, 执行方) 清单;
 * - 接管方必须将所有在途任务 attempt 提到高水位之上再重派(fence);
 * - 旧 lead 让位:手动导出/导入流程要求原机 qlong 先行停止(操作纪律,导入侧再以
 *   attempt 高水位兜底——同 task 本地 attempt ≥ 导入 attempt 时跳过,禁止双主回退)。
 * 自动选举(谁有权触发、免人工)仍属开放问题,不在本层。
 */
import type { CheckpointStore } from './store.js';
import { restoreLeadMachine, type RestoreOptions } from './checkpoint.js';
import { LeadTaskMachine } from './machine.js';

export interface TakeoverBundle {
  v: 1;
  exported_at: string;
  /** 导入前必须停止原机 qlong(操作纪律;attempt 高水位兜底防双主) */
  requires_origin_stopped: true;
  checkpoints: Array<{ task_id: string; blob: string }>;
}

export interface ImportResult {
  imported: string[];
  /** 因本地 attempt 高水位更高/相等而被 fence 跳过的任务 */
  fenced: string[];
  /** 已是终态、仅归档不接管 */
  archived: string[];
}

function machineOf(blob: string, opts: RestoreOptions): LeadTaskMachine {
  return restoreLeadMachine(blob, opts);
}

/** 导出:把存储内全部检查点打包为可迁移文件(含 attempt 高水位与在途信息,来自 rec) */
export function exportCheckpoints(store: CheckpointStore, exportedAt?: Date): string {
  const bundle: TakeoverBundle = {
    v: 1,
    exported_at: (exportedAt ?? new Date()).toISOString(),
    requires_origin_stopped: true,
    checkpoints: store.list().map((taskId) => ({ task_id: taskId, blob: store.load(taskId) ?? '' })),
  };
  return JSON.stringify(bundle, null, 2);
}

/**
 * 导入 + fence:恢复机器;非终态任务 attempt +1(高于原在途执行权,R0 立刻拒绝
 * 旧执行方的迟到消息),并由宿主经 onNeedDispatch 重派(接管后先归位再续跑)。
 */
export function importCheckpoints(
  bundleJson: string,
  target: CheckpointStore,
  opts: RestoreOptions & {
    /** fence 后需要重派的任务回调(接管方接手派单) */
    onNeedDispatch?: (taskId: string, nextAttempt: number) => void;
  } = {},
): ImportResult {
  const bundle = JSON.parse(bundleJson) as TakeoverBundle;
  if (bundle.v !== 1) throw new Error(`takeover: 不支持的 bundle 版本 ${bundle.v}`);
  const result: ImportResult = { imported: [], fenced: [], archived: [] };

  for (const cp of bundle.checkpoints) {
    if (!cp.blob) continue;
    const incoming = machineOf(cp.blob, opts);
    const localBlob = target.load(cp.task_id);
    if (localBlob !== undefined) {
      const local = machineOf(localBlob, opts);
      // fence:本地高水位 ≥ 导入 → 拒绝回退(禁双主)
      if (local.rec.attempt >= incoming.rec.attempt) {
        result.fenced.push(cp.task_id);
        continue;
      }
    }
    if (incoming.terminal) {
      target.save(cp.task_id, cp.blob); // 终态归档,接管不重跑
      result.archived.push(cp.task_id);
      continue;
    }
    // fence:在途任务 attempt 高水位 +1 —— 原执行方的任何迟到消息即刻 stale_attempt(R0);
    // 状态归位 drafting(待派发),由接管方重派(旧执行方若已完成,迟到 result 亦被 R0 拒收)
    incoming.rec.attempt += 1;
    incoming.rec.state = 'drafting';
    const fencedBlob = JSON.stringify({
      v: 1,
      task_id: incoming.task_id,
      kind: incoming.rec.kind,
      terminal: incoming.terminal,
      rec: incoming.rec,
    });
    target.save(cp.task_id, fencedBlob);
    result.imported.push(cp.task_id);
    // fence 后的重派 attempt = fence 值(redispatchTo 内部再递增)
    opts.onNeedDispatch?.(incoming.task_id, incoming.rec.attempt);
  }
  return result;
}

/** 把导入的检查点恢复为可操作的机器对象(接管方宿主用) */
export function restoreFromBundle(bundleJson: string, taskId: string, opts: RestoreOptions = {}): LeadTaskMachine {
  const bundle = JSON.parse(bundleJson) as TakeoverBundle;
  const cp = bundle.checkpoints.find((c) => c.task_id === taskId);
  if (!cp) throw new Error(`takeover: bundle 中无任务 ${taskId}`);
  return machineOf(cp.blob, opts);
}
