/**
 * 上行 ACL 裁决(02 §7 A0/A1/A2 + A6 回声分级,D27/D28)。
 * 纯函数:输入连接身份 + 信封头 + 目录查询,输出路由/静默丢弃/可见拒绝。
 * P12:目录查不到 → 失败关闭。
 */
import { matchCaps } from '@qlong/core';
import type { GatewayConnection, GatewayDirectoryEntry, EnvelopeHeadLite } from './types.js';

export interface DirectoryLookup {
  /** D2:返回 from↔to 活跃 grant 的 caps_visible 并集;undefined = 无 grant(失败关闭)。 */
  grantLookup?: (fromTeam: string, toTeam: string) => string[] | undefined;
  snapshotEpoch: number;
  lookup(nodeId: string): GatewayDirectoryEntry | undefined;
}

export type AclVerdict =
  | { verdict: 'route'; toTeam: string }
  | { verdict: 'silent_drop'; rule: 'A0'; auditEvent: 'acl_rejected_from_pin'; reason: string }
  | {
      verdict: 'routing_denied';
      rule: 'A1' | 'A2';
      reasonCode: 'acl_rejected_cross_team' | 'acl_caps_not_granted' | 'not_team_member' | 'not_active';
      auditEvent: 'acl_rejected_cross_team' | 'not_active' | 'to_mismatch';
      reason: string;
    };

/** A0:from 钉扎 —— 自报 node/team 与连接身份不一致 = 伪造,静默丢弃 + 审计(诚实发送者无感) */
function checkFromPin(conn: GatewayConnection, head: EnvelopeHeadLite): AclVerdict | null {
  if (head.from.node_id !== conn.nodeId) {
    return { verdict: 'silent_drop', rule: 'A0', auditEvent: 'acl_rejected_from_pin', reason: 'from.node_id 与连接身份不符' };
  }
  if (head.from.team_id !== undefined && head.from.team_id !== conn.teamId) {
    return { verdict: 'silent_drop', rule: 'A0', auditEvent: 'acl_rejected_from_pin', reason: 'from.team_id 与连接归属不符' };
  }
  return null;
}

/**
 * D2:从 offer body 提取 required_caps 用于跨队派发侧能力闸。
 * undefined → [](无能力要求);非数组/含非串/含空串 → null(畸形,失败关闭 P12),
 * 与执行侧持久 executor 的 offer 校验(runtime/executor.ts 闸3)同语义。
 */
function requiredCapsOf(body: Record<string, unknown>): string[] | null {
  const rc = body.required_caps;
  if (rc === undefined) return [];
  if (!Array.isArray(rc) || !rc.every((c) => typeof c === 'string' && c.length > 0)) return null;
  return rc as string[];
}

export function evaluateUplink(args: {
  conn: GatewayConnection;
  head: EnvelopeHeadLite;
  dir: DirectoryLookup;
}): AclVerdict {
  const pin = checkFromPin(args.conn, args.head);
  if (pin) return pin;

  // A2:发送节点必须在目录且 active(以连接身份查目录,不信信封)
  const sender = args.dir.lookup(args.conn.nodeId);
  if (!sender || sender.status !== 'active') {
    return {
      verdict: 'routing_denied',
      rule: 'A2',
      reasonCode: 'not_active',
      auditEvent: 'not_active',
      reason: sender ? `发送节点状态 ${sender.status}` : '发送节点不在目录',
    };
  }

  // A1(评审 I-13/D27):to 恒以目录锚定;自报 to.team_id 仅一致性核对,不符 = 伪造信号
  const toTeam = args.dir.lookup(args.head.to.node_id);
  if (!toTeam) {
    return {
      verdict: 'routing_denied',
      rule: 'A1',
      reasonCode: 'not_team_member',
      auditEvent: 'to_mismatch',
      reason: '接收节点不在目录(P12 失败关闭)',
    };
  }
  if (args.head.to.team_id !== undefined && args.head.to.team_id !== toTeam.team_id) {
    return {
      verdict: 'routing_denied',
      rule: 'A1',
      reasonCode: 'acl_rejected_cross_team',
      auditEvent: 'acl_rejected_cross_team',
      reason: '自报 to.team_id 与目录归属不符(伪造信号)',
    };
  }
  if (sender.team_id !== toTeam.team_id) {
    // v0.2 D1:跨队需活跃 grant;D2:grant 进一步限定可见能力子集(03 §8/§10.4)
    const visible = args.dir.grantLookup?.(sender.team_id, toTeam.team_id);
    if (visible === undefined) {
      return {
        verdict: 'routing_denied',
        rule: 'A1',
        reasonCode: 'acl_rejected_cross_team',
        auditEvent: 'acl_rejected_cross_team',
        reason: '跨 team 投递被目录锚定拒绝(无 grant)',
      };
    }
    // 派发侧能力闸:与执行侧闸3 复用同一 matchCaps(core/caps.ts §3.2/D31,单一实现防语义分叉)
    const required = requiredCapsOf(args.head.body);
    if (required === null) {
      return {
        verdict: 'routing_denied',
        rule: 'A1',
        reasonCode: 'acl_caps_not_granted',
        auditEvent: 'acl_rejected_cross_team',
        reason: 'required_caps 畸形,失败关闭(P12)',
      };
    }
    const m = matchCaps(required, visible);
    if (!m.ok) {
      return {
        verdict: 'routing_denied',
        rule: 'A1',
        reasonCode: 'acl_caps_not_granted',
        auditEvent: 'acl_rejected_cross_team',
        reason: `跨 team 能力未授权:missing=${m.missing.join(',')}`,
      };
    }
    return { verdict: 'route', toTeam: toTeam.team_id };
  }
  return { verdict: 'route', toTeam: toTeam.team_id };
}
