/**
 * qlong agent —— 单机的"龙"对话入口(粘合层):你输入目标,直接调本机 dsh 运行时执行。
 *
 * 设计边界(用户拍板,2026-09-19):**qlong 不做智能**。Agent 的实现就是 dsh 运行时本身;
 * qlong 只做粘合 —— 安装/定位 dsh、维持固定工作区、转发输入、展示输出。
 * 每行输入 = 一次 dsh headless 调用(prompt = 该行原文);工作区跨行连续。
 */
import { execSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildHarnessCommand } from '../../node/src/driver/harness-driver.js';
import { resolveLocalDshRuntime } from './dsh-cmd.js';

export interface AgentTurnResult {
  code: number;
  stdout: string;
}

export interface AgentSessionOptions {
  /** 固定工作区(dsh 的调用目录,跨行连续) */
  workdir: string;
  /** 本机 dsh 命令(安装器标记 'dsh' = npm 全局运行时;或显式命令);缺省走 npx 通道 */
  dshCmd?: string;
  profile?: string;
  /** 输入源注入(测试);缺省 readline(逐行) */
  readLine?: () => Promise<string | null>;
  /** 输出注入(测试);缺省 process.stdout */
  write?: (text: string) => void;
  /** 执行注入(测试);缺省真实 spawn 本机 dsh */
  exec?: (cmd: string, args: string[], cwd: string | undefined, prompt: string) => Promise<AgentTurnResult>;
}

function defaultExec(cmd: string, args: string[], cwd: string | undefined): Promise<AgentTurnResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
      process.stdout.write(c); // 实时透传(边跑边看)
    });
    child.stderr.on('data', (c: Buffer) => process.stderr.write(c));
    child.on('error', (e) => {
      const msg = `dsh 启动失败:${e.message}`;
      process.stderr.write(msg + '\n');
      resolve({ code: 127, stdout: msg });
    });
    child.on('close', (code) => resolve({ code: code ?? 0, stdout }));
  });
}

/** Windows 下 npm 全局 'dsh' 是 .cmd 垫片,spawn 会 EINVAL → 解析真实 bin.js 用 node 跑。 */
function resolveDshInvocation(dshCmd: string | undefined, profile: string, line: string, workdir: string): { cmd: string; args: string[]; cwd: string | undefined } {
  if (dshCmd === 'dsh') {
    try {
      const root = execSync('npm root -g', { encoding: 'utf8', timeout: 10_000 }).trim();
      const binJs = join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (existsSync(binJs)) return { cmd: process.execPath, args: [binJs, '--profile', profile, line], cwd: workdir };
    } catch { /* npm 不可用 → npx 回退 */ }
  }
  const built = buildHarnessCommand(line, workdir);
  return { cmd: built.cmd, args: built.args, cwd: built.cwd };
}

/** 会话主循环:读一行 → 调一次本机 dsh → 展示;exit/quit/退出/Ctrl+D 结束。 */
export async function runAgentSession(opts: AgentSessionOptions): Promise<number> {
  mkdirSync(opts.workdir, { recursive: true });
  const write = opts.write ?? ((t: string) => process.stdout.write(t));
  const exec = opts.exec ?? ((cmd, args, cwd) => defaultExec(cmd, args, cwd));

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

  write(`🐉 龙 Agent 就绪(工作区 ${opts.workdir})\n`);
  write(`   直接输入目标,dsh 运行时执行;exit / Ctrl+D 结束。\n\n`);

  for (;;) {
    write('龙> ');
    const line = (await readLine())?.trim() ?? '';
    if (line === null || line === '') continue;
    if (line === 'exit' || line === 'quit' || line === '退出') { write('再见。\n'); return 0; }

    // 粘合层:原文转发给本机 dsh 运行时(不加工、不组装、不拦截)
    const invocation = resolveDshInvocation(opts.dshCmd, 'headless', line, opts.workdir);
    write(`⏳ dsh 执行中(${invocation.cmd === process.execPath ? '本地运行时' : invocation.cmd})…\n`);
    const turn = opts.exec
      ? await opts.exec(invocation.cmd, invocation.args, invocation.cwd, line)
      : await defaultExec(invocation.cmd, invocation.args, invocation.cwd);

    if (turn.code !== 0) write(`⚠️ dsh 退出码 ${turn.code}\n`);
    else write('✔ 完成\n');
  }
}
