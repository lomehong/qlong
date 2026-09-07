import { describe, expect, it } from 'vitest';
import { Registry } from '../src/directory.js';

describe('审计日志存储(§11)', () => {
  it('logAudit + getAuditEvents 按团队过滤', () => {
    const r = new Registry({ now: () => Date.now() });
    r.logAudit('sig_verify_failed', 'n1', 'team-a', '验签失败', 'trace-1');
    r.logAudit('reclaim', 'n2', 'team-b', 'lease lost');
    r.logAudit('reclaim', 'n3', 'team-a', 'lease lost');
    const eventsA = r.getAuditEvents('team-a', 100);
    expect(eventsA).toHaveLength(2);
    expect(eventsA[0]!.event).toBe('sig_verify_failed');
    expect(eventsA[1]!.node).toBe('n3');
    const eventsB = r.getAuditEvents('team-b', 100);
    expect(eventsB).toHaveLength(1);
    expect(eventsB[0]!.reason).toBe('lease lost');
  });

  it('logAudit 超 10000 条自动裁剪', () => {
    const r = new Registry({ now: () => Date.now() });
    for (let i = 0; i < 10_005; i++) {
      r.logAudit('test', `n${i}`, 'team-x', `event-${i}`);
    }
    expect(r.auditLog.length).toBeLessThanOrEqual(10_000);
    const events = r.getAuditEvents('team-x', 100);
    expect(events).toHaveLength(100);
    expect(events[99].reason).toBe('event-10004');
  });
});