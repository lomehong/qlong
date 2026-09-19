import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '@qlong/core';
import { FencedWorkspace } from '../src/collab/workspace.js';
import type { RunFence } from '../src/driver/run-handle.js';

const offer = (): Record<string, unknown> => ({ kind: 'aid', summary: 'work' });
const fence = (overrides: Partial<RunFence> = {}): RunFence =>
  ({ task_id: newId(), attempt: 1, generation: 1, run_id: newId(), ...overrides });

/** 每个用例一个隔离 baseDir,避免跨用例污染;用例后整树清除。 */
let base: string;
const makeWs = (): FencedWorkspace => {
  base = mkdtempSync(join(tmpdir(), 'qlong-fws-'));
  return new FencedWorkspace({ baseDir: base });
};
afterEach(() => { if (base) rmSync(base, { recursive: true, force: true }); });

describe('FencedWorkspace(e2d-1 durable per-fence 工作区)', () => {
  it('prepare 创建目录并返回其绝对路径作为 cwd', async () => {
    const ws = makeWs();
    const ctx = await ws.prepare(fence(), offer());
    expect(typeof ctx.cwd).toBe('string');
    const cwd = ctx.cwd!;
    expect(isAbsolute(cwd)).toBe(true);
    expect(existsSync(cwd)).toBe(true);
    // cwd 严格落在 baseDir 内(路径安全)
    const rel = relative(resolve(base), resolve(cwd));
    expect(rel === '' || rel.startsWith('..') || isAbsolute(rel)).toBe(false);
  });

  it('release 删除该 fence 的工作区目录', async () => {
    const ws = makeWs();
    const f = fence();
    const { cwd } = await ws.prepare(f, offer());
    expect(existsSync(cwd!)).toBe(true);
    await ws.release(f);
    expect(existsSync(cwd!)).toBe(false);
  });

  it('跨 attempt 不串产物:仅 attempt 不同即不同目录,旧产物不可见', async () => {
    const ws = makeWs();
    const task_id = newId();
    const run_id = newId();
    const a1 = fence({ task_id, attempt: 1, run_id });
    const a2 = fence({ task_id, attempt: 2, run_id });
    const c1 = await ws.prepare(a1, offer());
    const c2 = await ws.prepare(a2, offer());
    expect(c1.cwd).not.toBe(c2.cwd);
    // attempt1 工作区写入的产物,绝不出现在 attempt2 工作区
    writeFileSync(join(c1.cwd!, 'stale.txt'), 'attempt-1-artifact');
    expect(existsSync(join(c1.cwd!, 'stale.txt'))).toBe(true);
    expect(existsSync(join(c2.cwd!, 'stale.txt'))).toBe(false);
    await ws.release(a1);
    await ws.release(a2);
  });

  it('prepare 按 fence 幂等:重复调用返回同一 cwd 且不抛', async () => {
    const ws = makeWs();
    const f = fence();
    const first = await ws.prepare(f, offer());
    writeFileSync(join(first.cwd!, 'keep.txt'), 'x');
    const second = await ws.prepare(f, offer());
    expect(second.cwd).toBe(first.cwd);
    // 幂等附着不清空既有内容(create → execute 之间可能重入)
    expect(existsSync(join(first.cwd!, 'keep.txt'))).toBe(true);
    await ws.release(f);
  });

  it('release 幂等:重复释放与释放从未 prepare 的 fence 均不抛', async () => {
    const ws = makeWs();
    const f = fence();
    await ws.prepare(f, offer());
    await ws.release(f);
    await expect(ws.release(f)).resolves.toBeUndefined();
    await expect(ws.release(fence())).resolves.toBeUndefined();
  });

  it('非法 fence(非 uuid task_id)→ prepare 拒绝(失败关闭)', async () => {
    const ws = makeWs();
    await expect(ws.prepare(fence({ task_id: '../../etc' }), offer())).rejects.toThrow();
  });

  it('非法 fence(非正整数 attempt)→ prepare 拒绝', async () => {
    const ws = makeWs();
    await expect(ws.prepare(fence({ attempt: 0 }), offer())).rejects.toThrow();
  });

  it('缺省 baseDir 落在 os.tmpdir 下(Windows 安全,非 /tmp)', async () => {
    const ws = new FencedWorkspace();
    const f = fence();
    const { cwd } = await ws.prepare(f, offer());
    try {
      const rel = relative(resolve(tmpdir()), resolve(cwd!));
      expect(rel === '' || rel.startsWith('..') || isAbsolute(rel)).toBe(false);
    } finally { await ws.release(f); }
  });
});
