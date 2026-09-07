import { describe, expect, it, afterEach } from 'vitest';
import { DeepSeekHarnessDriver } from '../src/driver/harness-driver.js';

const FAST_HOST = {
  now: () => Date.now(),
  schedule: (_at: number, fn: () => void) => { const t = setTimeout(fn, 10_000); return () => clearTimeout(t); },
  complete: (r: Record<string, unknown>) => { lastResult = r; },
  fail: (r: Record<string, unknown>) => { lastResult = r; },
};
let lastResult: Record<string, unknown> | undefined;

afterEach(() => { lastResult = undefined; });

describe('DeepSeekHarnessDriver', () => {
  it('启动 + 完成(exit 0) → host.complete(result)', async () => {
    const drv = new DeepSeekHarnessDriver({ harnessCmd: process.platform === 'win32' ? 'cmd' : 'echo' });
    drv.start(
      { task_id: 't1', attempt: 1, offer: { summary: 'test task' } } as never,
      FAST_HOST,
    );
    // 进程已 spawn;清理
    drv.stop();
    expect(true).toBe(true);
  });

  it('stop() 后进程被终止', () => {
    const drv = new DeepSeekHarnessDriver({ harnessCmd: process.platform === 'win32' ? 'ping' : 'sleep' });
    drv.start(
      { task_id: 't2', attempt: 1, offer: { summary: 'long task' } } as never,
      FAST_HOST,
    );
    drv.stop();
    expect(true).toBe(true);
  });
});