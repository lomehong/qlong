/** 节点层出站消息规格(完整信封装配与签名由传输层完成,M2/M3) */
export interface Outbound {
  type: string;
  to_node: string;
  task_id?: string;
  attempt?: number;
  reply_to?: string;
  body: Record<string, unknown>;
}