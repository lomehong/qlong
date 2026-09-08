import { describe, expect, it } from 'vitest';
import { DeepSeekHarnessDriver } from '../src/driver/harness-driver.js';

/**
 * 真实 deepseek-harness 联调(默认 npx 通道,零命令行覆盖)。
 * 门控:QLONG_DSH_E2E=1 时运行(需要 npm 网络 + dsh headless 可用的模型凭证)。
 * 验证契约:默认命令 npx --yes @deepseek-ai/dsh --profile headless <任务书>
 *          → stdout 最终答案 → complete。
 */
const enabled = process.env.QLONG_DSH_E2E === '1';
(enabled ? describe : describe.skip)('真实 deepseek-harness 联调(QLONG_DSH_E2E=1)', () => {
  it('默认 npx 通道:headless 一次性任务 → complete,答案含 pong', async () => {
    const completed: Array<Record<string, unknown>> = [];
    const failed: Array<Record<string, unknown>> = [];
    const host = {
      now: () => Date.now(),
      schedule: (atMs: number, cb: () => void) => {
        const t = setTimeout(cb, Math.max(0, atMs - Date.now()));
        return () => clearTimeout(t);
      },
      complete: (b: Record<string, unknown>) => completed.push(b),
      fail: (b: Record<string, unknown>) => failed.push(b),
    };
    const driver = new DeepSeekHarnessDriver({ taskTimeoutMs: 180_000 });
    driver.start(
      { task_id: 'e2e', attempt: 1, offer: { summary: 'reply with the single word: pong' } },
      host,
    );
    const deadline = Date.now() + 180_000;
    while (completed.length === 0 && failed.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    driver.stop();
    expect(failed).toEqual([]);
    expect(String(completed[0]?.summary)).toContain('pong');
  }, 200_000);
});
