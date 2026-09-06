/**
 * 执行器驱动接口(M1.1)——单机执行模型的接缝。
 * v1 基座 = 原版 deepseek-harness(README);实现前由 ScriptStubDriver 桩顶替,隔离基座风险。
 * 驱动只负责「执行与终止」;心跳节奏/租约计时由执行方状态机调度(R3)。
 */
export interface DriverTask {
  task_id: string;
  attempt: number;
  offer: Record<string, unknown>;
}

export interface DriverHost {
  now(): number;
  /** 宿主时钟排程;返回取消函数 */
  schedule(atMs: number, cb: () => void): () => void;
  /** 驱动完成 → 执行方状态机 onDriverCompleted(R5 自检在那里) */
  complete(resultBody: Record<string, unknown>): void;
  /** 驱动失败 → 执行方状态机 onDriverFailed */
  fail(failBody: Record<string, unknown>): void;
}

export interface ExecutorDriver {
  start(task: DriverTask, host: DriverHost): void;
  stop(): void;
  pause(): void;
}

export interface StubScript {
  /** start 后 N 毫秒完成 */
  completeAfterMs?: number;
  resultBody?: Record<string, unknown>;
  failAfter?: { ms: number; body: Record<string, unknown> };
}

/**
 * 脚本桩驱动:确定性完成/失败;stop 取消未触发的回调。
 * 传数组时按 start 次序逐个消费(最后一个无限重复)——用于「第一次失败、改派后成功」等剧本。
 */
export class ScriptStubDriver implements ExecutorDriver {
  private host: DriverHost | null = null;
  private cancelFn: (() => void) | null = null;
  private stopped = false;
  private startedCount = 0;

  constructor(private readonly scripts: StubScript[]) {}

  start(task: DriverTask, host: DriverHost): void {
    void task;
    this.host = host;
    this.stopped = false;
    this.cancelFn = null;
    const startedAt = host.now();
    const script = this.scripts[Math.min(this.startedCount, this.scripts.length - 1)] as StubScript;
    this.startedCount += 1;
    if (script.completeAfterMs !== undefined) {
      const at = startedAt + script.completeAfterMs;
      this.cancelFn = host.schedule(at, () => {
        if (this.stopped) return;
        host.complete({ summary: 'stub 完成', ...(script.resultBody ?? {}) });
      });
    } else if (script.failAfter) {
      const failSpec = script.failAfter;
      const at = startedAt + failSpec.ms;
      this.cancelFn = host.schedule(at, () => {
        if (this.stopped) return;
        host.fail(failSpec.body);
      });
    }
  }

  stop(): void {
    this.stopped = true;
    this.cancelFn?.();
    this.cancelFn = null;
  }

  pause(): void {
    // 桩无副作用可暂停;真实驱动在此暂停产生新副作用(R3)
  }
}