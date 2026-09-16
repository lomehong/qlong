import { describe, expect, it, afterEach, vi } from 'vitest';
import { once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { DeepSeekHarnessDriver } from '../src/driver/harness-driver.js';

const host = {
  now: () => Date.now(),
  schedule: (at: number, fn: () => void) => {
    const t = setTimeout(fn, Math.max(0, at - Date.now()));
    return () => clearTimeout(t);
  },
  complete: vi.fn(),
  fail: vi.fn(),
};
const drivers: DeepSeekHarnessDriver[] = [];

afterEach(() => {
  for (const driver of drivers.splice(0)) driver.stop();
  vi.clearAllMocks();
});

function localDriver(source: string) {
  // Explicit trusted executable+argv: tests must NEVER fall through to npx/model access.
  const driver = new DeepSeekHarnessDriver({
    commandLine: () => ({ cmd: process.execPath, args: ['-e', source] }), taskTimeoutMs: 5_000,
  });
  drivers.push(driver);
  return driver;
}

describe('DeepSeekHarnessDriver', () => {
  it('启动 + 完成(exit 0) → host.complete(result)', async () => {
    const driver = localDriver("process.stdout.write('fixture answer')");
    driver.start({ task_id: 't1', attempt: 1, offer: { summary: 'test task' } }, host);
    await vi.waitFor(() => expect(host.complete).toHaveBeenCalledOnce());
    expect(host.complete).toHaveBeenCalledWith(expect.objectContaining({ summary: 'fixture answer', exit_code: 0 }));
    expect(host.fail).not.toHaveBeenCalled();
  });

  it('stop() 后实际等待测试子进程退出,不报告成功或失败', async () => {
    const driver = localDriver('setInterval(() => {}, 1000)');
    driver.start({ task_id: 't2', attempt: 1, offer: { summary: 'long task' } }, host);
    // Legacy driver's private handle is inspected only until RunHandle replaces this contract.
    const child = (driver as unknown as { proc: ChildProcess }).proc;
    const closed = once(child, 'close');
    driver.stop();
    await closed;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(host.complete).not.toHaveBeenCalled();
    expect(host.fail).not.toHaveBeenCalled();
  });
});