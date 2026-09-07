import { describe, expect, it } from 'vitest';
import { backoffDelay, shouldReconnect, ConnTracker, DEFAULT_WEAK_NET } from '../src/weak-net.js';

describe('弱网增强(§8.6)', () => {
  it('backoffDelay:指数增长 + 不超 max', () => {
    const d0 = backoffDelay(0);
    const d5 = backoffDelay(5);
    const d20 = backoffDelay(20);
    expect(d0).toBeGreaterThan(0);
    expect(d5).toBeGreaterThan(d0);
    expect(d20).toBeLessThanOrEqual(DEFAULT_WEAK_NET.maxBackoffMs * (1 + DEFAULT_WEAK_NET.jitterRatio));
  });

  it('shouldReconnect:达上限后 false', () => {
    expect(shouldReconnect(0)).toBe(true);
    expect(shouldReconnect(DEFAULT_WEAK_NET.maxReconnectAttempts)).toBe(false);
  });

  it('ConnTracker:状态切换 + 离线时长', () => {
    const ct = new ConnTracker();
    expect(ct.current).toBe('disconnected');
    ct.set('connected');
    expect(ct.current).toBe('connected');
    expect(ct.offlineDurationMs).toBe(0);
    ct.set('disconnected');
    expect(ct.current).toBe('disconnected');
    expect(ct.offlineDurationMs).toBeGreaterThanOrEqual(0);
  });
});