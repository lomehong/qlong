import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/lead/store.js';
import { LeadSupervisor } from '../src/lead/supervisor.js';
import { exportCheckpoints, importCheckpoints } from '../src/lead/takeover.js';
import { restoreLeadMachine } from '../src/lead/checkpoint.js';

/**
 * 01 §4.4 跨机接管(手动导出/导入候选)+ fence:
 * - 导入方 attempt 高水位 +1 → 原执行方迟到消息即刻 stale_attempt(R0);
 * - 本地高水位 ≥ 导入 → fence 跳过(禁双主回退);
 * - 终态归档不重跑。
 */
const T = '66666666-6666-4666-8666-666666666666';

describe('跨机接管(导出/导入 + fence)', () => {
  it('在途任务导出 → 导入 fence(attempt+1)→ 旧执行方 accept 被 R0 拒 → 新派 attempt=2', () => {
    const originStore = new MemoryStore();
    const s1 = new LeadSupervisor({ store: originStore });
    const m1 = s1.create(T, 'project');
    s1.dispatch(T, 'node-b', { kind: 'project', summary: '跨机接管演练', lease_ms: 300_000, offer_ttl_ms: 60_000 }, 0);
    s1.deliver(T, 'task.accept', 'node-b', 1, { lease_ms: 300_000 }, 0);
    expect(m1.rec.state).toBe('running');

    // —— 导出(原机停止后)——
    const bundle = exportCheckpoints(originStore, new Date(0));
    expect(bundle).toContain('requires_origin_stopped');

    // —— 新机导入 + fence ——
    const target = new MemoryStore();
    const needDispatch: Array<[string, number]> = [];
    const r = importCheckpoints(bundle, target, {
      onNeedDispatch: (taskId, nextAttempt) => needDispatch.push([taskId, nextAttempt]),
    });
    expect(r.imported).toEqual([T]);
    expect(needDispatch).toEqual([[T, 2]]); // attempt 1 → fence 到 2,重派从 3?不:重派下一发 = attempt+1?见下

    // 导入的机器:attempt 已 fence 到 2
    const m2 = restoreLeadMachine(target.load(T)!, {});
    expect(m2.rec.attempt).toBe(2);
    expect(m2.rec.state).toBe('drafting'); // 已归位待派发;fence 体现在 attempt(2 > 原 1)

    // 旧执行方的迟到 accept(attempt=1)→ R0 stale(1 < 2)
    const s2 = new LeadSupervisor({ store: target });
    s2.restoreAll();
    const actions = s2.deliver(T, 'task.accept', 'node-b', 1, { lease_ms: 300_000 }, 100);
    expect(actions.some((a) => a.kind === 'audit' && a.event === 'stale_attempt_rejected')).toBe(true);
    // 正常续跑:新 attempt 派发后 accept → running(接管完成)
    s2.redispatch(T, 'node-c', { kind: 'project', summary: '接管后续跑', lease_ms: 300_000, offer_ttl_ms: 60_000 }, 200);
    expect(s2.get(T)?.rec.attempt).toBe(3);
  });

  it('本地高水位 ≥ 导入 → fence 跳过(禁双主回退)', () => {
    const originStore = new MemoryStore();
    const s1 = new LeadSupervisor({ store: originStore });
    const m1 = s1.create(T, 'project');
    s1.dispatch(T, 'node-b', { kind: 'project', summary: 'a', lease_ms: 300_000, offer_ttl_ms: 60_000 }, 0);
    void m1;
    const bundle = exportCheckpoints(originStore);

    // 目标机本地同名任务 attempt 更高(已是 1)……导入 attempt=1 → 相等 → fence 跳过
    const target = new MemoryStore();
    const s2 = new LeadSupervisor({ store: target });
    s2.create(T, 'project');
    s2.dispatch(T, 'node-x', { kind: 'project', summary: '本地已推进', lease_ms: 300_000, offer_ttl_ms: 60_000 }, 0);
    const r = importCheckpoints(bundle, target);
    expect(r.fenced).toEqual([T]);
    expect(r.imported).toEqual([]);
  });

  it('终态任务仅归档,不接管重跑', () => {
    const originStore = new MemoryStore();
    const s1 = new LeadSupervisor({ store: originStore });
    const m = s1.create(T, 'aid');
    s1.dispatch(T, 'node-b', { kind: 'aid', summary: 's', lease_ms: 300_000, offer_ttl_ms: 60_000 }, 0);
    s1.deliver(T, 'task.accept', 'node-b', 1, { lease_ms: 300_000 }, 0);
    s1.deliver(T, 'task.result', 'node-b', 1, { status: 'done', summary: 'done' }, 0);
    expect(m.rec.state).toBe('done');
    const bundle = exportCheckpoints(originStore);
    const target = new MemoryStore();
    const r = importCheckpoints(bundle, target);
    expect(r.archived).toEqual([T]);
    expect(r.imported).toEqual([]);
    expect(target.load(T)).toBeTruthy(); // 归档保留
  });
});
