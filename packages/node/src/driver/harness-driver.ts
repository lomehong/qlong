/**
 * deepseek-harness 真实基座适配层(D3)。
 * 实现 ExecutorDriver 接口,spawn deepseek-harness CLI 进程执行任务。
 * v0.2:子进程管理 + 优雅终止 + 输出捕获。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ExecutorDriver, DriverHost, DriverTask } from '../executor/driver.js';

export interface HarnessDriverOptions {
  /** deepseek-harness CLI 路径(默认从 PATH 查找) */
  harnessCmd?: string;
  /** 单任务超时 ms(默认 300s) */
  taskTimeoutMs?: number;
}

export class DeepSeekHarnessDriver implements ExecutorDriver {
  private proc: ChildProcess | null = null;
  private stopped = false;
  private readonly cmd: string;
  private readonly timeoutMs: number;

  constructor(opts: HarnessDriverOptions = {}) {
    this.cmd = opts.harnessCmd ?? 'deepseek';
    this.timeoutMs = opts.taskTimeoutMs ?? 300_000;
  }

  start(task: DriverTask, host: DriverHost): void {
    this.stopped = false;
    const startedAt = host.now();

    // 用 deepseek CLI 执行,offer.summary 作为提示
    this.proc = spawn(this.cmd, ['--no-input', '--no-annotations'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: { ...process.env, QLONG_TASK_ID: task.task_id, QLONG_ATTEMPT: String(task.attempt) },
    });

    // 超时终止
    const timer = setTimeout(() => {
      if (!this.stopped && this.proc) {
        this.proc.kill('SIGTERM');
        setTimeout(() => { if (this.proc && !this.proc.killed) this.proc.kill('SIGKILL'); }, 5_000);
      }
    }, this.timeoutMs);

    let stdout = '';
    let stderr = '';
    if (this.proc.stdout) this.proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    if (this.proc.stderr) this.proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    this.proc.on('close', (code) => {
      clearTimeout(timer);
      if (this.stopped) return;
      if (code === 0) {
        host.complete({
          summary: stdout.trim().slice(-2000) || '(无输出)',
          exit_code: 0,
          stderr: stderr.slice(-1000) || undefined,
        });
      } else {
        host.fail({
          reason_code: 'internal_error',
          retryable: true,
          summary: `harness 退出码 ${code}`,
        });
      }
    });

    this.proc.on('error', (e) => {
      clearTimeout(timer);
      if (!this.stopped) {
        host.fail({ reason_code: 'internal_error', retryable: false, summary: 'harness 启动失败: ' + e.message });
      }
    });
  }
  stop(): void {
    this.stopped = true;
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill('SIGTERM');
      setTimeout(() => { if (this.proc && this.proc.exitCode === null) this.proc.kill('SIGKILL'); }, 3_000);
    }
  }

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