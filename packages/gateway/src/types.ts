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

/** 网关可见的信封视图:头 + body.kind(01 §9 aid 不暂存是设计明文允许的唯一 body 访问) */
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
export type GrantLookup = (fromTeam: string, toTeam: string) => boolean;
