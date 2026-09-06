/**
 * R0 attempt 统一闸门(01 §6 R0 / D25)—— 纯函数。
 * 所有入站 task.* 先于一切其他检查判 attempt。
 * 说明:调用方按 task_id 分桶后调用本函数(同 task 比较);
 * 「本地无此任务」以 localAttempt=null 表达。
 */
export interface GateInput {
  type: string;
  attempt: number;
}

export type GateVerdict =
  | { action: 'process' }
  /** < 当前:回 reject(stale_attempt)(已验签同 team 时)+ 审计 */
  | { action: 'reject_stale' }
  /** > 当前且为同 task 的 task.offer:隐式取消旧态、回 stale_attempt+旧态摘要,再按新 offer 评估(I-04③) */
  | { action: 'implicit_cancel' }
  /** > 当前其余类型:丢弃 + 审计 */
  | { action: 'drop' };

export function attemptGate(localAttempt: number | null | undefined, msg: GateInput): GateVerdict {
  if (localAttempt == null) return { action: 'process' };
  if (msg.attempt === localAttempt) return { action: 'process' };
  if (msg.attempt < localAttempt) return { action: 'reject_stale' };
  return msg.type === 'task.offer' ? { action: 'implicit_cancel' } : { action: 'drop' };
}