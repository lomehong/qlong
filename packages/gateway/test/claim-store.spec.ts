import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { newId } from '@qlong/core';
import { defineMigration, SqliteStore, StorageError, type SqliteStoreOptions } from '../../storage/src/index.js';
import { CLAIM_SQL, SqliteClaimStore } from '../src/claim-store.js';

/**
 * D1c:SqliteClaimStore——跨进程共享 claim 注册表(ClaimRegistry 端口的 SQLite 实现)。
 * 与 LocalClaimRegistry(d1a/b)语义一致,但 generation 高水位持久于 gateway_claim_seq(永不删除),
 * 故跨 release/reap/**进程重启**单调不复用(fencing token 铁律);损坏 fail-closed(recovery 非静默重建)。
 */
const NOW = Date.parse('2026-09-15T12:00:00.000Z');
const N = newId();
const stores = new Set<SqliteStore>();
const tempBase = realpathSync(tmpdir());
const roots = new Set<string>();
const schema = {
  id: 'qlong.claim-test',
  migrations: [defineMigration({ version: 1, name: 'claim', sql: CLAIM_SQL })],
};
type Options = NonNullable<ConstructorParameters<typeof SqliteClaimStore>[1]>;

function storageOptions(): SqliteStoreOptions {
  const root = mkdtempSync(join(tempBase, 'qlong-claim-'));
  roots.add(root);
  return {
    allowedBase: root, dataDir: join(root, 'data'), mode: 'create', schema,
    localFilesystemConfirmed: true, windowsAclConfirmed: true, busyTimeoutMs: 25,
  };
}

function open(options: SqliteStoreOptions): SqliteStore {
  const storage = SqliteStore.open(options);
  stores.add(storage);
  return storage;
}

function fixture(options: Options = {}) {
  const settings = storageOptions();
  let storage = open(settings);
  let claims = new SqliteClaimStore(storage, options);
  return {
    get storage() { return storage; },
    get claims() { return claims; },
    reopen() {
      storage.close();
      storage = open({ ...settings, mode: 'open' });
      claims = new SqliteClaimStore(storage, options);
      return claims;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const storage of [...stores].reverse()) storage.close();
  stores.clear();
  for (const root of roots) {
    if (dirname(root) !== tempBase || !basename(root).startsWith('qlong-claim-')) {
      throw new Error('Unsafe claim test cleanup target');
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  roots.clear();
});

describe('SqliteClaimStore (D1c: cross-process shared claim registry)', () => {
  it('claims at generation 1 and stamps leaseExpiresAt = now + ttl', () => {
    const f = fixture({ leaseTtlMs: 1_000 });
    expect(f.claims.claim(N, 'gwA', NOW))
      .toEqual({ nodeId: N, authorityId: 'gwA', generation: 1, leaseExpiresAt: NOW + 1_000 });
    expect(f.claims.lookup(N))
      .toEqual({ nodeId: N, authorityId: 'gwA', generation: 1, leaseExpiresAt: NOW + 1_000 });
  });

  it('increments generation monotonically on re-claim (contention serialized by the transaction)', () => {
    const f = fixture({ leaseTtlMs: 1_000 });
    expect(f.claims.claim(N, 'gwA', NOW).generation).toBe(1);
    expect(f.claims.claim(N, 'gwB', NOW).generation).toBe(2);
    expect(f.claims.claim(N, 'gwA', NOW).generation).toBe(3);
    expect(f.claims.lookup(N)).toMatchObject({ authorityId: 'gwA', generation: 3 });
  });

  it('persists generation high-water across release (fencing token never reused)', () => {
    const f = fixture({ leaseTtlMs: 1_000 });
    expect(f.claims.claim(N, 'gwA', NOW).generation).toBe(1);
    expect(f.claims.release(N, 'gwA', 1)).toBe(true);
    expect(f.claims.lookup(N)).toBeUndefined();
    expect(f.claims.claim(N, 'gwA', NOW).generation).toBe(2); // NOT 1 again
  });

  it('persists generation high-water across reapExpired (§4.3: gen+1 after reap)', () => {
    const f = fixture({ leaseTtlMs: 1_000 });
    expect(f.claims.claim(N, 'gwA', NOW).generation).toBe(1);
    expect(f.claims.reapExpired(NOW + 1_000)).toEqual([N]);
    expect(f.claims.lookup(N)).toBeUndefined();
    expect(f.claims.claim(N, 'gwB', NOW + 1_000).generation).toBe(2);
  });

  it('survives restart: active claim + high-water persist across reopen (the cross-process value)', () => {
    const f = fixture({ leaseTtlMs: 60_000 });
    expect(f.claims.claim(N, 'gwA', NOW).generation).toBe(1);
    const reopened = f.reopen();
    expect(reopened.lookup(N)).toMatchObject({ authorityId: 'gwA', generation: 1 }); // 活跃 claim 持久
    expect(reopened.claim(N, 'gwB', NOW).generation).toBe(2); // 高水位跨重启单调
  });

  it('renew by the current owner extends the lease; a stale generation/authority is fenced', () => {
    const f = fixture({ leaseTtlMs: 1_000 });
    f.claims.claim(N, 'gwA', NOW); // gen1, expires NOW+1000
    expect(f.claims.renew(N, 'gwA', 1, NOW + 400)).toBe(true);
    expect(f.claims.lookup(N)?.leaseExpiresAt).toBe(NOW + 1_400);
    f.claims.claim(N, 'gwB', NOW + 500); // gen2 supersedes
    expect(f.claims.renew(N, 'gwA', 1, NOW + 600)).toBe(false); // fenced
    expect(f.claims.lookup(N)).toMatchObject({ authorityId: 'gwB', generation: 2, leaseExpiresAt: NOW + 1_500 });
  });

  it('release with a stale generation/authority is a fenced no-op (never evicts the new owner)', () => {
    const f = fixture({ leaseTtlMs: 1_000 });
    f.claims.claim(N, 'gwA', NOW); // gen1
    f.claims.claim(N, 'gwB', NOW); // gen2
    expect(f.claims.release(N, 'gwA', 1)).toBe(false);
    expect(f.claims.lookup(N)).toMatchObject({ authorityId: 'gwB', generation: 2 });
    expect(f.claims.release(N, 'gwB', 2)).toBe(true);
    expect(f.claims.lookup(N)).toBeUndefined();
  });

  it('reapExpired removes only leases at/below now, keeps live ones, returns their nodeIds', () => {
    const f = fixture({ leaseTtlMs: 1_000 });
    const live = newId(), dead = newId();
    f.claims.claim(live, 'gwA', NOW); // expires NOW+1000
    f.claims.claim(dead, 'gwA', NOW); // expires NOW+1000
    expect(f.claims.renew(live, 'gwA', 1, NOW + 900)).toBe(true); // live expires NOW+1900
    expect(f.claims.reapExpired(NOW + 1_200)).toEqual([dead]);
    expect(f.claims.lookup(dead)).toBeUndefined();
    expect(f.claims.lookup(live)).toMatchObject({ nodeId: live, generation: 1 });
  });

  it('two authorities contend: higher generation wins, the lower is fenced on renew and release (§4.2)', () => {
    const f = fixture({ leaseTtlMs: 5_000 });
    f.claims.claim(N, 'gwA', NOW); // gen1 (A slow/partitioned)
    f.claims.claim(N, 'gwB', NOW + 10); // gen2 (N reconnects to B; shared table monotonic)
    expect(f.claims.lookup(N)).toMatchObject({ authorityId: 'gwB', generation: 2 });
    expect(f.claims.renew(N, 'gwA', 1, NOW + 20)).toBe(false); // A 被 fence
    expect(f.claims.release(N, 'gwA', 1)).toBe(false); // A 不能逐出新主
    expect(f.claims.lookup(N)).toMatchObject({ authorityId: 'gwB', generation: 2 });
  });

  it('rejects a leaseTtlMs that is not a positive safe integer', () => {
    const f = fixture();
    expect(() => new SqliteClaimStore(f.storage, { leaseTtlMs: 0 })).toThrow(RangeError);
    expect(() => new SqliteClaimStore(f.storage, { leaseTtlMs: -1 })).toThrow(RangeError);
    expect(() => new SqliteClaimStore(f.storage, { leaseTtlMs: 1.5 })).toThrow(RangeError);
  });

  it('faults (recovery, not silent rebuild) on a corrupt claim row at construction', () => {
    const f = fixture({ leaseTtlMs: 1_000 });
    f.claims.claim(N, 'gwA', NOW); // gen1, seq high-water 1
    // 损坏:generation 超过持久高水位(SQL CHECK 允许 >=1,但违反 claim<=seq 的应用不变量)。
    f.storage.database.prepare('UPDATE gateway_claim SET generation = 99 WHERE node_id = ?').run(N);
    expect(() => new SqliteClaimStore(f.storage, { leaseTtlMs: 1_000 })).toThrow(StorageError);
  });
});
