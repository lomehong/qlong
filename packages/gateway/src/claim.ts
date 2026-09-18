/**
 * 集群 claim 注册表(D1 / 02 §12.1 连接注册;设计见 docs/repair/CLUSTER-REGISTRY.md)。
 *
 * claim 是**归属仲裁层**(generation = fencing token,每 nodeId 单调),不是 payload 交付
 * 正确性层——custody 交付正确性由共享 SqliteCustodyStore + 周期泵兜底(设计 §1 约束 2)。
 *
 * 端口可替换(同 HttpClusterBus 哲学):d1a/d1b 用 LocalClaimRegistry(单 authority 内存);
 * d1c 换 SqliteClaimStore(中心侧共享、跨进程)。TTL 租约(renew/reapExpired/leaseExpiresAt)
 * 在 d1b 加入端口;此处仅 d1a 子集(claim/lookup/release + 单调 generation)。
 *
 * §8 一致性:claim 由持有活 socket 的网关自身登记/释放,节点不发任何额外帧——这是节点级
 * presence 的跨进程持久化,不是第二套节点心跳。
 */

/** 一条连接归属 claim:哪个 authority 持有该 nodeId 的活连接,持的是哪一代 fencing token。 */
export interface Claim {
  nodeId: string;
  authorityId: string;
  /** 每 nodeId 单调递增(1-based;跨 release/re-claim 绝不复用),分裂脑仲裁"高者恒胜"的令牌。 */
  generation: number;
}

/** claim 注册表端口(d1a 子集:claim/lookup/release;d1b 加 TTL 租约,d1c 换共享实现)。 */
export interface ClaimRegistry {
  /** 认领:generation = 该 nodeId 历史高水位 + 1(单调,永不复用),记录 {authorityId, generation}。 */
  claim(nodeId: string, authorityId: string): Claim;
  /** 查现归属:返回当前活跃 claim;无(未认领/已释放)→ undefined。 */
  lookup(nodeId: string): Claim | undefined;
  /** 释放:仅当现 claim == (authorityId, generation) 才删除并返回 true;被 fence(不匹配)→ false(不误删新主)。 */
  release(nodeId: string, authorityId: string, generation: number): boolean;
}

/**
 * 单 authority 内存实现(d1a/d1b)。generation 高水位独立于活跃 claim 存储,故 release 后
 * re-claim 仍单调递增——fencing token 绝不复用,防陈旧主(旧 generation)复活后被误判为新主。
 */
export class LocalClaimRegistry implements ClaimRegistry {
  private readonly claims = new Map<string, Claim>();
  /** 每 nodeId 的 generation 高水位;跨越 release 持续存在,保证单调且不复用。 */
  private readonly highWater = new Map<string, number>();

  claim(nodeId: string, authorityId: string): Claim {
    const generation = (this.highWater.get(nodeId) ?? 0) + 1;
    this.highWater.set(nodeId, generation);
    const claim: Claim = { nodeId, authorityId, generation };
    this.claims.set(nodeId, claim);
    return claim;
  }

  lookup(nodeId: string): Claim | undefined {
    return this.claims.get(nodeId);
  }

  release(nodeId: string, authorityId: string, generation: number): boolean {
    const current = this.claims.get(nodeId);
    // fence:authorityId 或 generation 不匹配(已被更高 generation 超越)→ 拒绝删除,保护新主。
    if (!current || current.authorityId !== authorityId || current.generation !== generation) return false;
    this.claims.delete(nodeId);
    return true;
  }
}
