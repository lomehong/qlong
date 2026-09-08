/**
 * GatewayCluster(02 §12.1 网关集群化 v1)。
 *
 * 三件套对应:
 * - 连接注册:成员网关上报 has(nodeId)(连接表权威,"谁持有谁的连接");
 * - 分片路由:离线邮箱按 FNV-1a(nodeId) 稳定归属 home 分片网关 —— 节点永远知道
 *   自己的离线邮件在哪;在线投递走连接表直投(不经分片);
 * - 收件箱:落 home 分片网关的 InboxStore(持久化演进位:FileMailboxStore)。
 *
 * 部署形态 v1:同进程多网关实例(外部 LB 均分连接);跨进程总线(Redis pub/sub)
 * 列为 v0.8——route 接口已按"可替换传输"设计。
 */
import type { EnvelopeV1 } from '@qlong/core';
import type { GatewayCore } from './core.js';

export interface ClusterMember {
  name: string;
  core: GatewayCore;
  /** 该网关是否持有节点连接(连接表) */
  has: (nodeId: string) => boolean;
  /** 向该节点在线连接推送 */
  deliver: (nodeId: string, envelope: EnvelopeV1) => void;
}

export type ClusterRouteOutcome = 'delivered' | 'queued' | 'unknown';

export class GatewayCluster {
  private readonly members: ClusterMember[] = [];

  register(member: ClusterMember): number {
    this.members.push(member);
    return this.members.length - 1;
  }

  get size(): number {
    return this.members.length;
  }

  /** FNV-1a 稳定分片(成员数变化前,同一 nodeId 永远映射同一 home) */
  shardOf(nodeId: string): ClusterMember | undefined {
    if (this.members.length === 0) return undefined;
    let h = 0x811c9dc5;
    for (let i = 0; i < nodeId.length; i++) {
      h ^= nodeId.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return this.members[h % this.members.length];
  }

  /**
   * 集群路由(source 网关已完成 ACL,deferOffline 落到此):
   * 任一成员在线持有目标 → 直投('delivered');
   * 否则 → home 分片入箱('queued');无成员 → 'unknown'(调用方本地兜底)。
   */
  route(envelope: EnvelopeV1, toNodeId: string, now: number): ClusterRouteOutcome {
    if (this.members.length === 0) return 'unknown';
    for (const m of this.members) {
      if (m.has(toNodeId)) {
        m.deliver(toNodeId, envelope);
        return 'delivered';
      }
    }
    const home = this.shardOf(toNodeId);
    if (!home) return 'unknown';
    home.core.queueInbox(envelope, now);
    return 'queued';
  }
}
