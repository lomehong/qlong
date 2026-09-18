import { describe, expect, it } from 'vitest';
import { LocalClaimRegistry } from '../src/claim.js';

/**
 * D1a:单 authority claim 注册表地基——每 nodeId 单调 generation(fencing token)。
 * D1b:authority-liveness TTL 租约——leaseExpiresAt/renew/reapExpired(§8 一致:网关侧刷新,节点不发帧)。
 * 纯数据结构;跨进程共享/分裂脑仲裁在 d1c(SqliteClaimStore)。
 */
describe('LocalClaimRegistry (D1a: single-authority monotonic generation)', () => {
  it('claims an unclaimed node at generation 1 (1-based; undefined means never claimed)', () => {
    const reg = new LocalClaimRegistry();
    expect(reg.claim('node-1', 'gw1', 0)).toMatchObject({ nodeId: 'node-1', authorityId: 'gw1', generation: 1 });
  });

  it('increments generation monotonically on each re-claim (reconnect supersedes)', () => {
    const reg = new LocalClaimRegistry();
    expect(reg.claim('node-1', 'gw1', 0).generation).toBe(1);
    expect(reg.claim('node-1', 'gw1', 0).generation).toBe(2);
    expect(reg.claim('node-1', 'gw1', 0).generation).toBe(3);
  });

  it('tracks generation high-water per node independently', () => {
    const reg = new LocalClaimRegistry();
    expect(reg.claim('node-1', 'gw1', 0).generation).toBe(1);
    expect(reg.claim('node-2', 'gw1', 0).generation).toBe(1);
    expect(reg.claim('node-1', 'gw1', 0).generation).toBe(2);
    expect(reg.claim('node-2', 'gw1', 0).generation).toBe(2);
  });

  it('lookup returns the current claim, or undefined when unclaimed', () => {
    const reg = new LocalClaimRegistry();
    expect(reg.lookup('node-1')).toBeUndefined();
    reg.claim('node-1', 'gw1', 0);
    expect(reg.lookup('node-1')).toMatchObject({ nodeId: 'node-1', authorityId: 'gw1', generation: 1 });
  });

  it('release by the current owner (matching generation) removes the claim', () => {
    const reg = new LocalClaimRegistry();
    reg.claim('node-1', 'gw1', 0);
    expect(reg.release('node-1', 'gw1', 1)).toBe(true);
    expect(reg.lookup('node-1')).toBeUndefined();
  });

  it('release with a stale generation is a fenced no-op (never evicts the current owner)', () => {
    const reg = new LocalClaimRegistry();
    reg.claim('node-1', 'gwA', 0); // gen 1
    reg.claim('node-1', 'gwB', 0); // gen 2 — supersede (reconnect elsewhere)
    expect(reg.release('node-1', 'gwA', 1)).toBe(false);
    expect(reg.lookup('node-1')).toMatchObject({ nodeId: 'node-1', authorityId: 'gwB', generation: 2 });
  });

  it('release of an unclaimed node is a no-op', () => {
    const reg = new LocalClaimRegistry();
    expect(reg.release('node-1', 'gw1', 1)).toBe(false);
  });

  it('generation never resets or reuses across release + re-claim (high-water persists)', () => {
    const reg = new LocalClaimRegistry();
    expect(reg.claim('node-1', 'gw1', 0).generation).toBe(1);
    expect(reg.release('node-1', 'gw1', 1)).toBe(true);
    expect(reg.claim('node-1', 'gw1', 0).generation).toBe(2); // NOT 1 again — fencing token must not repeat
  });
});

describe('LocalClaimRegistry (D1b: authority-liveness TTL lease)', () => {
  it('claim stamps leaseExpiresAt = now + ttl', () => {
    const reg = new LocalClaimRegistry({ leaseTtlMs: 1_000 });
    expect(reg.claim('n', 'gw', 500)).toEqual({ nodeId: 'n', authorityId: 'gw', generation: 1, leaseExpiresAt: 1_500 });
  });

  it('renew by the current owner extends the lease and returns true', () => {
    const reg = new LocalClaimRegistry({ leaseTtlMs: 1_000 });
    reg.claim('n', 'gw', 0); // expires 1000
    expect(reg.renew('n', 'gw', 1, 400)).toBe(true);
    expect(reg.lookup('n')?.leaseExpiresAt).toBe(1_400); // 400 + 1000
  });

  it('renew with a stale generation is fenced (false, lease + owner unchanged)', () => {
    const reg = new LocalClaimRegistry({ leaseTtlMs: 1_000 });
    reg.claim('n', 'gwA', 0); // gen 1, expires 1000
    reg.claim('n', 'gwB', 0); // gen 2, expires 1000 (supersede)
    expect(reg.renew('n', 'gwA', 1, 400)).toBe(false);
    expect(reg.lookup('n')).toEqual({ nodeId: 'n', authorityId: 'gwB', generation: 2, leaseExpiresAt: 1_000 });
  });

  it('renew of an unclaimed node returns false', () => {
    const reg = new LocalClaimRegistry({ leaseTtlMs: 1_000 });
    expect(reg.renew('n', 'gw', 1, 0)).toBe(false);
  });

  it('reapExpired removes only leases at/below now and returns their nodeIds', () => {
    const reg = new LocalClaimRegistry({ leaseTtlMs: 1_000 });
    reg.claim('live', 'gw', 0); // expires 1000
    reg.claim('dead', 'gw', 0); // expires 1000
    expect(reg.renew('live', 'gw', 1, 900)).toBe(true); // live expires 1900
    expect(reg.reapExpired(1_200)).toEqual(['dead']); // dead(1000)<=1200 reaped; live(1900)>1200 kept
    expect(reg.lookup('dead')).toBeUndefined();
    expect(reg.lookup('live')).toMatchObject({ nodeId: 'live', generation: 1 });
  });

  it('reapExpired keeps a lease whose expiry is strictly after now', () => {
    const reg = new LocalClaimRegistry({ leaseTtlMs: 1_000 });
    reg.claim('n', 'gw', 0); // expires 1000
    expect(reg.reapExpired(999)).toEqual([]);
    expect(reg.lookup('n')).toBeDefined();
  });

  it('generation high-water survives reapExpired (re-claim after reap continues monotonic — a zombie old gen stays fenced)', () => {
    const reg = new LocalClaimRegistry({ leaseTtlMs: 1_000 });
    expect(reg.claim('n', 'gw', 0).generation).toBe(1);
    expect(reg.reapExpired(2_000)).toEqual(['n']); // lease expired → reaped
    expect(reg.lookup('n')).toBeUndefined();
    expect(reg.claim('n', 'gw', 2_000).generation).toBe(2); // NOT 1 again
  });

  it('rejects a leaseTtlMs that is not a positive safe integer', () => {
    expect(() => new LocalClaimRegistry({ leaseTtlMs: 0 })).toThrow(RangeError);
    expect(() => new LocalClaimRegistry({ leaseTtlMs: -1 })).toThrow(RangeError);
    expect(() => new LocalClaimRegistry({ leaseTtlMs: 1.5 })).toThrow(RangeError);
  });
});
