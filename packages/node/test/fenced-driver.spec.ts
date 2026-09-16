import { describe, expect, it, vi } from 'vitest';
import { newId } from '@qlong/core';
import { FencedProcessDriver } from '../src/driver/fenced-driver.js';
import type { RunFence } from '../src/driver/run-handle.js';

const node = process.execPath;
const fence = (): RunFence => ({ task_id: newId(), attempt: 1, generation: 1, run_id: newId() });
const offer = (summary = 'work'): Record<string, unknown> => ({ kind: 'aid', summary });

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
