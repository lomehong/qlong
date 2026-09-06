/**
 * reason_code 登记表 —— 单一事实源。
 * 对应设计:01 篇 §4.3(评审 I-28)。
 * 元规则:未知码一律按 other 处理,不得报错;私有扩展码用 x- 前缀;新增标准码按同主版本兼容演进(§8)。
 */
export const REJECT_CODES = [
  'busy',
  'policy_denied',
  'unsupported_caps',
  'unsupported_version',
  'unsupported_type',
  'expired',
  'refused_loop',
  'stale_attempt',
  'other',
] as const;
export type RejectCode = (typeof REJECT_CODES)[number];

export const FAIL_CODES = [
  'deadline_exceeded',
  'caps_missing',
  'payload_unavailable',
  'payload_corrupt',
  'internal_error',
  'cancelled_by_peer',
  'other',
] as const;
export type FailCode = (typeof FAIL_CODES)[number];

/** 方向约束(§4.3):仅执行→牵头 / 双向 */
export const REJECT_DIRECTION: Record<RejectCode, 'executor_to_lead' | 'bidirectional'> = {
  busy: 'executor_to_lead',
  policy_denied: 'executor_to_lead',
  unsupported_caps: 'executor_to_lead',
  unsupported_version: 'bidirectional',
  unsupported_type: 'bidirectional',
  expired: 'executor_to_lead',
  refused_loop: 'executor_to_lead',
  stale_attempt: 'bidirectional',
  other: 'bidirectional',
};

export interface NormalizedCode<C extends string> {
  code: C;
  /** true = 原始码不在登记表(已按 other 处理,原始值应保留在 detail) */
  custom: boolean;
}

export function normalizeRejectCode(raw: string): NormalizedCode<RejectCode> {
  return (REJECT_CODES as readonly string[]).includes(raw)
    ? { code: raw as RejectCode, custom: false }
    : { code: 'other', custom: true };
}

export function normalizeFailCode(raw: string): NormalizedCode<FailCode> {
  return (FAIL_CODES as readonly string[]).includes(raw)
    ? { code: raw as FailCode, custom: false }
    : { code: 'other', custom: true };
}

/** R8:持久失败(本 task 生命周期内永久排除该节点) */
export function isPersistentReject(code: RejectCode): boolean {
  return code === 'unsupported_caps' || code === 'policy_denied' || code === 'refused_loop';
}