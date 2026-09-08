import { describe, expect, it } from 'vitest';
import { composeTaskPrompt, buildHarnessCommand, DeepSeekHarnessDriver } from '../src/driver/harness-driver.js';
import type { DriverHost, DriverTask } from '../src/executor/driver.js';

/** v0.5:按 deepseek-harness 上游真实契约(npm @deepseek-ai/dsh / --profile headless)的驱动 */
describe('composeTaskPrompt(01 §4.2 任务书)', () => {
  it('summary 为主干;contract 展开交付物与验收判据;附时限', () => {
    const p = composeTaskPrompt({
      summary: '重构登录模块',
      deadline_ms: 90_000,
      contract: {
        deliverables: [{ path: 'src/auth.ts', desc: '改造后的认证模块' }],
        acceptance: [{ check: 'pnpm test auth 通过' }],
      },
    });
    expect(p).toContain('重构登录模块');
    expect(p).toContain('交付物:');
    expect(p).toContain('- src/auth.ts —— 改造后的认证模块');
    expect(p).toContain('验收判据:');
    expect(p).toContain('- pnpm test auth 通过');
    expect(p).toContain('90 秒');
  });

  it('纯 summary 任务不产生空段', () => {
    expect(composeTaskPrompt({ summary: '做点事' })).toBe('做点事');
  });
});

describe('buildHarnessCommand(上游 CLI 契约)', () => {
  it('默认:npx --yes @deepseek-ai/dsh --profile headless <prompt>,cwd=工作区', () => {
    const r = buildHarnessCommand('跑测试', '/ws/dir');
    expect(r.cmd).toBe('npx');
    expect(r.args).toEqual(['--yes', '@deepseek-ai/dsh', '--profile', 'headless', '跑测试']);
    expect(r.cwd).toBe('/ws/dir');
  });

  it('DSH_HARNESS_CMD 覆盖:去掉 npx 包装,直接转发 profile', () => {
    const prev = process.env.DSH_HARNESS_CMD;
    process.env.DSH_HARNESS_CMD = '/opt/dsh/bin/dsh';
    try {
      const r = buildHarnessCommand('跑测试', undefined);
      expect(r.cmd).toBe('/opt/dsh/bin/dsh');
      expect(r.args).toEqual(['--profile', 'headless', '跑测试']);
    } finally {
      if (prev === undefined) delete process.env.DSH_HARNESS_CMD;
      else process.env.DSH_HARNESS_CMD = prev;
    }
  });
});

describe('DeepSeekHarnessDriver(经 commandLine 覆盖做真实 spawn 集成)', () => {
  const makeHost = (): { host: DriverHost; completed: Array<Record<string, unknown>>; failed: Array<Record<string, unknown>> } => {
    const completed: Array<Record<string, unknown>> = [];
    const failed: Array<Record<string, unknown>> = [];
    const host: DriverHost = {
      now: () => Date.now(),
      schedule: (_atMs, cb) => {
        const t = setTimeout(cb, Math.max(0, _atMs - Date.now()));
        return () => clearTimeout(t);
      },
      complete: (b) => completed.push(b),
      fail: (b) => failed.push(b),
    };
    return { host, completed, failed };
  };

  it('真实 spawn:stdout 捕获 → complete;工作区作为 cwd', async () => {
    const driver = new DeepSeekHarnessDriver({
      commandLine: (prompt, workdir) => ({
        cmd: process.execPath,
        args: ['-e', `console.log('ANSWER:' + process.argv[1]); console.error('CWD:' + process.cwd())`, prompt],
        ...(workdir ? {} : {}),
      }),
      taskTimeoutMs: 10_000,
    });
    const { host, completed, failed } = makeHost();
    const task: DriverTask = { task_id: 'x', attempt: 1, offer: { summary: 's' }, workdir: process.cwd() };
    driver.start(task, host);
    const deadline = Date.now() + 3_000;
    while (completed.length === 0 && failed.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(failed).toEqual([]);
    expect(completed[0]?.summary).toContain('ANSWER:s');
    driver.stop();
  });

  it('非零退出 → fail(retryable internal_error)', async () => {
    const driver = new DeepSeekHarnessDriver({
      commandLine: () => ({
        cmd: process.execPath,
        args: ['-e', 'process.exit(3)'],
      }),
      taskTimeoutMs: 10_000,
    });
    const { host, completed, failed } = makeHost();
    driver.start({ task_id: 'x', attempt: 1, offer: {} }, host);
    const deadline = Date.now() + 3_000;
    while (completed.length === 0 && failed.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(completed).toEqual([]);
    expect(failed[0]?.reason_code).toBe('internal_error');
    driver.stop();
  });
});
