/**
 * qlong agent —— 单机的"龙"对话入口(粘合层):你输入目标,直接调本机 dsh 运行时执行。
 *
 * 设计边界(用户拍板,2026-09-19):**qlong 不做智能**。Agent 的实现就是 dsh 运行时本身;
 * qlong 只做粘合 —— 安装/定位 dsh、维持固定工作区、转发输入、流式展示输出。
 *
 * 能力全部来自 dsh 运行时(headless profile 原生支持,见 `dsh --profile headless --help`):
 * - `--json`:NDJSON 运行事件流(session/text/thinking/status/final)→ 实时流式展示;
 * - `--session-id`:持久会话 → 跨行/跨次对话上下文由 dsh 运行时自己管理(会话 id
 *   持久化在工作区 agent-session.json,重启不丢上下文)。
 */
import { execSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildHarnessCommand } from '../../node/src/driver/harness-driver.js';
import { resolveLocalDshRuntime } from './dsh-cmd.js';

export interface AgentTurnResult {
  code: number;
  /** dsh 会话 id(来自 session 事件;用于 --session-id 连续对话) */
  sessionId?: string;
  /** final 事件的完整回答 */
  finalText?: string;
}

export interface AgentSessionOptions {
  /** 固定工作区(dsh 的调用目录与会话记录所在,跨行连续) */
  workdir: string;
  /** 本机 dsh 命令(安装器标记 'dsh' = npm 全局运行时;或显式命令);缺省走 npx 通道 */
  dshCmd?: string;
  profile?: string;
  /** 单轮超时 ms(默认 600_000) */
  turnTimeoutMs?: number;
  /** 输入源注入(测试);缺省 readline(逐行) */
  readLine?: () => Promise<string | null>;
  /** 输出注入(测试);缺省 process.stdout */
  write?: (text: string) => void;
  /** 单轮执行注入(测试):收到完整参数,返回 NDJSON 事件行;缺省真实 spawn */
  dshTurn?: (args: string[], cwd: string | undefined) => Promise<{ code: number; lines: string[] }>;
}

/** 解析一条 NDJSON 事件并渲染;返回需要会话层记录的字段。 */
export function renderDshEvent(line: string, write: (t: string) => void): { sessionId?: string; finalText?: string } {
  if (!line.trim()) return {};
  let ev: { type?: string; sessionId?: string; text?: string; phase?: string; usage?: { inputTokens?: number; outputTokens?: number } };
  try {
    ev = JSON.parse(line);
  } catch {
    return {}; // 非事件行(诊断输出)→ 忽略
  }
  if (ev.type === 'session' && typeof ev.sessionId === 'string') return { sessionId: ev.sessionId };
  if (ev.type === 'thinking' && typeof ev.text === 'string' && ev.text.length > 0) {
    write(`\n—— 思考 ——\n${ev.text}\n———\n`);
    return {};
  }
  if (ev.type === 'text' && typeof ev.text === 'string') { write(ev.text); return {}; }
  if (ev.type === 'final' && typeof ev.text === 'string') { write('\n'); return { finalText: ev.text }; }
  if (ev.type === 'status' && ev.phase === 'step_end' && ev.usage) {
    const u = ev.usage;
    if (typeof u.inputTokens === 'number' && typeof u.outputTokens === 'number') {
      write(`\n[dim tokens: in ${u.inputTokens} / out ${u.outputTokens}]\n`);
    }
  }
  return {};
}

function defaultDshTurn(cmd: string, args: string[], cwd: string | undefined, write: (t: string) => void, timeoutMs: number): Promise<AgentTurnResult> {
  return new Promise((resolve) => {
    let sessionId: string | undefined;
    let finalText: string | undefined;
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      write(`\n⚠️ 单轮超时(${Math.round(timeoutMs / 1000)}s),终止本次执行\n`);
      child.kill();
    }, timeoutMs);
    // dsh headless 在模型生成期不发任何事件(实测:启动事件 ~1s,其余在完成时批量到达)
    // —— 等待期计时器让"活着"可见;首个事件到达即停表换行,不与内容互相穿插
    let ticker: NodeJS.Timeout | undefined;
    let elapsed = 0;
    let contentStarted = false;
    ticker = setInterval(() => {
      elapsed += 3;
      write(`\r⏳ 执行中 ${elapsed}s`);
    }, 3000);
    const writeOnce = (t: string): void => {
      if (!contentStarted) {
        if (ticker) clearInterval(ticker);
        ticker = undefined;
        contentStarted = true;
        write('\n');
      }
      write(t);
    };
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (l) => {
      const r = renderDshEvent(l, writeOnce);
      if (r.sessionId) sessionId = r.sessionId;
      if (r.finalText !== undefined) finalText = r.finalText;
    });
    child.stderr.on('data', (c: Buffer) => process.stderr.write(c));
    child.on('error', (e) => {
      clearTimeout(timer);
      if (ticker) clearInterval(ticker);
      write(`dsh 启动失败:${e.message}\n`);
      resolve({ code: 127 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (ticker) clearInterval(ticker);
      if (!contentStarted) write('\n');
      resolve({ code: code ?? 0, sessionId, finalText });
    });
  });
}

/** 组装单轮参数:--json 事件流 + 会话续接 + 任务原文(prompt 恒在最后一位)。 */
export function buildTurnArgs(base: { cmd: string; args: string[] }, sessionId: string | undefined, task: string): string[] {
  return [...base.args, '--json', ...(sessionId ? ['--session-id', sessionId] : []), task];
}

/** 基础调用(不含任务文本):本地安装的 dsh 运行时优先,缺省 npx 通道。 */
function baseInvocation(dshCmd: string | undefined, profile: string): { cmd: string; args: string[] } {
  if (dshCmd === 'dsh') {
    try {
      const root = execSync('npm root -g', { encoding: 'utf8', timeout: 10_000 }).trim();
      const binJs = join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (existsSync(binJs)) return { cmd: process.execPath, args: [binJs, '--profile', profile] };
    } catch { /* npm 不可用 → npx 回退 */ }
  }
  const built = buildHarnessCommand('__TASK__', undefined, {});
  // buildHarnessCommand 把任务书放在最后一位;此处只要基础段(任务文本由调用方追加)
  return { cmd: built.cmd, args: built.args.slice(0, -1) };
}

function readSessionId(workdir: string): string | undefined {
  try {
    const j = JSON.parse(readFileSync(join(workdir, 'agent-session.json'), 'utf8')) as { sessionId?: string };
    return typeof j.sessionId === 'string' ? j.sessionId : undefined;
  } catch {
    return undefined;
  }
}

function writeSessionId(workdir: string, sessionId: string): void {
  try {
    writeFileSync(join(workdir, 'agent-session.json'), JSON.stringify({ sessionId }, null, 2));
  } catch { /* 会话记录失败不阻断对话 */ }
}

/** 会话主循环:读一行 → 调一次 dsh(--json 流式)→ 实时展示;exit/quit/退出/Ctrl+D 结束。 */
export async function runAgentSession(opts: AgentSessionOptions): Promise<number> {
  mkdirSync(opts.workdir, { recursive: true });
  const write = opts.write ?? ((t: string) => process.stdout.write(t));
  const dshTurn = opts.dshTurn
    ? async (args: string[], cwd: string | undefined): Promise<AgentTurnResult> => {
        const r = await opts.dshTurn!(args, cwd);
        let sessionId: string | undefined;
        let finalText: string | undefined;
        for (const l of r.lines) {
          const p = renderDshEvent(l, write);
          if (p.sessionId) sessionId = p.sessionId;
          if (p.finalText !== undefined) finalText = p.finalText;
        }
        return { code: r.code, sessionId, finalText };
      }
    : (args: string[], cwd: string | undefined): Promise<AgentTurnResult> =>
        defaultDshTurn(base.cmd, args, cwd, write, opts.turnTimeoutMs ?? 600_000);

  // 输入队列(readline 逐行 + EOF 标记;piped 与交互两种形态都正确收口)
  const pending: string[] = [];
  let eof = false;
  let notify: (() => void) | undefined;
  if (!opts.readLine) {
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (l) => { pending.push(l); notify?.(); });
    rl.on('close', () => { eof = true; notify?.(); });
  }
  const readLine = opts.readLine ?? (async (): Promise<string | null> => {
    for (;;) {
      if (pending.length > 0) return pending.shift() ?? null;
      if (eof) return null;
      await new Promise<void>((r) => { notify = r; });
    }
  });

  const base = baseInvocation(opts.dshCmd, opts.profile ?? 'headless');
  let sessionId = readSessionId(opts.workdir);

  write(`🐉 龙 Agent 就绪(工作区 ${opts.workdir})\n`);
  write(`   直接输入目标;dsh 运行时流式执行,上下文跨行连续;exit / Ctrl+D 结束。\n\n`);

  for (;;) {
    write('龙> ');
    const line = (await readLine())?.trim() ?? '';
    if (line === null || line === '') continue;
    if (line === 'exit' || line === 'quit' || line === '退出') { write('再见。\n'); return 0; }

    const args = buildTurnArgs(base, sessionId, line);
    write('⏳ 执行中…\n');
    const turn = await dshTurn(args, opts.workdir);
    if (turn.sessionId && turn.sessionId !== sessionId) {
      sessionId = turn.sessionId;
      writeSessionId(opts.workdir, sessionId);
    }
    if (turn.code !== 0) write(`⚠️ dsh 退出码 ${turn.code}\n`);
    else write('✔ 完成\n');
  }
}
