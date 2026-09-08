import { describe, expect, it } from 'vitest';
import { attemptGate } from '../src/attempt-gate.js';
import { AUDIT_EVENTS, envelopeHeadDigest, logCorrelationFields, makeAudit } from '../src/audit.js';
import type { EnvelopeV1 } from '../src/envelope.js';
import { DedupStore } from '../src/dedup.js';
import { isExpiredByExp, isExpiredByTtl } from '../src/freshness.js';
import {
  DEFAULT_PARAMS,
  assertLeaseInvariant,
  dedupRetentionMs,
  heartbeatIntervalMs,
  lostAfterMs,
} from '../src/params.js';
import { REJECT_DIRECTION, isPersistentReject, normalizeFailCode, normalizeRejectCode } from '../src/reason-codes.js';

describe('R0 attempt 闸门(D25)', () => {
  const msg = { type: 'task.result', attempt: 2 };
  it('本地无此任务 → process', () => {
    expect(attemptGate(null, msg)).toEqual({ action: 'process' });
  });
  it('attempt 相等 → process', () => {
    expect(attemptGate(2, msg)).toEqual({ action: 'process' });
  });
  it('attempt 小于当前 → reject_stale', () => {
    expect(attemptGate(3, msg)).toEqual({ action: 'reject_stale' });
  });
  it('大于当前且为 task.offer → implicit_cancel(I-04③ 改派回原节点的取消信号)', () => {
    expect(attemptGate(1, { type: 'task.offer', attempt: 2 })).toEqual({ action: 'implicit_cancel' });
  });
  it('大于当前且非 offer → drop', () => {
    expect(attemptGate(1, { type: 'task.result', attempt: 2 })).toEqual({ action: 'drop' });
  });
});

describe('R1 去重(评审 I-01)', () => {
  it('first → duplicate;progress 豁免;同键异体 → mismatch', () => {
    const store = new DedupStore(3_600_000);
    const body = { a: 1 };
    expect(store.checkAndRecord('t', 1, 'task.offer', body)).toEqual({ verdict: 'first' });
    expect(store.checkAndRecord('t', 1, 'task.offer', body)).toEqual({ verdict: 'duplicate' });
    expect(store.checkAndRecord('t', 1, 'task.progress', { state: 'working' })).toEqual({ verdict: 'first' });
    expect(store.checkAndRecord('t', 1, 'task.progress', { state: 'working' })).toEqual({ verdict: 'first' });
    expect(store.checkAndRecord('t', 1, 'task.offer', { a: 2 })).toEqual({ verdict: 'mismatch' });
  });

  it('保留期逐出(注入时钟;下限 = max(ttl,lease)×max_attempts + drain)', () => {
    let now = 1_000_000;
    const store = new DedupStore(5_000, () => now);
    store.checkAndRecord('t', 1, 'task.result', {});
    expect(store.size).toBe(1);
    now += 5_001;
    store.checkAndRecord('t', 2, 'task.result', {});
    expect(store.size).toBe(1);
  });

  it('body 键序不影响等价判定(JCS 归一)', () => {
    const store = new DedupStore(3_600_000);
    store.checkAndRecord('t', 1, 'task.offer', { x: 1, y: 2 });
    expect(store.checkAndRecord('t', 1, 'task.offer', { y: 2, x: 1 })).toEqual({ verdict: 'duplicate' });
  });
});

describe('新鲜性(D24/R2)', () => {
  const exp = '2026-09-06T12:00:00Z';
  const expMs = Date.parse(exp);
  it('exp:恰在预算边界内有效;晚于预算即过期', () => {
    expect(isExpiredByExp(exp, expMs + DEFAULT_PARAMS.expDriftBudgetMs)).toBe(false);
    expect(isExpiredByExp(exp, expMs + DEFAULT_PARAMS.expDriftBudgetMs + 1)).toBe(true);
  });
  it('exp 不可解析 → 按过期处置(静默丢弃+审计)', () => {
    expect(isExpiredByExp('not-a-time', 0)).toBe(true);
  });
  it('R2 offer_ttl:「晚于」才过期(评审 I-38)', () => {
    expect(isExpiredByTtl(1000, 10_000, 11_000)).toBe(false);
    expect(isExpiredByTtl(1000, 10_000, 11_001)).toBe(true);
  });
});

describe('§10 参数与不变式', () => {
  it('心跳 = lease/3;lost = 2×间隔 + grace(project 230s / aid 110s)', () => {
    expect(heartbeatIntervalMs(300_000)).toBe(100_000);
    expect(lostAfterMs(300_000)).toBe(230_000);
    expect(lostAfterMs(120_000)).toBe(110_000);
  });
  it('R3 不变式:默认配置成立;grace 过大即实现配置错误', () => {
    expect(() => assertLeaseInvariant(300_000)).not.toThrow();
    expect(() => assertLeaseInvariant(120_000)).not.toThrow();
    expect(() => assertLeaseInvariant(60_000)).toThrow(/R3 不变式/);
  });
  it('去重保留期下限', () => {
    expect(dedupRetentionMs('project')).toBe(300_000 * 3 + 30_000);
    expect(dedupRetentionMs('aid')).toBe(120_000 * 3 + 30_000);
  });
});

describe('§4.3 码表(评审 I-28)', () => {
  it('未知码一律按 other(元规则)', () => {
    expect(normalizeRejectCode('weird')).toEqual({ code: 'other', custom: true });
    expect(normalizeRejectCode('busy')).toEqual({ code: 'busy', custom: false });
    expect(normalizeFailCode('nope')).toEqual({ code: 'other', custom: true });
  });
  it('方向约束与持久失败(R8)', () => {
    expect(REJECT_DIRECTION.stale_attempt).toBe('bidirectional');
    expect(REJECT_DIRECTION.busy).toBe('executor_to_lead');
    expect(isPersistentReject('unsupported_caps')).toBe(true);
    expect(isPersistentReject('policy_denied')).toBe(true);
    expect(isPersistentReject('busy')).toBe(false);
  });
});

describe('§11 审计与日志关联(评审 I-33/I-34)', () => {
  const env = {
    v: 1,
    type: 'task.offer',
    msg_id: '77777777-7777-4777-8777-777777777777',
    ts: '2026-09-06T12:00:00+08:00',
    exp: '2026-09-07T12:00:00+08:00',
    from: {
      node_id: '11111111-1111-4111-8111-111111111111',
      team_id: '33333333-3333-4333-8333-333333333333',
      key_epoch: 3,
    },
    to: { node_id: '22222222-2222-4222-8222-222222222222', team_id: '33333333-3333-4333-8333-333333333333' },
    trace: {
      trace_id: '55555555-5555-4555-8555-555555555555',
      parent_span: null,
      origin_node: '11111111-1111-4111-8111-111111111111',
    },
    hops: 0,
    task_id: '66666666-6666-4666-8666-666666666666',
    attempt: 1,
    sig: { alg: 'ed25519', value: 'x' },
    body: { kind: 'aid', summary: 's' },
  } as unknown as EnvelopeV1;

  it('头摘要不随 body 变化(P3:中心只见头)', () => {
    const e1 = { ...env, body: { kind: 'aid', summary: 's1' } } as EnvelopeV1;
    const e2 = { ...env, body: { kind: 'aid', summary: 's2' } } as EnvelopeV1;
    expect(envelopeHeadDigest(e1)).toBe(envelopeHeadDigest(e2));
    expect(envelopeHeadDigest(e1)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('makeAudit:事件枚举/头摘要/时间注入', () => {
    const rec = makeAudit(
      'stale_attempt_rejected',
      { node_id: env.to.node_id, envelope: env, task_id: env.task_id, attempt: 2, reason: 'r0' },
      () => '2026-09-06T12:00:00Z',
    );
    expect(AUDIT_EVENTS).toContain(rec.event);
    expect(rec.envelope_head_digest).toMatch(/^[0-9a-f]{32}$/);
    expect(rec.ts).toBe('2026-09-06T12:00:00Z');
    expect(rec.attempt).toBe(2);
  });

  it('日志关联五字段:trace_id/task_id/attempt/msg_id/key_epoch', () => {
    const f = logCorrelationFields(env);
    expect(Object.keys(f).sort()).toEqual(['attempt', 'key_epoch', 'msg_id', 'task_id', 'trace_id']);
  });
});