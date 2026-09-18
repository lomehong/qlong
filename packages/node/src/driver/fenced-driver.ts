/**
 * FencedProcessDriver:把 harness 命令执行包装成 FencedDriver(RunHandle 协议)。
 * 一次 headless 进程 = 一个 fence 精确的 Run;句柄只存活于本进程,
 * recover 无法跨重启证明静默 → 一律 'unknown',由 DurableExecutor 安全转为
 * recovery_required(recover 绝不重放 start)。这是"受信内嵌驱动"的 fence 语义,
 * 不是进程/产物隔离(见 docs/repair/PROTOCOL-V2.md)。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { buildHarnessCommand, composeTaskPrompt, type HarnessDriverOptions } from './harness-driver.js';
import type { FencedDriver, RunFence, RunHandle, RunHandleStore, RunOutcome } from './run-handle.js';

/** stdout 保留的答案尾部上限(与旧驱动一致的结果体瘦身) */
const STDOUT_TAIL = 4000;
/** SIGTERM 后等待退出的宽限,超时 SIGKILL */
const KILL_GRACE_MS = 5_000;

export interface FencedProcessDriverOptions extends HarnessDriverOptions {
  /** 运行目录(§8.4 工作区语义);缺省 = 进程当前目录 */
  workdir?: string;
  /** 单任务硬上限 ms;0 = 不限(仍受执行器租约约束)。默认 30 分钟 */
  taskTimeoutMs?: number;
  /**
   * C1:run handle 持久化端口(驱动不拥有存储;由 node/CLI 以持久存储背书装配)。
   * 缺省 = 不持久化,recover 无法跨重启证明静默(退回恒 'unknown')。
   */
  runHandles?: RunHandleStore;
}

interface LiveProc {
  proc: ChildProcess;
  settled: boolean;
  stopped: boolean;
  timedOut: boolean;
}

function failed(summary: string, retryable = false): RunOutcome {
  return { kind: 'failed', body: { reason_code: 'other', retryable, summary } };
}

/**
 * 每次精确 fence 一个子进程。start 立即返回句柄(spawn 同步),真实退出经 closed 兑现;
 * stop 幂等,兑现即证明该进程已静默。不做任何存储/网络事务——事务由执行器负责。
 */
export class FencedProcessDriver implements FencedDriver {
  private readonly live = new Set<LiveProc>();

  constructor(private readonly opts: FencedProcessDriverOptions = {}) {}

  start = async (fence: Readonly<RunFence>, offer: Record<string, unknown>): Promise<RunHandle> => {
    const prompt = composeTaskPrompt(offer);
    const { cmd, args, cwd } = buildHarnessCommand(prompt, this.opts.workdir, this.opts);
    const timeoutMs = this.opts.taskTimeoutMs ?? 1_800_000;
    const state: LiveProc = { proc: null as unknown as ChildProcess, settled: false, stopped: false, timedOut: false };
    let resolveClosed!: (outcome: RunOutcome) => void;
    let resolveStopped!: () => void;
    const closed = new Promise<RunOutcome>((resolve) => { resolveClosed = resolve; });
    const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (outcome: RunOutcome): void => {
      if (state.settled) return;
      state.settled = true;
      clearTimeout(killTimer);
      this.live.delete(state);
      // 进程已静默:释放持久句柄(幂等)。recover 只在此前(未 settle)才需据句柄判定。
      this.opts.runHandles?.clear(fence);
      resolveClosed(outcome);
    };

    const proc = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && cmd === 'npx',
      env: {
        ...process.env,
        QLONG_TASK_ID: fence.task_id,
        QLONG_ATTEMPT: String(fence.attempt),
        QLONG_RUN_ID: fence.run_id,
      },
    });
    state.proc = proc;
    this.live.add(state);

    if (timeoutMs > 0) {
      killTimer = setTimeout(() => {
        if (state.settled || proc.exitCode !== null) return;
        state.timedOut = true;
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!state.settled && proc.exitCode === null) proc.kill('SIGKILL');
        }, KILL_GRACE_MS);
      }, timeoutMs);
      killTimer.unref();
    }

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', () => {
      // spawn 失败(如命令不存在):fail-closed,不重试 start(执行器契约)。
      finish(failed('driver spawn failed'));
    });
    proc.on('close', (code) => {
      if (state.stopped) {
        finish(failed('stopped by request'));
        return;
      }
      if (state.timedOut) {
        finish(failed('task timeout'));
        return;
      }
      if (code === 0) {
        const answer = stdout.trim();
        finish({ kind: 'result', body: {
          summary: answer.slice(-STDOUT_TAIL) || '(无输出)',
          exit_code: 0,
          ...(stderr.trim() ? { stderr_tail: stderr.trim().slice(-1000) } : {}),
        } });
      } else {
        finish({ kind: 'failed', body: {
          reason_code: 'internal_error',
          retryable: true,
          summary: `driver 进程退出码 ${code}`,
          ...(stderr.trim() ? { diagnostics_ref: stderr.trim().slice(-2000) } : {}),
        } });
      }
    });

    if (this.opts.runHandles && proc.pid !== undefined) {
      // C1a:落盘 fence→pid+启动证据,须在返回句柄前完成(崩溃安全次序)。
      try {
        this.opts.runHandles.record({ fence: { ...fence }, pid: proc.pid, startedAt: Date.now() });
      } catch (error) {
        // 持久化失败 = 失败关闭:SIGKILL 已 spawn 进程,绝不留下无句柄孤儿;start 拒绝,
        // 由执行器转 recovery_required + onFault(绝不重放 start)。settled 短路后续 close→finish。
        state.stopped = true;
        state.settled = true;
        clearTimeout(killTimer);
        this.live.delete(state);
        try { proc.kill('SIGKILL'); } catch { /* best effort */ }
        resolveClosed(failed('stopped by request'));
        throw error;
      }
    }

    return Object.freeze({
      fence: { ...fence },
      closed,
      stop: async (): Promise<void> => {
        state.stopped = true;
        if (state.settled || proc.exitCode !== null) { resolveStopped(); return; }
        proc.once('close', () => resolveStopped());
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!state.settled && proc.exitCode === null) proc.kill('SIGKILL');
        }, KILL_GRACE_MS);
        await stopped;
      },
    });
  };

  /** 一次性进程无跨重启句柄:永远无法证明静默。 */
  recover = async (_fence: Readonly<RunFence>): Promise<'stopped' | 'unknown'> => {
    void _fence;
    return 'unknown';
  };

  /** 宿主硬退出兜底:终止所有未静默进程(不影响执行器事务状态)。 */
  killAll(): void {
    for (const state of this.live) {
      if (state.settled || state.proc.exitCode !== null) continue;
      state.stopped = true;
      state.proc.kill('SIGKILL');
    }
  }
}
