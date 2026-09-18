/** Logical fencing for trusted embedded/test drivers, NOT process or artifact isolation. */
export interface RunFence {
  readonly task_id: string;
  readonly attempt: number;
  readonly generation: number;
  readonly run_id: string;
}

export interface RunOutcome {
  kind: 'result' | 'failed';
  body: Record<string, unknown>;
}

export interface RunHandle {
  /** Immutable identity; stop must target this handle, never a driver's mutable current run. */
  readonly fence: Readonly<RunFence>;
  /** Fulfillment proves this run is quiescent. Rejection is NOT proof of closure. */
  readonly closed: Promise<RunOutcome>;
  /** Fulfillment confirms quiescence, even if closed has not fulfilled. Must be idempotent. */
  stop(): Promise<void>;
}

export interface FencedDriver {
  /**
   * Rejection or timeout is ambiguous: never retry start. The runtime bounds its wait and
   * stops a late returned handle; drivers must return promptly or provide exact-fence recovery.
   * Async waiting must not synchronously block the event loop (lease/cancel polling continues).
   */
  start(fence: Readonly<RunFence>, offer: Record<string, unknown>): Promise<RunHandle>;
  /** 'stopped' proves quiescence of this exact fence, including across driver restarts; timeout is unknown. */
  recover(fence: Readonly<RunFence>): Promise<'stopped' | 'unknown'>;
}

/**
 * C1:一个精确 fence 的落盘启动证据,跨驱动重启存活,使 recover 能把恒 'unknown'
 * 收敛为可判定。pid 是 OS 进程号;startedAt 是驱动侧 spawn 时的墙钟(ms),
 * 供诊断与将来的身份/TTL 判定——单独不构成静默证明。
 */
export interface PersistedRunHandle {
  readonly fence: Readonly<RunFence>;
  readonly pid: number;
  readonly startedAt: number;
}

/**
 * run handle 持久化端口。驱动不拥有存储;由装配方(node/CLI)以持久存储背书。
 * 同步语义:record 必须在 start 返回前完成(崩溃安全次序),且驱动在 SQL 事务外调用。
 */
export interface RunHandleStore {
  /** 在 start 返回前为精确 fence 记录活句柄;须按 fence 幂等。 */
  record(handle: PersistedRunHandle): void;
  /** 该精确 fence 的持久句柄;若从未记录则 undefined。 */
  load(fence: Readonly<RunFence>): PersistedRunHandle | undefined;
  /** run 静默(settle)后丢弃句柄;须幂等。 */
  clear(fence: Readonly<RunFence>): void;
}