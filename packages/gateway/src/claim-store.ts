import { isUuid } from '@qlong/core';
import { StorageError, type SqliteStore } from '../../storage/src/index.js';
import { resolveLeaseTtlMs, type Claim, type ClaimRegistry } from './claim.js';

/**
 * SqliteClaimStore(D1c):ClaimRegistry 端口的中心侧共享实现——跨进程/跨重启的连接归属注册表。
 * 与 LocalClaimRegistry(d1a/b)语义完全一致,差别仅在持久化(设计 docs/repair/CLUSTER-REGISTRY.md §4.1):
 *
 * - generation 高水位存于**独立 `gateway_claim_seq` 表**(永不删除)。`claim` 在单事务内
 *   `INSERT … ON CONFLICT DO UPDATE SET last_generation = last_generation + 1 RETURNING`(原子自增,
 *   并发由 BEGIN IMMEDIATE 串行化)→ 以该 generation UPSERT `gateway_claim` 活跃行。
 * - `release`/`reapExpired` 只删 `gateway_claim` 活跃行、**绝不动 seq**——fencing token 跨
 *   release/reap/**进程重启**绝不复用(§4.1/§4.3;与 LocalClaimRegistry 的 claims+highWater 双 Map 同构)。
 * - 损坏 fail-closed:构造时校验全表(含跨表不变量 `last_generation >= generation`),违反即抛
 *   StorageError('DATABASE_CORRUPT')进入 recovery,绝不静默重建(存储铁律 §3)。
 *
 * 存储铁律:claim 表**无 payload**;reapExpired 只回收已过期租约,绝不触碰 custody pending(不同表)。
 * 不拥有/关闭 storage(同 SqliteCustodyStore)。
 */

/** Schema fragment only. The center must append a migration before constructing the store. */
export const CLAIM_SQL = `
CREATE TABLE gateway_claim (
  node_id TEXT NOT NULL CHECK (length(node_id) = 36),
  authority_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  claimed_at INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL CHECK (lease_expires_at >= claimed_at),
  PRIMARY KEY (node_id)
) STRICT;
-- generation 高水位(单调,永不删除):release/reap 只删上面的活跃行,此表保证 fencing token 绝不复用。
CREATE TABLE gateway_claim_seq (
  node_id TEXT NOT NULL CHECK (length(node_id) = 36),
  last_generation INTEGER NOT NULL CHECK (last_generation >= 1),
  PRIMARY KEY (node_id)
) STRICT;
`;

/** SqliteClaimStore 构造选项。 */
export interface ClaimStoreOptions {
  /** authority-liveness 租约时长(ms)。必须为正安全整数;缺省 30_000(与 LocalClaimRegistry 同源)。 */
  leaseTtlMs?: number;
}

function requireValid(condition: unknown): asserts condition {
  // Never include persisted values in recovery errors.
  if (!condition) throw new StorageError('DATABASE_CORRUPT', 'Invalid claim state; explicit recovery required');
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000;
}

function validGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** Validate a persisted claim row and project it to the Claim value type (claimed_at stays internal). */
function load(raw: Record<string, unknown>): Claim {
  requireValid(isUuid(raw.node_id) && typeof raw.authority_id === 'string' && raw.authority_id.length > 0 &&
    validGeneration(raw.generation) && validTime(raw.claimed_at) && validTime(raw.lease_expires_at) &&
    raw.lease_expires_at >= raw.claimed_at);
  return {
    nodeId: raw.node_id as string,
    authorityId: raw.authority_id as string,
    generation: raw.generation as number,
    leaseExpiresAt: raw.lease_expires_at as number,
  };
}

export class SqliteClaimStore implements ClaimRegistry {
  private readonly leaseTtlMs: number;

  constructor(private readonly store: SqliteStore, options: ClaimStoreOptions = {}) {
    this.leaseTtlMs = resolveLeaseTtlMs(options.leaseTtlMs);
    // Fail-closed on any corrupt/inconsistent row before serving: recovery, never silent rebuild.
    store.transaction((db) => {
      for (const raw of db.prepare(`SELECT c.node_id, c.authority_id, c.generation, c.claimed_at,
          c.lease_expires_at, s.last_generation
        FROM gateway_claim c LEFT JOIN gateway_claim_seq s ON s.node_id = c.node_id`).iterate()) {
        const claim = load(raw);
        const last = (raw as Record<string, unknown>).last_generation;
        // Cross-table invariant: the persisted high-water must dominate every active claim's generation.
        requireValid(typeof last === 'number' && Number.isSafeInteger(last) && last >= 1 && last >= claim.generation);
      }
    });
  }

  claim(nodeId: string, authorityId: string, now: number): Claim {
    if (!isUuid(nodeId) || typeof authorityId !== 'string' || authorityId.length === 0 || !validTime(now)) {
      throw new TypeError('claim requires a UUID nodeId, a nonempty authorityId and a safe-integer now');
    }
    const leaseExpiresAt = now + this.leaseTtlMs;
    return this.store.transaction<Claim>((db) => {
      // Atomic monotonic bump: contention is serialized by BEGIN IMMEDIATE, so a generation never repeats.
      const bumped = db.prepare(`INSERT INTO gateway_claim_seq (node_id, last_generation) VALUES (?, 1)
        ON CONFLICT(node_id) DO UPDATE SET last_generation = last_generation + 1
        RETURNING last_generation`).get(nodeId);
      requireValid(bumped !== undefined);
      const generation = bumped.last_generation;
      requireValid(validGeneration(generation));
      db.prepare(`INSERT INTO gateway_claim
        (node_id, authority_id, generation, claimed_at, lease_expires_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET authority_id = excluded.authority_id, generation = excluded.generation,
          claimed_at = excluded.claimed_at, lease_expires_at = excluded.lease_expires_at`)
        .run(nodeId, authorityId, generation, now, leaseExpiresAt);
      return { nodeId, authorityId, generation, leaseExpiresAt };
    });
  }

  lookup(nodeId: string): Claim | undefined {
    if (!isUuid(nodeId)) return undefined;
    return this.store.transaction<Claim | undefined>((db) => {
      const raw = db.prepare('SELECT * FROM gateway_claim WHERE node_id = ?').get(nodeId);
      return raw ? load(raw) : undefined;
    });
  }

  release(nodeId: string, authorityId: string, generation: number): boolean {
    if (!isUuid(nodeId) || typeof authorityId !== 'string' || !validGeneration(generation)) return false;
    // Fence by (authorityId, generation): a stale owner cannot evict the current one. seq is untouched.
    return this.store.transaction<boolean>((db) =>
      db.prepare('DELETE FROM gateway_claim WHERE node_id = ? AND authority_id = ? AND generation = ?')
        .run(nodeId, authorityId, generation).changes === 1);
  }

  renew(nodeId: string, authorityId: string, generation: number, now: number): boolean {
    if (!isUuid(nodeId) || typeof authorityId !== 'string' || !validGeneration(generation) || !validTime(now)) return false;
    // Fence by (authorityId, generation); a match pushes the lease to now + ttl (matches LocalClaimRegistry).
    return this.store.transaction<boolean>((db) =>
      db.prepare('UPDATE gateway_claim SET lease_expires_at = ? WHERE node_id = ? AND authority_id = ? AND generation = ?')
        .run(now + this.leaseTtlMs, nodeId, authorityId, generation).changes === 1);
  }

  reapExpired(now: number): string[] {
    if (!validTime(now)) return [];
    return this.store.transaction<string[]>((db) => {
      const rows = db.prepare('SELECT * FROM gateway_claim WHERE lease_expires_at <= ? ORDER BY rowid').all(now);
      // Validate before release: corruption must not be concealed by GC (mirrors custody prune).
      const expired = rows.map((raw) => load(raw).nodeId);
      // Only the active rows go; gateway_claim_seq (the fencing high-water) is never touched.
      db.prepare('DELETE FROM gateway_claim WHERE lease_expires_at <= ?').run(now);
      return expired;
    });
  }
}
