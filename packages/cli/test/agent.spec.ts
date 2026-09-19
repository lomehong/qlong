import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTurnArgs, renderDshEvent, runAgentSession } from '../src/agent.js';

/**
 * qlong agent(粘合层):每行输入 = 直接调一次本机 dsh 运行时(--json 事件流)。
 * qlong 不做智能 —— 会话循环只负责转发输入、流式渲染事件、会话 id 续接。
 * 测试注入 dshTurn(返回真实探测到的 NDJSON 事件形状)与输入源。
 */

// 真实事件形状(2026-09-19 实测 `dsh --profile headless --json` 输出采样)
const EVENT_SESSION = JSON.stringify({ type: 'session', sessionId: 'session-4f51', cwd: 'x' });
const EVENT_TURN_START = JSON.stringify({ type: 'status', phase: 'turn_start', turn: 1 });
const EVENT_TEXT = JSON.stringify({ type: 'text', text: 'streaming-test-ok' });
const EVENT_USAGE = JSON.stringify({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 2139, outputTokens: 6 } });
const EVENT_FINAL = JSON.stringify({ type: 'final', text: 'streaming-test-ok' });

function workspace(): string {
  return join(realpathSync(mkdtempSync(join(tmpdir(), 'qlong-agent-'))), 'ws');
}

describe('NDJSON 事件渲染(renderDshEvent)', () => {
  it('text → 流式写出;final → 捕获完整回答;session → 捕获会话 id', () => {
    const out: string[] = [];
    expect(renderDshEvent(EVENT_SESSION, (t) => out.push(t))).toMatchObject({ sessionId: 'session-4f51' });
    renderDshEvent(EVENT_TEXT, (t) => out.push(t));
    expect(out.join('')).toContain('streaming-test-ok');
    const fin = renderDshEvent(EVENT_FINAL, (t) => out.push(t));
    expect(fin.finalText).toBe('streaming-test-ok');
  });

  it('status step_end → 展示 token 用量;非 JSON 行忽略', () => {
    const out: string[] = [];
    renderDshEvent(EVENT_USAGE, (t) => out.push(t));
    expect(out.join('')).toContain('in 2139 / out 6');
    expect(renderDshEvent('这不是JSON', (t) => out.push(t))).toEqual({});
  });
});

describe('buildTurnArgs(会话续接 + prompt 恒在最后)', () => {
  it('首轮:--json,无 --session-id;后续:带 --session-id', () => {
    const base = { cmd: 'node', args: ['bin.js', '--profile', 'headless'] };
    expect(buildTurnArgs(base, undefined, '你好')).toEqual(
      ['bin.js', '--profile', 'headless', '--json', '你好'],
    );
    expect(buildTurnArgs(base, 'session-4f51', '你好').slice(-3)).toEqual(
      ['--session-id', 'session-4f51', '你好'],
    );
  });
});

describe('qlong agent 会话(注入 dshTurn,真实事件形状)', () => {
  it('流式渲染 + 会话 id 捕获持久化 + 第二轮 --session-id 续接', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'qlong-agent-')));
    const workdir = join(root, 'ws');
    const out: string[] = [];
    const calls: string[][] = [];
    const lines = ['你好', '再来一次', 'exit'];
    let i = 0;
    const code = await runAgentSession({
      workdir,
      dshCmd: 'dsh',
      readLine: async () => (i < lines.length ? lines[i++] ?? 'exit' : 'exit'),
      write: (t) => out.push(t),
      dshTurn: async (args) => {
        calls.push(args);
        return { code: 0, lines: [EVENT_SESSION, EVENT_TEXT, EVENT_FINAL] };
      },
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    // 第一轮:--json + 任务原文;流式渲染 text 事件
    expect(calls[0]).toContain('--json');
    expect(calls[0]!.at(-1)).toBe('你好');
    expect(out.join('')).toContain('streaming-test-ok');
    // 会话 id 捕获并持久化到工作区
    expect(JSON.parse(require('node:fs').readFileSync(join(workdir, 'agent-session.json'), 'utf8')).sessionId)
      .toBe('session-4f51');
    // 第二轮:--session-id 续接(上下文由 dsh 运行时管理,qlong 不造记忆轮子)
    expect(calls[1]).toContain('--session-id');
    expect(calls[1]).toContain('session-4f51');
    expect(calls[1]!.at(-1)).toBe('再来一次');
    void root;
  });

  it('空行跳过(不调 dsh);quit 收口', async () => {
    const lines = ['', '   ', 'quit'];
    let calls = 0;
    let i = 0;
    const code = await runAgentSession({
      workdir: workspace(),
      dshCmd: 'dsh',
      readLine: async () => (i < lines.length ? lines[i++] ?? 'exit' : 'exit'),
      write: () => {},
      dshTurn: async () => { calls += 1; return { code: 0, lines: [] }; },
    });
    expect(code).toBe(0);
    expect(calls).toBe(0);
  });

  it('单轮失败可见且不打断会话', async () => {
    const lines = ['会失败的任务', 'exit'];
    let i = 0;
    const out: string[] = [];
    let turns = 0;
    const code = await runAgentSession({
      workdir: workspace(),
      dshCmd: 'dsh',
      readLine: async () => (i < lines.length ? lines[i++] ?? 'exit' : 'exit'),
      write: (t) => out.push(t),
      dshTurn: async () => {
        turns += 1;
        return { code: turns === 1 ? 1 : 0, lines: [] };
      },
    });
    expect(code).toBe(0);
    expect(turns).toBe(1);
    expect(out.join('')).toContain('退出码 1');
  });
});
