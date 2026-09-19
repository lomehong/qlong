/**
 * qlong agent —— 单机的"龙"对话入口(粘合层):你输入目标,直接调本机 dsh 运行时执行。
 *
 * 设计边界(用户拍板,2026-09-19):**qlong 不做智能**。Agent 的实现就是 dsh 运行时本身;
 * qlong 只做粘合 —— 安装/定位 dsh、维持固定工作区、转发输入、展示输出。
 * 每行输入 = 一次 dsh headless 调用(prompt = 该行原文);工作区跨行连续。
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { buildHarnessCommand } from '../../node/src/driver/harness-driver.js';

export interface AgentTurnResult {
  code: number;
  stdout: string;
}

export interface AgentSessionOptions {
  /** 固定工作区(dsh 的调用目录,跨行连续) */
  workdir: string;
  /** 本机 dsh 命令(如安装器写入的 'dsh');缺省走 npx 通道 */
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
    child.on('error', (e) => resolve({ code: 127, stdout: `dsh 启动失败:${e.message}` }));
    child.on('close', (code) => resolve({ code: code ?? 0, stdout }));
  });
}

async function defaultReadLine(): Promise<string | null> {
  const chunks: Buffer[] = [];
  return new Promise((resolve) => {
    process.stdin.once('data', (c: Buffer) => {
      chunks.push(c);
      resolve(chunks[0]?.toString('utf8').trimEnd() ?? null);
    });
    process.stdin.once('end', () => resolve(null));
    process.stdin.resume();
  });
}

/** 会话主循环:读一行 → 调一次本机 dsh → 展示;exit/quit/退出/Ctrl+D 结束。 */
export async function runAgentSession(opts: AgentSessionOptions): Promise<number> {
  mkdirSync(opts.workdir, { recursive: true });
  const write = opts.write ?? ((t: string) => process.stdout.write(t));
  const readLine = opts.readLine ?? defaultReadLine;
  const exec = opts.exec ?? defaultExec;
  const profile = opts.profile ?? 'headless';

  write(`🐉 龙 Agent 就绪(工作区 ${opts.workdir})\n`);
  write(`   直接输入目标,dsh 运行时执行;exit / Ctrl+D 结束。\n\n`);

  for (;;) {
    write('龙> ');
    const line = (await readLine())?.trim() ?? '';
    if (line === null || line === '') continue;
    if (line === 'exit' || line === 'quit' || line === '退出') { write('再见。\n'); return 0; }

    // 粘合层:原文转发给本机 dsh 运行时(不加工、不组装、不拦截)
    const { cmd, args, cwd } = (() => {
      if (opts.dshCmd) {
        return { cmd: opts.dshCmd, args: ['--profile', profile, line], cwd: opts.workdir };
      }
      const built = buildHarnessCommand(line, opts.workdir);
      return { cmd: built.cmd, args: built.args, cwd: built.cwd };
    })();

    write(`⏳ dsh 执行中(${cmd})…\n`);
    const turn = opts.exec
      ? await opts.exec(cmd, args, cwd, line)
      : await defaultExec(cmd, args, cwd);

    if (turn.code !== 0) write(`⚠️ dsh 退出码 ${turn.code}\n`);
    else write('✔ 完成\n');
  }
}
