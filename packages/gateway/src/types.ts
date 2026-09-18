/** 网关域类型(02 §7/§8;01 §9 回执帧) */
import type { EnvelopeV1 } from '@qlong/core';

export interface GatewayDirectoryEntry {
  node_id: string;
  team_id: string;
  status: 'active' | 'suspended' | 'revoked';
  currentEpoch: number;
}

export interface GatewayGrantEntry {
  from_team: string;
  to_team: string;
  caps_visible: string[];
  expires_at?: number;
}

export interface GatewayDirectorySnapshot {
  epoch: number;
  nodes: GatewayDirectoryEntry[];
}

/** 连接身份:A3 握手(node token)通过后按目录钉扎 */
export interface GatewayConnection {
  connId: string;
  nodeId: string;
  teamId: string;
  connectedAt: number;
}

/**
 * 网关可见的信封视图:头 + body 的受限访问。
 * 设计明文允许的 body 访问仅两处:body.kind(01 §9 aid 不暂存判定)与
 * body.required_caps(D2 跨队派发侧能力闸,与执行侧闸3 同语义)。其余 body 字段网关不读。
 */
export interface EnvelopeHeadLite {
  msg_id: string;
  type: string;
  from: { node_id: string; team_id?: string; key_epoch: number };
  to: { node_id: string; team_id?: string };
  exp?: string;
  body: Record<string, unknown>;
  envelope: EnvelopeV1;
}

export interface GatewayAck {
  ack_type: 'delivered' | 'queued' | 'rejected';
  msg_id: string;
  reason?: string;
}

export interface RoutingDenied {
  rule: string;
  reason_code: string;
  msg_id: string;
}
/** D2:跨队 grant 查询返回活跃 grant 的 caps_visible 并集;undefined = 无 grant(失败关闭)。 */
export type GrantLookup = (fromTeam: string, toTeam: string) => string[] | undefined;
