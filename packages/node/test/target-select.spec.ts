import { describe, expect, it } from 'vitest';
import { createTargetSelector, type DirectoryNode } from '../src/runtime/target-select.js';

/**
 * 默认改派目标选择器:目录快照驱动(同步选择 + 后台刷新)。
 * 过滤面:非本机 / active / R8 排除表 / required_caps ⊆ node.caps(core matchCaps 单一实现)。
 */
const SELF = '22222222-2222-4222-8222-222222222222';
const A = '33333333-3333-4333-8333-333333333333';
const B = '44444444-4444-4444-8444-444444444444';

const dir: DirectoryNode[] = [
  { node_id: SELF, status: 'active', caps: ['tool:ios'] },
  { node_id: A, status: 'active', caps: ['tool:ios-sign', 'os:mac'] },
  { node_id: B, status: 'suspended', caps: ['tool:ios-sign'] },
];

const template = { summary: '打包', required_caps: ['tool:ios-sign'], lease_ms: 60_000 };

function make(over: Partial<Parameters<typeof createTargetSelector>[0]> = {}, snapshot: DirectoryNode[] = dir) {
  const handle = createTargetSelector({
    selfNodeId: SELF, fetchDirectory: async () => snapshot, offerTemplate: template, ...over,
  });
  return handle.refresh().then(() => handle);
}

describe('默认 TargetSelector(目录快照 + caps 过滤 + 排除表)', () => {
  it('按 caps 过滤并避开本机与非 active;offer 模板保留且 kind 由请求覆盖', async () => {
    const h = await make({ strategy: 'first' });
    const pick = h.selector({ task_id: crypto.randomUUID(), nextAttempt: 1, excluded: {}, kind: 'aid' });
    expect(pick).not.toBeNull();
    expect(pick!.target).toBe(A);
    expect(pick!.offerBody).toMatchObject({ summary: '打包', required_caps: ['tool:ios-sign'], kind: 'aid' });
  });

  it('R8 排除表:被排除节点被避开;全员排除/快照为空 → null(留 drafting 等 tick 重试)', async () => {
    const h = await make({ strategy: 'first' });
    const req = (excluded: Record<string, 'permanent' | 'once'>) => ({
      task_id: crypto.randomUUID(), nextAttempt: 2, excluded, kind: 'aid' as const,
    });
    expect(h.selector(req({ [A]: 'once' }))).toBeNull(); // B suspended、SELF 是自己 → 无候选
    const empty = await make({ strategy: 'first' }, []);
    expect(empty.selector(req({}))).toBeNull();
  });

  it('round-robin 轮转均摊;required_caps 缺省不设限', async () => {
    const h0 = createTargetSelector({
      selfNodeId: SELF,
      fetchDirectory: async () => [
        { node_id: A, status: 'active' }, { node_id: B, status: 'active' },
      ],
      offerTemplate: { summary: 'x' },
    });
    await h0.refresh();
    const h = h0;
    const picks = [0, 1, 2].map(() => h.selector({ task_id: crypto.randomUUID(), nextAttempt: 1, excluded: {}, kind: 'project' })!.target);
    expect(picks).toEqual([A, B, A]); // 轮转均摊
    // 无 required_caps → suspended 也只是非 active 被滤;suspended 过滤已由 status 判定覆盖
    expect(h.snapshotSize()).toBe(2);
  });

  it('refresh 失败保留旧快照(目录瞬断不改写本地视图)', async () => {
    let fail = false;
    const h = createTargetSelector({
      selfNodeId: SELF, fetchDirectory: async () => { if (fail) throw new Error('down'); return dir; },
      offerTemplate: template, strategy: 'first',
    });
    await h.refresh();
    expect(h.snapshotSize()).toBe(3);
    fail = true;
    await expect(h.refresh()).resolves.toBe(false);
    expect(h.snapshotSize()).toBe(3); // 旧快照原样保留
    expect(h.selector({ task_id: crypto.randomUUID(), nextAttempt: 1, excluded: {}, kind: 'aid' })!.target).toBe(A);
  });
});
