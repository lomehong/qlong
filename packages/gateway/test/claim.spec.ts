import { describe, expect, it } from 'vitest';
import { LocalClaimRegistry } from '../src/claim.js';

/**
 * D1a:单 authority claim 注册表地基——每 nodeId 单调 generation(fencing token)。
 * 纯数据结构;跨进程共享/分裂脑仲裁在 d1c(SqliteClaimStore),TTL 租约在 d1b。
 */
describe('LocalClaimRegistry (D1a: single-authority monotonic generation)', () => {
  it('claims an unclaimed node at generation 1 (1-based; undefined means never claimed)', () => {
    const reg = new LocalClaimRegistry();
    expect(reg.claim('node-1', 'gw1')).toEqual({ nodeId: 'node-1', authorityId: 'gw1', generation: 1 });
  });

  it('increments generation monotonically on each re-claim (reconnect supersedes)', () => {
    const reg = new LocalClaimRegistry();
    expect(reg.claim('node-1', 'gw1').generation).toBe(1);
    expect(reg.claim('node-1', 'gw1').generation).toBe(2);
    expect(reg.claim('node-1', 'gw1').generation).toBe(3);
  });

  it('tracks generation high-water per node independently', () => {
    const reg = new LocalClaimRegistry();
    expect(reg.claim('node-1', 'gw1').generation).toBe(1);
    expect(reg.claim('node-2', 'gw1').generation).toBe(1);
    expect(reg.claim('node-1', 'gw1').generation).toBe(2);
    expect(reg.claim('node-2', 'gw1').generation).toBe(2);
  });

  it('lookup returns the current claim, or undefined when unclaimed', () => {
    const reg = new LocalClaimRegistry();
    expect(reg.lookup('node-1')).toBeUndefined();
    reg.claim('node-1', 'gw1');
    expect(reg.lookup('node-1')).toEqual({ nodeId: 'node-1', authorityId: 'gw1', generation: 1 });
  });

  it('release by the current owner (matching generation) removes the claim', () => {
    const reg = new LocalClaimRegistry();
    reg.claim('node-1', 'gw1');
    expect(reg.release('node-1', 'gw1', 1)).toBe(true);
    expect(reg.lookup('node-1')).toBeUndefined();
  });

  it('release with a stale generation is a fenced no-op (never evicts the current owner)', () => {
    const reg = new LocalClaimRegistry();
    reg.claim('node-1', 'gwA'); // gen 1
    reg.claim('node-1', 'gwB'); // gen 2 — supersede (reconnect elsewhere)
    expect(reg.release('node-1', 'gwA', 1)).toBe(false);
    expect(reg.lookup('node-1')).toEqual({ nodeId: 'node-1', authorityId: 'gwB', generation: 2 });
  });

  it('release of an unclaimed node is a no-op', () => {
    const reg = new LocalClaimRegistry();
    expect(reg.release('node-1', 'gw1', 1)).toBe(false);
  });

  it('generation never resets or reuses across release + re-claim (high-water persists)', () => {
    const reg = new LocalClaimRegistry();
    expect(reg.claim('node-1', 'gw1').generation).toBe(1);
    expect(reg.release('node-1', 'gw1', 1)).toBe(true);
    expect(reg.claim('node-1', 'gw1').generation).toBe(2); // NOT 1 again — fencing token must not repeat
  });
});
