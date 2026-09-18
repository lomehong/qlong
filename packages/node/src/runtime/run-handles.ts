/**
 * PersistentRunHandleStore:RunHandleStore 的持久实现(C1c),以 NodeRuntimeStore 的
 * node_state 单键背书,使 FencedProcessDriver 的 fence→pid+启动证据跨进程重启存活。
 *
 * 单键即可:DurableExecutor 单 slot,任一时刻至多一个活 run;record upsert、clear 置
 * null 墓碑(node_state 无删除面,单键复用不增行)。驱动在 SQL 事务外调用 start/stop/
 * recover(见 executor.ts),故这里的 transition 自开短事务,与执行器事务无重入。
 *
 * 铁律:损坏/异形值 → load 返回 undefined → 驱动 recover 判 'unknown'(fail-closed),
 * 绝不据坏数据伪造静默证明——误判静默会让执行器错误 settle 一个可能仍在跑的 run。
 */
import type { PersistedRunHandle, RunFence, RunHandleStore } from '../driver/run-handle.js';
import type { NodeRuntimeStore, RuntimeJson } from './store.js';

/** node_state 中持久 run 句柄的单键(与 executor:v2 / lead 键前缀隔离)。 */
export const RUN_HANDLE_KEY = 'runhandle:v2';

function safeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function sameFence(a: Readonly<RunFence>, b: Readonly<RunFence>): boolean {
  return a.task_id === b.task_id && a.attempt === b.attempt &&
    a.generation === b.generation && a.run_id === b.run_id;
}

/** node_state 只保证合法 JSON,不保证本 schema;异形/损坏 → undefined(fail-closed)。 */
function decode(value: RuntimeJson): PersistedRunHandle | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const fence = value.fence;
  if (typeof fence !== 'object' || fence === null || Array.isArray(fence)) return undefined;
  const { task_id, run_id, attempt, generation } = fence;
  const { pid, startedAt } = value;
  if (typeof task_id !== 'string' || typeof run_id !== 'string') return undefined;
  if (!safeInt(attempt) || !safeInt(generation)) return undefined;
  if (!safeInt(pid) || pid <= 0) return undefined;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return undefined;
  return { fence: { task_id, attempt, generation, run_id }, pid, startedAt };
}

export class PersistentRunHandleStore implements RunHandleStore {
  constructor(private readonly store: NodeRuntimeStore) {}

  record(handle: PersistedRunHandle): void {
    const revision = this.store.state(RUN_HANDLE_KEY)?.revision ?? 0;
    const value: RuntimeJson = {
      fence: {
        task_id: handle.fence.task_id, attempt: handle.fence.attempt,
        generation: handle.fence.generation, run_id: handle.fence.run_id,
      },
      pid: handle.pid,
      startedAt: handle.startedAt,
    };
    this.store.transition(RUN_HANDLE_KEY, revision, () => ({ state: value }));
  }

  load(fence: Readonly<RunFence>): PersistedRunHandle | undefined {
    const state = this.store.state(RUN_HANDLE_KEY);
    if (!state) return undefined;
    const handle = decode(state.value);
    return handle && sameFence(handle.fence, fence) ? handle : undefined;
  }

  clear(fence: Readonly<RunFence>): void {
    const state = this.store.state(RUN_HANDLE_KEY);
    if (!state) return;
    const handle = decode(state.value);
    // 仅当现存句柄属于该精确 fence 才清墓碑,绝不覆盖更新 run 的句柄。
    if (!handle || !sameFence(handle.fence, fence)) return;
    this.store.transition(RUN_HANDLE_KEY, state.revision, () => ({ state: null }));
  }
}
