/**
 * 群龙 v1 默认参数表 —— 单一事实源。
 * 对应设计:docs/QLONG_DESIGN_01_MSG_PROTOCOL.md §10。
 * 约束:改值必须先回写设计文档;代码与文档同源。
 */
export interface QlongParams {
  /** offer_ttl_ms:project 60s / aid 10s(§10) */
  offerTtlMsProject: number;
  offerTtlMsAid: number;
  /** lease_ms:project 300s / aid 120s(评审 I-40) */
  leaseMsProject: number;
  leaseMsAid: number;
  /** 判 lost 宽限(评审 I-07) */
  graceMs: number;
  /** 回收后的赛跑窗口;重连后重新打开(R3/R4) */
  drainMs: number;
  /** cancelling 出口超时(评审 I-06) */
  cancelWaitMs: number;
  /** exp 漂移预算 10 分钟(D24) */
  expDriftBudgetMs: number;
  /** exp 地平线 24h:exp = ts + exp_horizon(D24) */
  expHorizonMs: number;
  /** 已接受后失败改派上限 / 未接受过改派上限(R7) */
  maxAttempts: number;
  maxDispatchRounds: number;
  /** 委托深度上限(§7) */
  maxHops: number;
  /** body 内联上限,超出走 payload_ref(R10) */
  maxBodyInlineBytes: number;
}

export const DEFAULT_PARAMS: QlongParams = {
  offerTtlMsProject: 60_000,
  offerTtlMsAid: 10_000,
  leaseMsProject: 300_000,
  leaseMsAid: 120_000,
  graceMs: 30_000,
  drainMs: 30_000,
  cancelWaitMs: 30_000,
  expDriftBudgetMs: 10 * 60 * 1000,
  expHorizonMs: 24 * 60 * 60 * 1000,
  maxAttempts: 3,
  maxDispatchRounds: 3,
  maxHops: 8,
  maxBodyInlineBytes: 256 * 1024,
};

export type TaskKind = 'aid' | 'project';

export function defaultOfferTtlMs(kind: TaskKind, p: QlongParams = DEFAULT_PARAMS): number {
  return kind === 'aid' ? p.offerTtlMsAid : p.offerTtlMsProject;
}

export function defaultLeaseMs(kind: TaskKind, p: QlongParams = DEFAULT_PARAMS): number {
  return kind === 'aid' ? p.leaseMsAid : p.leaseMsProject;
}

/** 心跳间隔 = lease/3(R3) */
export function heartbeatIntervalMs(leaseMs: number): number {
  return Math.floor(leaseMs / 3);
}

/** R3 lost 判定:自最后一个应收心跳的预计时刻起 2×间隔 + grace_ms */
export function lostAfterMs(leaseMs: number, p: QlongParams = DEFAULT_PARAMS): number {
  return 2 * heartbeatIntervalMs(leaseMs) + p.graceMs;
}

/** R1 去重状态保留期下限:max(offer_ttl, lease) × max_attempts + drain_ms */
export function dedupRetentionMs(kind: TaskKind, p: QlongParams = DEFAULT_PARAMS): number {
  return Math.max(defaultOfferTtlMs(kind, p), defaultLeaseMs(kind, p)) * p.maxAttempts + p.drainMs;
}

/** R3 不变式:grace_ms ≤ lease_ms − 2×(lease_ms/3) —— 违反即实现配置错误 */
export function assertLeaseInvariant(leaseMs: number, p: QlongParams = DEFAULT_PARAMS): void {
  if (!(p.graceMs <= leaseMs - 2 * heartbeatIntervalMs(leaseMs))) {
    throw new Error(
      `R3 不变式被违反:grace_ms(${p.graceMs}) > lease_ms(${leaseMs}) - 2×heartbeat(${heartbeatIntervalMs(leaseMs)})`,
    );
  }
}