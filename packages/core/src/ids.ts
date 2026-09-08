/** 四 ID 体系与 trace(01 篇 §3.1/§7) */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/** msg_id / task_id / trace_id 等统一 uuid 生成 */
export function newId(): string {
  return globalThis.crypto.randomUUID();
}

export interface TraceContext {
  /** 一次用户任务的全链路;最初发起节点生成(§3.1) */
  trace_id: string;
  /** 发起消息(hops=0)取 null;转派时 = 触发转派的上游 msg_id(§7.3,评审 I-43) */
  parent_span: string | null;
  origin_node: string;
}

export function newTraceContext(originNode: string): TraceContext {
  return { trace_id: newId(), parent_span: null, origin_node: originNode };
}

/** 转派(§7.3):trace 三元组原样透传,仅 parent_span 指向触发转派的上游 msg_id */
export function forkTraceForDispatch(t: TraceContext, upstreamMsgId: string): TraceContext {
  return { trace_id: t.trace_id, parent_span: upstreamMsgId, origin_node: t.origin_node };
}