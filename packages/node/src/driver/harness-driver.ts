/**
 * deepseek-harness 真实基座适配层(v0.5,按上游真实契约重写)。
 *
 * 上游事实(来源:github.com/deepseek-ai/deepseek-harness README 与 apps/cli/README.md):
 * - npm 包:`@deepseek-ai/dsh`;入口命令 `dsh`;需 Node.js;developer preview(允许破坏性变更)
 * - 无人值守模式:`dsh --profile headless "<job>"` —— 跑一个一次性持久会话,
 *   把最终答案打到 stdout 后退出(退出码 0 = 成功)
 * - 工作区:调用目录(invoking directory)即默认工作区根 —— 驱动以任务工作区为 cwd
 * - 模型凭证:按上游文档在 profile/环境侧配置;本驱动透传 process.env,不碰凭证
 *
 * 本层契约:
 * - 默认命令:`npx --yes @deepseek-ai/dsh --profile headless <task>`(Windows 经 shell)
 * - DSH_HARNESS_CMD 覆盖(如全局安装的 dsh 或仓库 checkout 的启动脚本):此时不再走 npx 包装
 * - cwd = DriverTask.workdir(§8.4 WorkspaceManager 的工作区);无工作区 → 进程工作目录
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { ExecutorDriver, DriverHost, DriverTask } from '../executor/driver.js';

export interface HarnessDriverOptions {
  /** dsh 启动命令;缺省 npx;可被 env DSH_HARNESS_CMD 覆盖(全局安装的 dsh / 源码启动脚本) */
  harnessCmd?: string;
  /** npm 包名(npx 模式用);默认 @deepseek-ai/dsh;可被 env DSH_HARNESS_PKG 覆盖 */
  harnessPackage?: string;
  /** headless profile 名;默认 headless */
  profile?: string;
  /** 单任务超时 ms(默认 30 分钟;真实 LLM 任务耗时长) */
  taskTimeoutMs?: number;
  /** 测试/特殊部署:完整命令行覆盖(返回最终 spawn 的 cmd+args,prompt 已注入) */
  commandLine?: (prompt: string, workdir?: string) => { cmd: string; args: string[] };
}

const DEFAULT_PACKAGE = '@deepseek-ai/dsh';
const DEFAULT_PROFILE = 'headless';
/** stdout 保留的答案尾部上限(结果体瘦身) */
const STDOUT_TAIL = 4000;

/** 任务书组装(01 §4.2):summary 为主干,contract 验收项逐条列出,附时限提示 */
export function composeTaskPrompt(offer: Record<string, unknown>): string {
  const lines: string[] = [];
  const summary = typeof offer.summary === 'string' ? offer.summary : '';
  if (summary) lines.push(summary);
  const contract = offer.contract as
    | { deliverables?: Array<{ path?: string; artifact?: string; desc?: string }>; acceptance?: Array<{ check?: string; desc?: string }> }
    | undefined;
  if (contract && Array.isArray(contract.deliverables) && contract.deliverables.length > 0) {
    lines.push('', '交付物:');
    for (const d of contract.deliverables) {
      lines.push(`- ${d.path ?? d.artifact ?? '?'}${d.desc ? ` —— ${d.desc}` : ''}`);
    }
  }
  if (contract && Array.isArray(contract.acceptance) && contract.acceptance.length > 0) {
    lines.push('', '验收判据:');
    for (const a of contract.acceptance) {
      lines.push(`- ${a.check ?? a.desc ?? '?'}`);
    }
  }
  const deadline = typeof offer.deadline_ms === 'number' ? offer.deadline_ms : undefined;
  if (deadline !== undefined) {
    lines.push('', `(时限提示:请在约 ${Math.round(deadline / 1000)} 秒内完成,超时请尽早收束并说明进展)`);
  }
  return lines.join('\n').trim();
}

/** 构造最终 spawn 命令(npx 包装 / 覆盖命令两条路径) */
export function buildHarnessCommand(
  prompt: string,
  workdir: string | undefined,
  opts: HarnessDriverOptions = {},
): { cmd: string; args: string[]; cwd: string | undefined } {
  const override = opts.commandLine?.(prompt, workdir);
  if (override) return { ...override, cwd: workdir };
  const envCmd = process.env.DSH_HARNESS_CMD;
  const pkg = process.env.DSH_HARNESS_PKG ?? opts.harnessPackage ?? DEFAULT_PACKAGE;
  const profile = opts.profile ?? DEFAULT_PROFILE;
  const extraArgs = (process.env.DSH_HARNESS_ARGS ?? '')
    .split(' ')
    .map((s) => s.trim())
    .filter(Boolean);
  if (envCmd) {
    // 覆盖命令:全局 dsh / 源码启动脚本 —— 直接转发 profile 与任务书
    return { cmd: envCmd, args: [...extraArgs, '--profile', profile, prompt], cwd: workdir };
  }
  // 默认:npx 解析 npm 包(--yes 免交互确认)
  return { cmd: 'npx', args: ['--yes', pkg, ...extraArgs, '--profile', profile, prompt], cwd: workdir };
}

export class DeepSeekHarnessDriver implements ExecutorDriver {
  private proc: ChildProcess | null = null;
  private stopped = false;
  private cancelTimeout: (() => void) | null = null;
  private readonly opts: HarnessDriverOptions;
  private readonly timeoutMs: number;

  constructor(opts: HarnessDriverOptions = {}) {
    this.opts = opts;
    this.timeoutMs = opts.taskTimeoutMs ?? 1_800_000;
  }

  start(task: DriverTask, host: DriverHost): void {
    this.stopped = false;
    const prompt = composeTaskPrompt(task.offer);
    const workdir = typeof task.workdir === 'string' ? task.workdir : undefined;
    const { cmd, args, cwd } = buildHarnessCommand(prompt, workdir, this.opts);

    // 任务级硬上限:SIGTERM → 宽限 → SIGKILL(经 host.schedule,可随 stop 取消)
    const killAt = host.now() + this.timeoutMs;
    this.cancelTimeout = host.schedule(killAt, () => {
      if (!this.stopped && this.proc) {
        this.proc.kill('SIGTERM');
        host.schedule(host.now() + 5_000, () => {
          if (this.proc && this.proc.exitCode === null) this.proc.kill('SIGKILL');
        });
      }
    });

    this.proc = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && cmd === 'npx',
      env: { ...process.env, QLONG_TASK_ID: task.task_id, QLONG_ATTEMPT: String(task.attempt) },
    });

    let stdout = '';
    let stderr = '';
    if (this.proc.stdout) this.proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    if (this.proc.stderr) this.proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    this.proc.on('close', (code) => {
      this.cancelTimeout?.();
      if (this.stopped) return;
      if (code === 0) {
        const answer = stdout.trim();
        host.complete({
          summary: answer.slice(-STDOUT_TAIL) || '(无输出)',
          exit_code: 0,
          stderr_tail: stderr.trim().slice(-1000) || undefined,
        });
      } else {
        host.fail({
          reason_code: 'internal_error',
          retryable: true,
          summary: `dsh headless 退出码 ${code}`,
          diagnostics_ref: stderr.trim().slice(-2000) || undefined,
        });
      }
    });

    this.proc.on('error', (e: Error) => {
      this.cancelTimeout?.();
      if (!this.stopped) {
        host.fail({
          reason_code: 'internal_error',
          retryable: false,
          summary: 'dsh 启动失败:' + e.message,
        });
      }
    });
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimeout?.();
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill('SIGTERM');
      setTimeout(() => {
        if (this.proc && this.proc.exitCode === null) this.proc.kill('SIGKILL');
      }, 3_000);
    }
  }

  /** headless 为一次性进程:暂停 = SIGSTOP(非 Windows);恢复 = SIGCONT */
  pause(): void {
    if (this.proc && this.proc.exitCode === null && process.platform !== 'win32') {
      this.proc.kill('SIGSTOP');
    }
  }

  resume(): void {
    if (this.proc && this.proc.exitCode === null && process.platform !== 'win32') {
      this.proc.kill('SIGCONT');
    }
  }
}
