/**
 * v1 消息信封与校验器(01 篇 §3)。
 * 校验原则:只校验已知字段;未知字段一律放行(§8:同主版本新增字段必须被旧实现忽略)。
 * 数值域约束(D23):全信封整数,禁止浮点,|n| ≤ 2^53-1。
 */
import { isUuid, type TraceContext } from './ids.js';
import { DEFAULT_PARAMS, type QlongParams } from './params.js';

export interface SenderEndpoint {
  node_id: string;
  team_id?: string;
  agent_id?: string;
  key_epoch: number;
}

export interface ReceiverEndpoint {
  node_id: string;
  team_id?: string;
}

export interface Signature {
  /** v1 白名单:仅 ed25519(D23) */
  alg: string;
  /** base64(64 字节 ed25519 签名) */
  value: string;
}

export interface EnvelopeV1 {
  v: number;
  type: string;
  msg_id: string;
  /** 发送时刻,仅诊断(P5) */
  ts: string;
  /** 新鲜性地平线:task.* 必填(rpc.* 建议);exp = ts + exp_horizon(D24) */
  exp?: string;
  from: SenderEndpoint;
  to: ReceiverEndpoint;
  reply_to?: string;
  trace: TraceContext;
  /** task.* 必填,0..MAX_HOPS(§7) */
  hops?: number;
  task_id?: string;
  attempt?: number;
  /** task.* / rpc.* 必填(§3.3.1) */
  sig?: Signature;
  body: Record<string, unknown>;
}

const TYPE_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

export function familyOf(type: string): string {
  return type.split('.')[0] ?? '';
}

export const KNOWN_FAMILIES = ['task', 'rpc'] as const;
export function isKnownFamily(f: string): boolean {
  return (KNOWN_FAMILIES as readonly string[]).includes(f);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isRfc3339(v: unknown): v is string {
  return typeof v === 'string' && RFC3339_RE.test(v) && !Number.isNaN(Date.parse(v));
}

function isNonEmptyStr(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** D23:数值域全整数(禁止浮点/超 2^53 精度),深校验 */
function assertNoFloats(v: unknown, path: string, errors: string[]): void {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) errors.push(`${path}: 数值必须为安全整数(D23 禁止浮点)`);
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => assertNoFloats(x, `${path}[${i}]`, errors));
    return;
  }
  if (isPlainObject(v)) {
    for (const [k, x] of Object.entries(v)) assertNoFloats(x, `${path}.${k}`, errors);
  }
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export interface ValidateOptions {
  /** 签名前形态校验:发送方构造信封(尚无 sig)时使用;sig 存在仍会被校验 */
  allowMissingSig?: boolean;
}

export function validateEnvelope(
  raw: unknown,
  p: QlongParams = DEFAULT_PARAMS,
  opts: ValidateOptions = {},
): ValidationResult<EnvelopeV1> {
  const errors: string[] = [];
  const err = (m: string): void => {
    errors.push(m);
  };

  if (!isPlainObject(raw)) return { ok: false, errors: ['envelope: 必须为 JSON 对象'] };
  const e = raw as Record<string, unknown>;

  if (e.v !== 1) err('v: 必须为 1');
  if (typeof e.type !== 'string' || !TYPE_RE.test(e.type)) {
    err('type: 必须为小写点分命名 族.动作[.子动作]');
  }
  if (!isUuid(e.msg_id)) err('msg_id: 必须为 uuid');
  if (!isRfc3339(e.ts)) err('ts: 必须为 RFC3339');
  if (e.reply_to !== undefined && !isUuid(e.reply_to)) err('reply_to: 必须为 uuid');

  if (!isPlainObject(e.from)) {
    err('from: 必须为对象');
  } else {
    if (!isUuid(e.from.node_id)) err('from.node_id: 必须为 uuid');
    if (!Number.isSafeInteger(e.from.key_epoch) || (e.from.key_epoch as number) < 1) {
      err('from.key_epoch: 必须为 ≥1 的整数');
    }
    if (e.from.team_id !== undefined && !isNonEmptyStr(e.from.team_id)) err('from.team_id: 必须为非空字符串');
    if (e.from.agent_id !== undefined && !isNonEmptyStr(e.from.agent_id)) err('from.agent_id: 必须为非空字符串');
  }

  if (!isPlainObject(e.to)) {
    err('to: 必须为对象');
  } else {
    if (!isUuid(e.to.node_id)) err('to.node_id: 必须为 uuid');
    if (e.to.team_id !== undefined && !isNonEmptyStr(e.to.team_id)) err('to.team_id: 必须为非空字符串');
  }

  if (!isPlainObject(e.trace)) {
    err('trace: 必须为对象 {trace_id, parent_span, origin_node}');
  } else {
    const t = e.trace;
    if (!isUuid(t.trace_id)) err('trace.trace_id: 必须为 uuid');
    if (t.parent_span !== null && !isUuid(t.parent_span)) {
      err('trace.parent_span: 必须为 uuid 或 null(发起消息 hops=0 取 null,评审 I-43)');
    }
    if (!isUuid(t.origin_node)) err('trace.origin_node: 必须为 uuid');
  }

  const fam = typeof e.type === 'string' ? familyOf(e.type) : '';
  const isTask = fam === 'task';
  const isRpc = fam === 'rpc';

  if (e.hops !== undefined) {
    if (!Number.isSafeInteger(e.hops) || (e.hops as number) < 0) err('hops: 必须为 ≥0 整数');
    else if (isTask && (e.hops as number) > p.maxHops) err(`hops: 超过 MAX_HOPS=${p.maxHops}`);
  } else if (isTask) {
    err('hops: task.* 必填');
  }

  if (isTask) {
    if (!isUuid(e.task_id)) err('task_id: task.* 必填且必须为 uuid');
    if (!Number.isSafeInteger(e.attempt) || (e.attempt as number) < 1) err('attempt: task.* 必填且 ≥1');
  } else {
    if (e.task_id !== undefined && !isUuid(e.task_id)) err('task_id: 必须为 uuid');
    if (e.attempt !== undefined && (!Number.isSafeInteger(e.attempt) || (e.attempt as number) < 1)) {
      err('attempt: 必须为 ≥1 整数');
    }
  }

  if (e.exp !== undefined) {
    if (!isRfc3339(e.exp)) err('exp: 必须为 RFC3339');
  } else if (isTask) {
    err('exp: task.* 必填(D24)');
  }

  if (isTask || isRpc) {
    if (!isPlainObject(e.sig)) {
      if (!opts.allowMissingSig) err('sig: task.*/rpc.* 必填 {alg, value}(§3.3.1)');
    } else {
      const s = e.sig;
      if (s.alg !== 'ed25519') err('sig.alg: v1 白名单仅 ed25519(D23)');
      if (!isNonEmptyStr(s.value)) err('sig.value: 必须为 base64 字符串');
      else if (Buffer.from(s.value, 'base64').length !== 64) err('sig.value: ed25519 签名必须为 64 字节');
    }
  }

  if (!isPlainObject(e.body)) err('body: 必须为对象');
  assertNoFloats(raw, 'envelope', errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: raw as unknown as EnvelopeV1 };
}