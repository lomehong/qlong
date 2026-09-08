/** 执行方接单闸(03 §6):闸2 策略 / 闸3 能力 / 闸4 负载。闸1 验签在传输层,闸5 档案 M4。 */
import type { RejectCode } from '@qlong/core';
import { matchCaps } from './caps.js';

export interface GateResult {
  ok: boolean;
  code?: RejectCode;
  detail?: Record<string, unknown>;
}

export type LocalPolicy = (
  offer: Record<string, unknown>,
) => { ok: true } | { ok: false; retry_after_ms?: number };

/** 闸2:本地策略(如夜间免打扰);跨队复核在传输/网关层(A5/A6) */
export function gatePolicy(policy: LocalPolicy | undefined, offer: Record<string, unknown>): GateResult {
  if (!policy) return { ok: true };
  const r = policy(offer);
  return r.ok
    ? { ok: true }
    : {
        ok: false,
        code: 'policy_denied',
        detail: r.retry_after_ms !== undefined ? { retry_after_ms: r.retry_after_ms } : undefined,
      };
}

/** 闸3:required_caps 逐条匹配,missing 明细反哺改派 */
export function gateCaps(requiredCaps: string[] | undefined, owned: string[]): GateResult {
  if (!requiredCaps || requiredCaps.length === 0) return { ok: true };
  const m = matchCaps(requiredCaps, owned);
  return m.ok ? { ok: true } : { ok: false, code: 'unsupported_caps', detail: { missing: m.missing } };
}

export interface LoadSnapshot {
  queueDepth: number;
  running: number;
  maxQueue: number;
  maxRunning: number;
  retryAfterMs?: number;
}

/** 闸4:负载阈值(accepting 快照只是礼貌提示,闸门在此) */
export function gateLoad(load: LoadSnapshot | undefined): GateResult {
  if (!load) return { ok: true };
  if (load.queueDepth > load.maxQueue || load.running > load.maxRunning) {
    return {
      ok: false,
      code: 'busy',
      detail: load.retryAfterMs !== undefined ? { retry_after_ms: load.retryAfterMs } : undefined,
    };
  }
  return { ok: true };
}