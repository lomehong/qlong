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

/**
 * e2d-1:执行器在 SQL 事务外为每个 fence 解析出的运行上下文。驱动只消费已解析值,
 * 绝不自行派生工作区。cwd 缺省时驱动退回其静态 opts.workdir(向后兼容)。
 */
export interface RunContext {
  /** 执行器拥有的 per-fence 工作区绝对路径;驱动据此设定子进程 cwd。 */
  readonly cwd?: string;
}

/**
 * e2d-1:执行器拥有的 per-fence 工作区端口。生命周期严格在 SQL 事务外:
 * prepare 在 driver.start 前解析 cwd;release 在结果持久化提交后清理。
 * 两者均按精确 fence 幂等。release 失败由调用方按 best-effort 处理(清理失败
 * 是资源泄漏,绝不推翻已提交结果);取消/超时/恢复未证静默时不得提前 release。
 */
export interface ExecutorWorkspace {
  /** 事务外为精确 fence 创建/附着工作区,返回已解析运行上下文(含 cwd)。按 fence 幂等。 */
  prepare(fence: Readonly<RunFence>, offer: Record<string, unknown>): Promise<RunContext>;
  /** 结果持久化提交后释放该精确 fence 的工作区。幂等。 */
  release(fence: Readonly<RunFence>): Promise<void>;
}

/**
 * e2d-2:执行器完成路径的产物发布端口(镜像 ExecutorWorkspace)。严格在 SQL 事务外调用:
 * 执行器把已解析运行上下文(ctx.cwd)、任务契约(offer)与驱动产出的 result outcome 交给适配器,
 * 适配器读取声明文件、构建并签署 manifest、push 到共享产物仓,返回**注入了 body.artifacts 的**
 * 新 outcome。执行器保持通用(可用 Fake 测试);真正 git/文件 I/O 由 node/CLI 装配的适配器承担。
 * 发布失败必须抛错——执行器据此干净 task.fail(artifact_publish_failed),绝不把未发布产物伪装成成功交付。
 * 适配器自身须给 git I/O 设超时与字节预算,且异步等待不得同步阻塞事件循环(租约/取消轮询须继续)。
 */
export interface ArtifactPublisher {
  publish(
    fence: Readonly<RunFence>,
    offer: Record<string, unknown>,
    ctx: RunContext | undefined,
    outcome: RunOutcome,
  ): Promise<RunOutcome>;
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
  start(fence: Readonly<RunFence>, offer: Record<string, unknown>, ctx?: RunContext): Promise<RunHandle>;
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