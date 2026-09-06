/**
 * 网关回执帧与路由拒绝帧(01 §9/D26;02 §7 A6)。
 * 回执仅用于诊断与改派触发判定,不参与可靠性——不构成第二套真相。
 */
import { isPlainObject } from './validate-utils.js';

export interface GatewayAckFrame {
  ack_type: 'delivered' | 'queued' | 'rejected';
  msg_id: string;
  /** rejected 时:offline_not_stored / acl_rejected / expired … */
  reason?: string;
}

export interface RoutingDeniedFrame {
  /** 命中的执法规则,如 A1/A2/A6 */
  rule: string;
  reason_code: string;
  msg_id: string;
}

export function isGatewayAck(v: unknown): v is GatewayAckFrame {
  if (!isPlainObject(v)) return false;
  const okType = v.ack_type === 'delivered' || v.ack_type === 'queued' || v.ack_type === 'rejected';
  return okType && typeof v.msg_id === 'string' && (v.reason === undefined || typeof v.reason === 'string');
}

export function isRoutingDenied(v: unknown): v is RoutingDeniedFrame {
  return (
    isPlainObject(v) &&
    typeof v.rule === 'string' &&
    typeof v.reason_code === 'string' &&
    typeof v.msg_id === 'string'
  );
}