/** task.lease.renew 业务租约契约:纯校验,无时钟读取、IO 或状态变更。 */
import { isUuid } from './ids.js';
import { isPlainObject } from './validate-utils.js';

export interface LeaseFence {
  task_id: string;
  attempt: number;
  generation: number;
  run_id: string;
}

export interface LeaseRenewalBody {
  generation: number;
  run_id: string;
  progress_msg_id: string;
  progress_seq: number;
  renewal_seq: number;
  /** 与 now/currentDeadlineMs 使用同一时钟域;信封层另行执行 D23 整数校验。 */
  deadline_ms: number;
}

function isPositiveSafeInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 所有已知字段必填;与 v1 信封一致,忽略未知扩展字段。 */
export function isLeaseFence(v: unknown): v is LeaseFence {
  return isPlainObject(v)
    && isUuid(v.task_id)
    && isPositiveSafeInteger(v.attempt)
    && isPositiveSafeInteger(v.generation)
    && isUuid(v.run_id);
}

/** 仅校验形状;deadline 的有效窗口由 canApplyLeaseRenewal 判定。 */
export function isLeaseRenewalBody(v: unknown): v is LeaseRenewalBody {
  return isPlainObject(v)
    && isPositiveSafeInteger(v.generation)
    && isUuid(v.run_id)
    && isUuid(v.progress_msg_id)
    && isPositiveSafeInteger(v.progress_seq)
    && isPositiveSafeInteger(v.renewal_seq)
    && isFiniteNumber(v.deadline_ms);
}

/**
 * 调用前必须验证 task.lease.renew 信封、签名及发送方为当前授权 lead,
 * 并严格绑定 envelope.task_id/attempt 到当前本地 fence。body 不含这两个字段,
 * 本函数不能拒绝仅信封 task_id/attempt 不匹配的消息(尤其旧 attempt)。
 * fence、待确认 progress、lastRenewalSeq 和 currentDeadlineMs 必须来自同一当前运行;
 * lastRenewalSeq 初始为 0。调用方须在应用时原子复核并更新这些状态。
 * renewal_seq 严格递增但允许跳号;progress_seq 只绑定待确认 progress,不能替代续租序号。
 * 待确认 progress 已撤销或消费后,调用方不得继续用旧 progressMsgId/progressSeq 授权续租。
 * 当前本地租约必须尚未过期:now === currentDeadlineMs 也拒绝,禁止过期后复活。
 * 所有时间值须属于同一时钟域;不将信封新鲜性或网关回执当作业务续租授权。
 */
export function canApplyLeaseRenewal(input: {
  body: unknown;
  fence: LeaseFence;
  progressMsgId: string;
  progressSeq: number;
  lastRenewalSeq: number;
  now: number;
  maxLeaseMs: number;
  currentDeadlineMs: number;
}): boolean {
  const { body, fence, progressMsgId, progressSeq, lastRenewalSeq, now, maxLeaseMs, currentDeadlineMs } = input;
  if (!isLeaseRenewalBody(body) || !isLeaseFence(fence)) return false;
  if (!isUuid(progressMsgId) || !isPositiveSafeInteger(progressSeq)) return false;
  if (!Number.isSafeInteger(lastRenewalSeq) || lastRenewalSeq < 0) return false;
  if (!isFiniteNumber(now) || !isFiniteNumber(currentDeadlineMs)) return false;
  if (!isFiniteNumber(maxLeaseMs) || maxLeaseMs <= 0) return false;

  const latestDeadlineMs = now + maxLeaseMs;
  return Number.isFinite(latestDeadlineMs)
    && body.generation === fence.generation
    && body.run_id === fence.run_id
    && body.progress_msg_id === progressMsgId
    && body.progress_seq === progressSeq
    && body.renewal_seq > lastRenewalSeq
    && now < currentDeadlineMs
    && now < body.deadline_ms
    && body.deadline_ms <= latestDeadlineMs;
}