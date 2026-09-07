/**
 * 统一审计与可观测性基线(01 §11,评审 I-33/I-34)。
 * 只记信封头摘要,不记 body(P3)。
 */
import type { EnvelopeV1 } from './envelope.js';
import { sha256Hex } from './hash.js';
import { jcs } from './jcs.js';

export const AUDIT_EVENTS = [
  'sig_verify_failed',
  'exp_rejected',
  'to_mismatch',
  'not_active',
  'acl_rejected_from_pin',
  'acl_rejected_cross_team',
  'dedup_mismatch',
  'stale_attempt_rejected',
  'reclaim',
  'escalate',
  'cap_tag_suspected',
  'cap_tag_removed',
  'cap_tag_recovered',
] as const;
export type AuditEvent = (typeof AUDIT_EVENTS)[number];

export interface AuditRecord {
  event: AuditEvent;
  /** 诊断时刻(P5:不参与任何顺序/过期判断) */
  ts: string;
  node_id: string;
  reason?: string;
  /** JCS(剔除 body 后的信封)的 sha256 前 32 hex —— 可复核且不含 body */
  envelope_head_digest?: string;
  trace_id?: string;
  task_id?: string;
  attempt?: number;
}

export function envelopeHeadDigest(env: EnvelopeV1): string {
  const { body: _body, ...head } = env;
  return sha256Hex(jcs(head)).slice(0, 32);
}

export interface AuditFields {
  node_id: string;
  reason?: string;
  envelope?: EnvelopeV1;
  trace_id?: string;
  task_id?: string;
  attempt?: number;
}

export function makeAudit(
  event: AuditEvent,
  fields: AuditFields,
  nowIso: () => string = () => new Date().toISOString(),
): AuditRecord {
  const rec: AuditRecord = { event, ts: nowIso(), node_id: fields.node_id };
  if (fields.reason !== undefined) rec.reason = fields.reason;
  if (fields.envelope) rec.envelope_head_digest = envelopeHeadDigest(fields.envelope);
  if (fields.trace_id !== undefined) rec.trace_id = fields.trace_id;
  if (fields.task_id !== undefined) rec.task_id = fields.task_id;
  if (fields.attempt !== undefined) rec.attempt = fields.attempt;
  return rec;
}

/** 日志关联规范(01 §11):每条任务相关日志必须含以下字段,缺字段视为日志缺陷 */
export function logCorrelationFields(env: EnvelopeV1): Record<string, unknown> {
  return {
    trace_id: env.trace.trace_id,
    task_id: env.task_id,
    attempt: env.attempt,
    msg_id: env.msg_id,
    key_epoch: env.from.key_epoch,
  };
}