import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAgentSession } from '../src/agent.js';

/**
 * qlong agent(粘合层):每行输入 = 直接调一次本机 dsh 运行时。
 * qlong 不做智能 —— 会话循环只负责转发输入、透传输出、维持固定工作区。
 * 测试注入输入源与执行桩,校验转发契约(原文转发 / 多轮 / 空行跳过 / 退出语义)。
 */
function workspace(): string {
  return join(realpathSync(mkdtempSync(join(tmpdir(), 'qlong-agent-'))), 'ws');
}

describe('qlong agent(粘合层:每行输入直调本机 dsh)', () => {
  it('原文转发:输入行原样成为 dsh prompt;结果透传;exit 正常收口', async () => {
    const execLog: Array<{ cmd: string; prompt: string }> = [];
    const out: string[] = [];
    const lines = ['帮我打印 pong', '再打印一行 good', 'exit'];
    let i = 0;
    const code = await runAgentSession({
      workdir: workspace(),
      dshCmd: 'dsh',
      readLine: async () => (i < lines.length ? lines[i++] ?? 'exit' : 'exit'),
      write: (t) => out.push(t),
      exec: async (cmd, _args, _cwd, prompt) => {
        execLog.push({ cmd, prompt });
        return { code: 0, stdout: `done-${i}` };
      },
    });
    expect(code).toBe(0);
    expect(execLog).toHaveLength(2);
    expect(execLog[0]).toMatchObject({ cmd: 'dsh', prompt: '帮我打印 pong' });
    expect(execLog[1]!.prompt).toBe('再打印一行 good');
    expect(out.join('')).toContain('✔ 完成');
    expect(out.join('')).toContain('再见');
  });

  it('空行跳过(不调 dsh);quit 同样收口', async () => {
    const execLog: Array<{ cmd: string; prompt: string }> = [];
    const lines = ['', '   ', 'quit'];
    let i = 0;
    const code = await runAgentSession({
      workdir: workspace(),
      dshCmd: 'dsh',
      readLine: async () => (i < lines.length ? lines[i++] ?? 'exit' : 'exit'),
      write: () => {},
      exec: async (cmd, _args, _cwd, prompt) => {
        execLog.push({ cmd, prompt });
        return { code: 0, stdout: '' };
      },
    });
    expect(code).toBe(0);
    expect(execLog).toHaveLength(0); // 没有任何输入到达 dsh
  });

  it('非零退出码透传(dsh 失败可见,会话继续)', async () => {
    const execLog: Array<{ cmd: string; prompt: string }> = [];
    const lines = ['会失败的任务', 'exit'];
    let i = 0;
    const code = await runAgentSession({
      workdir: workspace(),
      dshCmd: 'dsh',
      readLine: async () => (i < lines.length ? lines[i++] ?? 'exit' : 'exit'),
      write: () => {},
      exec: async () => {
        execLog.push({ cmd: 'dsh', prompt: 'x' });
        return { code: 1, stdout: 'boom' };
      },
    });
    expect(code).toBe(0); // 单次失败不打断会话
    expect(execLog).toHaveLength(1);
  });
});
