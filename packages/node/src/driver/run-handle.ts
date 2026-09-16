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