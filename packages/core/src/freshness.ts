/**
 * 新鲜性与有效期判定(P5 唯一豁免 = exp,其余全部相对时长)。
 */
import { DEFAULT_PARAMS } from './params.js';

/**
 * exp 判废弃(评审 I-02/D24):接收时刻 ≤ exp + 漂移预算 判有效;
 * 「晚于」即过期(R2 同款判向)。exp 不可解析 → 按过期处置(静默丢弃 + 审计)。
 */
export function isExpiredByExp(
  exp: string,
  receivedAtMs: number,
  driftBudgetMs: number = DEFAULT_PARAMS.expDriftBudgetMs,
): boolean {
  const expMs = Date.parse(exp);
  if (Number.isNaN(expMs)) return true;
  return receivedAtMs > expMs + driftBudgetMs;
}

/** R2:offer_ttl 判过期 —— 「晚于」TTL 才过期(评审 I-38),起点 = 执行方本地收到时刻 */
export function isExpiredByTtl(startedAtMs: number, ttlMs: number, nowMs: number): boolean {
  return nowMs > startedAtMs + ttlMs;
}