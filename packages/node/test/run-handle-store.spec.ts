import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { newId } from '@qlong/core';
import { FencedProcessDriver } from '../src/driver/fenced-driver.js';
import type { RunFence } from '../src/driver/run-handle.js';
import { NodeRuntimeStore } from '../src/runtime/store.js';
import { PersistentRunHandleStore, RUN_HANDLE_KEY } from '../src/runtime/run-handles.js';
import { fixture, LOCAL, open } from './runtime-store-helpers.js';

const node = process.execPath;
const fence = (): RunFence => ({ task_id: newId(), attempt: 1, generation: 1, run_id: newId() });

/** spawn 一个立即退出的子进程,await close 后返回其已释放的 pid(孤儿已退出场景)。 */
async function exitedChildPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(node, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    if (child.pid === undefined) { reject(new Error('spawn 未返回 pid')); return; }
    const pid = child.pid;
    child.on('error', reject);
    child.on('close', () => resolve(pid));
  });
}

describe('PersistentRunHandleStore(node_state 背书)', () => {
  it('record→load 按精确 fence 往返;未记录 → undefined', () => {
    const f = fixture();
    const s = new PersistentRunHandleStore(f.runtime);
    const run = fence();
    expect(s.load(run)).toBeUndefined();
    s.record({ fence: run, pid: 424242, startedAt: 1_000 });
    expect(s.load(run)).toEqual({ fence: run, pid: 424242, startedAt: 1_000 });
  });

  it('load 只认精确 fence:run_id 同但 attempt 异 → undefined', () => {
    const f = fixture();
    const s = new PersistentRunHandleStore(f.runtime);
    const run = fence();
    s.record({ fence: run, pid: 424242, startedAt: 1_000 });
    expect(s.load({ ...run, attempt: run.attempt + 1 })).toBeUndefined();
  });

  it('clear 置墓碑 → load undefined;单键可被后续 record 覆盖', () => {
    const f = fixture();
    const s = new PersistentRunHandleStore(f.runtime);
    const a = fence();
    s.record({ fence: a, pid: 111, startedAt: 1 });
    s.clear(a);
    expect(s.load(a)).toBeUndefined();
    const b = fence();
    s.record({ fence: b, pid: 222, startedAt: 2 });
    expect(s.load(b)).toEqual({ fence: b, pid: 222, startedAt: 2 });
    expect(s.load(a)).toBeUndefined();
  });

  it('clear 只清匹配 fence,绝不覆盖更新 run 的句柄', () => {
    const f = fixture();
    const s = new PersistentRunHandleStore(f.runtime);
    const a = fence();
    const b = fence();
    s.record({ fence: a, pid: 111, startedAt: 1 });
    s.record({ fence: b, pid: 222, startedAt: 2 }); // 单键覆盖为 b
    s.clear(a); // a 已非现存句柄 → 不动
    expect(s.load(b)).toEqual({ fence: b, pid: 222, startedAt: 2 });
  });

  it('损坏/异形值 → load undefined(fail-closed,绝不据坏数据伪造静默)', () => {
    const f = fixture();
    const run = fence();
    f.runtime.transition(RUN_HANDLE_KEY, 0, () => ({ state: {
      fence: { task_id: run.task_id, attempt: run.attempt, generation: run.generation, run_id: run.run_id },
      pid: 'not-a-number', startedAt: 1,
    } }));
    const s = new PersistentRunHandleStore(f.runtime);
    expect(s.load(run)).toBeUndefined();
  });
});

describe('FencedProcessDriver + 持久句柄跨真实重启(C1c e2e)', () => {
  it('已退出孤儿的句柄跨 SQLite 重开存活 → recover stopped', async () => {
    const f = fixture();
    const run = fence();
    const deadPid = await exitedChildPid();
    new PersistentRunHandleStore(f.runtime).record({ fence: run, pid: deadPid, startedAt: Date.now() });
    // 真实重启:关旧库,以新连接重开(模拟新进程视图)。
    f.store.close();
    const reopened = new NodeRuntimeStore(open({ ...f.options, mode: 'open' }), LOCAL);
    const restarted = new FencedProcessDriver({ runHandles: new PersistentRunHandleStore(reopened) });
    await expect(restarted.recover(run)).resolves.toBe('stopped');
  });

  it('仍存活孤儿的句柄跨 SQLite 重开 → recover unknown(绝不杀不可证进程)', async () => {
    const f = fixture();
    const run = fence();
    const child = spawn(node, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    try {
      new PersistentRunHandleStore(f.runtime).record({ fence: run, pid, startedAt: Date.now() });
      f.store.close();
      const reopened = new NodeRuntimeStore(open({ ...f.options, mode: 'open' }), LOCAL);
      const restarted = new FencedProcessDriver({ runHandles: new PersistentRunHandleStore(reopened) });
      await expect(restarted.recover(run)).resolves.toBe('unknown');
    } finally {
      child.kill('SIGKILL');
    }
  });
});
