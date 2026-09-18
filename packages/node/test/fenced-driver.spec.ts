import { describe, expect, it, vi } from 'vitest';
import { newId } from '@qlong/core';
import { FencedProcessDriver } from '../src/driver/fenced-driver.js';
import type { PersistedRunHandle, RunFence, RunHandleStore } from '../src/driver/run-handle.js';

const node = process.execPath;
const fence = (): RunFence => ({ task_id: newId(), attempt: 1, generation: 1, run_id: newId() });
const offer = (summary = 'work'): Record<string, unknown> => ({ kind: 'aid', summary });

/** C1a:记录型 RunHandleStore 桩——append-only 日志,便于断言记录/清除生命周期。 */
function recordingStore() {
  const recorded: PersistedRunHandle[] = [];
  const cleared: RunFence[] = [];
  let failRecord = false;
  return {
    recorded, cleared,
    setFailRecord(value: boolean): void { failRecord = value; },
    record(handle: PersistedRunHandle): void {
      if (failRecord) throw new Error('record failed');
      recorded.push(handle);
    },
    load(fence: Readonly<RunFence>): PersistedRunHandle | undefined {
      return recorded.find((h) => h.fence.run_id === fence.run_id);
    },
    clear(fence: Readonly<RunFence>): void { cleared.push(fence); },
  } satisfies RunHandleStore & { recorded: PersistedRunHandle[]; cleared: RunFence[]; setFailRecord(v: boolean): void };
}

describe('FencedProcessDriver(RunHandle 协议包装)', () => {
  it('exit 0 → result(带 stdout 尾部与 exit_code)', async () => {
    const d = new FencedProcessDriver({
      commandLine: () => ({ cmd: node, args: ['-e', "console.log('done-work-marker'); process.exit(0)"] }),
    });
    const h = await d.start(fence(), offer());
    const outcome = await h.closed;
    expect(outcome.kind).toBe('result');
    expect(String((outcome.body as { summary?: string }).summary)).toContain('done-work-marker');
    expect((outcome.body as { exit_code?: number }).exit_code).toBe(0);
  });

  it('非零退出 → failed(internal_error, retryable)', async () => {
    const d = new FencedProcessDriver({
      commandLine: () => ({ cmd: node, args: ['-e', 'process.exit(3)'] }),
    });
    const h = await d.start(fence(), offer());
    const outcome = await h.closed;
    expect(outcome.kind).toBe('failed');
    expect(outcome.body).toMatchObject({ reason_code: 'internal_error', retryable: true });
  });

  it('stop() 兑现静默;closed 兑现为 stopped by request', async () => {
    const d = new FencedProcessDriver({
      commandLine: () => ({ cmd: node, args: ['-e', 'setInterval(() => {}, 1000)'] }),
    });
    const h = await d.start(fence(), offer());
    await h.stop(); // 幂等
    await h.stop();
    const outcome = await h.closed;
    expect(outcome.kind).toBe('failed');
    expect(outcome.body).toMatchObject({ summary: 'stopped by request' });
  });

  it('任务级硬上限:超时终止 → failed(task timeout)', async () => {
    const d = new FencedProcessDriver({
      taskTimeoutMs: 100,
      commandLine: () => ({ cmd: node, args: ['-e', 'setInterval(() => {}, 1000)'] }),
    });
    const h = await d.start(fence(), offer());
    const outcome = await h.closed;
    expect(outcome.kind).toBe('failed');
    expect(outcome.body).toMatchObject({ summary: 'task timeout' });
  });

  it('spawn 失败 → failed(driver spawn failed),不重试', async () => {
    const d = new FencedProcessDriver({
      commandLine: () => ({ cmd: 'definitely-not-a-real-command-xyz', args: [] }),
    });
    const h = await d.start(fence(), offer());
    const outcome = await h.closed;
    expect(outcome.kind).toBe('failed');
    expect(outcome.body).toMatchObject({ summary: 'driver spawn failed' });
  });

  it('任务书由 offer.summary 组装;workdir 缺省不注入 cwd', async () => {
    const commandLine = vi.fn(() => ({ cmd: node, args: ['-e', 'process.exit(0)'] }));
    const d = new FencedProcessDriver({ commandLine });
    await (await d.start(fence(), offer('specific-summary-marker'))).closed;
    expect(commandLine).toHaveBeenCalledOnce();
    const [prompt, workdir] = commandLine.mock.calls[0]! as unknown as [string, string | undefined];
    expect(prompt).toContain('specific-summary-marker');
    expect(workdir).toBeUndefined();
  });

  it('workdir 选项进入 cwd 装配', async () => {
    const commandLine = vi.fn(() => ({ cmd: node, args: ['-e', 'process.exit(0)'] }));
    const d = new FencedProcessDriver({ commandLine, workdir: 'C:/definitely-unused-cwd-marker' });
    await (await d.start(fence(), offer())).closed;
    const [, workdir] = commandLine.mock.calls[0]! as unknown as [string, string | undefined];
    expect(workdir).toBe('C:/definitely-unused-cwd-marker');
  });

  it('recover 永远 unknown(一次性进程无跨重启句柄)', async () => {
    const d = new FencedProcessDriver({});
    await expect(d.recover(fence())).resolves.toBe('unknown');
  });
});

describe('FencedProcessDriver run-handle 持久化(C1a)', () => {
  it('start 成功后按精确 fence 记录 pid + 启动证据', async () => {
    const store = recordingStore();
    const d = new FencedProcessDriver({
      runHandles: store,
      commandLine: () => ({ cmd: node, args: ['-e', 'setInterval(() => {}, 1000)'] }),
    });
    const f = fence();
    const h = await d.start(f, offer());
    expect(store.recorded).toHaveLength(1);
    expect(store.recorded[0]!.fence).toEqual(f);
    expect(Number.isInteger(store.recorded[0]!.pid)).toBe(true);
    expect(store.recorded[0]!.pid).toBeGreaterThan(0);
    expect(typeof store.recorded[0]!.startedAt).toBe('number');
    await h.stop();
  });

  it('run 兑现(result)后清除持久句柄', async () => {
    const store = recordingStore();
    const d = new FencedProcessDriver({
      runHandles: store,
      commandLine: () => ({ cmd: node, args: ['-e', 'process.exit(0)'] }),
    });
    const f = fence();
    await (await d.start(f, offer())).closed;
    expect(store.recorded).toHaveLength(1);
    expect(store.cleared).toEqual([f]);
  });

  it('stop() 静默路径同样清除句柄', async () => {
    const store = recordingStore();
    const d = new FencedProcessDriver({
      runHandles: store,
      commandLine: () => ({ cmd: node, args: ['-e', 'setInterval(() => {}, 1000)'] }),
    });
    const f = fence();
    const h = await d.start(f, offer());
    await h.stop();
    await h.closed;
    expect(store.cleared).toEqual([f]);
  });

  it('spawn 失败(无 pid)不记录句柄', async () => {
    const store = recordingStore();
    const d = new FencedProcessDriver({
      runHandles: store,
      commandLine: () => ({ cmd: 'definitely-not-a-real-command-xyz', args: [] }),
    });
    await (await d.start(fence(), offer())).closed;
    expect(store.recorded).toEqual([]);
  });

  it('record 失败 → start 拒绝(持久化故障失败关闭,不静默丢句柄)', async () => {
    const store = recordingStore();
    store.setFailRecord(true);
    const d = new FencedProcessDriver({
      runHandles: store,
      commandLine: () => ({ cmd: node, args: ['-e', 'process.exit(0)'] }),
    });
    await expect(d.start(fence(), offer())).rejects.toThrow();
  });

  it('未注入 RunHandleStore → 向后兼容(正常运行,无持久化)', async () => {
    const d = new FencedProcessDriver({
      commandLine: () => ({ cmd: node, args: ['-e', "console.log('compat-marker'); process.exit(0)"] }),
    });
    const outcome = await (await d.start(fence(), offer())).closed;
    expect(outcome.kind).toBe('result');
    expect(String((outcome.body as { summary?: string }).summary)).toContain('compat-marker');
  });
});
