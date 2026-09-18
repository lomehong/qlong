/**
 * 集群 claim 注册表(D1 / 02 §12.1 连接注册;设计见 docs/repair/CLUSTER-REGISTRY.md)。
 *
 * claim 是**归属仲裁层**(generation = fencing token,每 nodeId 单调),不是 payload 交付
 * 正确性层——custody 交付正确性由共享 SqliteCustodyStore + 周期泵兜底(设计 §1 约束 2)。
 *
 * 端口可替换(同 HttpClusterBus 哲学):d1a/d1b 用 LocalClaimRegistry(单 authority 内存);
 * d1c 换 SqliteClaimStore(中心侧共享、跨进程)。d1b 加入 TTL 租约(leaseExpiresAt/renew/
 * reapExpired)——authority-liveness 语义:网关侧定时器对活 socket 刷新租约,节点不发任何
 * 额外帧(§8 一致,不发明第二套节点心跳);半开/僵死的 authority 停止刷新 → 租约过期被
 * reapExpired 回收,令归属可判定。
 *
 * §8 一致性:claim 由持有活 socket 的网关自身登记/释放/续租,节点不发任何额外帧——这是
 * 节点级 presence 的跨进程持久化,不是第二套节点心跳。
 */

/** 一条连接归属 claim:哪个 authority 持有该 nodeId 的活连接,持的是哪一代 fencing token。 */
export interface Claim {
  nodeId: string;
  authorityId: string;
  /** 每 nodeId 单调递增(1-based;跨 release/reap/re-claim 绝不复用),分裂脑仲裁"高者恒胜"的令牌。 */
  generation: number;
  /** authority-liveness 租约到期时刻(ms epoch)。持有活 socket 的网关周期 renew 续期;过期则可被 reapExpired 回收。 */
  leaseExpiresAt: number;
}

/** claim 注册表端口(d1b:claim/lookup/release/renew/reapExpired;d1c 换共享实现)。 */
export interface ClaimRegistry {
  /**
   * 认领:generation = 该 nodeId 历史高水位 + 1(单调,永不复用),记录 {authorityId, generation},
   * 并盖上租约 leaseExpiresAt = now + leaseTtlMs。now 显式传入(匹配设计 §4.1 端口签名 + 兄弟
   * SqliteCustodyStore 风格 + d1c SQLite 事务实现需显式时刻)。
   */
  claim(nodeId: string, authorityId: string, now: number): Claim;
  /** 查现归属:返回当前活跃 claim;无(未认领/已释放/已 reap)→ undefined。 */
  lookup(nodeId: string): Claim | undefined;
  /** 释放:仅当现 claim == (authorityId, generation) 才删除并返回 true;被 fence(不匹配)→ false(不误删新主)。 */
  release(nodeId: string, authorityId: string, generation: number): boolean;
  /**
   * 续租:仅当现 claim == (authorityId, generation) 才把 leaseExpiresAt 推到 now + leaseTtlMs 并返回 true;
   * 被 fence(不匹配/未认领)→ false 且不改动——持有活 socket 的网关周期调用,返回 false 意味着自己已被
   * 更高 generation 超越(应丢弃该连接,见 ws.ts fence-drop)。
   */
  renew(nodeId: string, authorityId: string, generation: number, now: number): boolean;
  /**
   * 回收过期租约:删除所有 leaseExpiresAt <= now 的 claim,返回被删的 nodeId 列表。
   * **不删除 generation 高水位**——僵尸旧主即便租约过期被 reap,再次上线认领仍拿更高 generation,
   * 永不被误判为原主(fencing token 绝不复用)。存储铁律:仅回收过期租约,绝不触碰 custody pending。
   */
  reapExpired(now: number): string[];
}

/** LocalClaimRegistry 构造选项。 */
export interface LocalClaimRegistryOptions {
  /** authority-liveness 租约时长(ms)。必须为正安全整数;缺省 30_000。 */
  leaseTtlMs?: number;
}

/** 缺省租约时长:30s。远大于网关 renew 周期(≤100ms 级),容忍 GC/调度抖动而不误 reap 活连接。 */
export const DEFAULT_LEASE_TTL_MS = 30_000;

/** 校验并解析 leaseTtlMs(正安全整数,缺省 30s)——LocalClaimRegistry 与 SqliteClaimStore 共用,防两处漂移。 */
export function resolveLeaseTtlMs(value: number | undefined): number {
  const ttl = value ?? DEFAULT_LEASE_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0) {
    throw new RangeError(`leaseTtlMs must be a positive safe integer, got ${ttl}`);
  }
  return ttl;
}

/**
 * 单 authority 内存实现(d1a/d1b)。generation 高水位独立于活跃 claim 存储,故 release/reap 后
 * re-claim 仍单调递增——fencing token 绝不复用,防陈旧主(旧 generation)复活后被误判为新主。
 */
export class LocalClaimRegistry implements ClaimRegistry {
  private readonly claims = new Map<string, Claim>();
  /** 每 nodeId 的 generation 高水位;跨越 release/reapExpired 持续存在,保证单调且不复用。 */
  private readonly highWater = new Map<string, number>();
  private readonly leaseTtlMs: number;

  constructor(opts: LocalClaimRegistryOptions = {}) {
    this.leaseTtlMs = resolveLeaseTtlMs(opts.leaseTtlMs);
  }

  claim(nodeId: string, authorityId: string, now: number): Claim {
    const generation = (this.highWater.get(nodeId) ?? 0) + 1;
    this.highWater.set(nodeId, generation);
    const claim: Claim = { nodeId, authorityId, generation, leaseExpiresAt: now + this.leaseTtlMs };
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

  renew(nodeId: string, authorityId: string, generation: number, now: number): boolean {
    const current = this.claims.get(nodeId);
    // fence:非现主(authorityId/generation 不匹配)或未认领 → 拒绝续租,不改动现 claim。
    if (!current || current.authorityId !== authorityId || current.generation !== generation) return false;
    // 不可变更新:避免调用方持有的旧引用被就地篡改(Claim 值语义)。
    this.claims.set(nodeId, { ...current, leaseExpiresAt: now + this.leaseTtlMs });
    return true;
  }

  reapExpired(now: number): string[] {
    const expired: string[] = [];
    // 先收集后删除:避免迭代 Map 时删除当前项(尽管 JS 允许,显式收集更清晰且与 d1c SQLite 实现同构)。
    for (const [nodeId, claim] of this.claims) {
      if (claim.leaseExpiresAt <= now) expired.push(nodeId);
    }
    for (const nodeId of expired) {
      this.claims.delete(nodeId); // 不动 highWater:fencing token 跨 reap 持久,绝不复用。
    }
    return expired;
  }
}

