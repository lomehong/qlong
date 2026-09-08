import { describe, expect, it } from 'vitest';
import { LeadTaskMachine, type LeadAction } from '../src/lead/machine.js';

const TASK = '66666666-6666-4666-8666-666666666666';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '44444444-4444-4444-8444-444444444444';

function mk(): LeadTaskMachine {
  return new LeadTaskMachine({ task_id: TASK, kind: 'project' });
}
function offerBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'project', summary: 's', lease_ms: 300000, offer_ttl_ms: 60000, ...over };
}
function sends(actions: LeadAction[]) {
  return actions.filter((a): a is Extract<LeadAction, { kind: 'send' }> => a.kind === 'send').map((a) => a.msg);
}
function dispatched(actions: LeadAction[]) {
  return actions.filter((a): a is Extract<LeadAction, { kind: 'requestDispatch' }> => a.kind === 'requestDispatch');
}

describe('牵头方状态机:正常主路径(§5.3)', () => {
  it('offer→accept→progress 续租→result 验收通过→done', () => {
    const m = mk();
    const actions = m.dispatchTo(B, offerBody(), 0);
    expect(m.rec.state).toBe('offered');
    expect(m.rec.attempt).toBe(1);
    expect(sends(actions)[0]?.type).toBe('task.offer');

    m.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 100);
    expect(m.rec.state).toBe('running');
    expect(m.rec.leaseDeadline).toBe(100 + 230000); // lost = 2×(300s/3)+30s(R3)

    const acts = m.onMessage('task.progress', B, 1, { state: 'working', seq: 1 }, 200_000);
    expect(m.rec.leaseDeadline).toBe(200_000 + 230_000);
    expect(acts.some((a) => a.kind === 'schedule' && a.timer === 'lease')).toBe(true);

    m.onMessage('task.result', B, 1, { status: 'done', summary: 'ok' }, 300_000);
    expect(m.rec.state).toBe('done');
    expect(m.terminal).toBe(true);
  });

  it('A3:验收失败 → cancel(acceptance_failed) → drain → 改派 attempt+1', () => {
    const m = mk();
    m.dispatchTo(B, offerBody(), 0);
    m.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 100);
    const actions = m.onMessage(
      'task.result',
      B,
      1,
      { status: 'done', acceptance_results: [{ check: 'x', pass: false }] },
      200,
    );
    expect(m.rec.state).toBe('reclaiming');
    expect(sends(actions)[0]?.body).toEqual({ reason: 'acceptance_failed' });
    const afterDrain = m.onTimer('drain', 200 + 30_000);
    expect(m.rec.acceptedFailedBudget).toBe(1);
    expect(dispatched(afterDrain)[0]?.nextAttempt).toBe(2);
  });
});

describe('牵头方状态机:R4/R7/R8/D25', () => {
  it('fail(retryable) → 先撤销后改派:cancel 先入通道,drain 后 requestDispatch', () => {
    const m = mk();
    m.dispatchTo(B, offerBody(), 0);
    m.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 0);
    const actions = m.onMessage('task.fail', B, 1, { reason_code: 'internal_error', retryable: true, summary: 'x' }, 100);
    expect(m.rec.state).toBe('reclaiming');
    const msgs = sends(actions);
    expect(msgs[0]?.type).toBe('task.cancel');
    expect(msgs[0]?.body).toEqual({ reason: 'reclaim' });
    const afterDrain = m.onTimer('drain', 100 + 30_000);
    expect(m.rec.acceptedFailedBudget).toBe(1);
    expect(dispatched(afterDrain)[0]?.nextAttempt).toBe(2);
  });

  it('fail(retryable=false) → 立即 failed,不烧 attempt(R7)', () => {
    const m = mk();
    m.dispatchTo(B, offerBody(), 0);
    m.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 0);
    m.onMessage('task.fail', B, 1, { reason_code: 'unsupported_caps', retryable: false, summary: 'x' }, 100);
    expect(m.rec.state).toBe('failed');
    expect(m.rec.acceptedFailedBudget).toBe(0);
  });

  it('判 lost → reclaim 审计 + cancel;drain 窗口内 result → done(赛跑,R4/R5)', () => {
    const m = mk();
    m.dispatchTo(B, offerBody(), 0);
    m.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 0);
    const actions = m.onTimer('lease', 230_000);
    expect(m.rec.state).toBe('reclaiming');
    expect(actions.some((a) => a.kind === 'audit' && a.event === 'reclaim')).toBe(true);
    m.onMessage('task.result', B, 1, { status: 'done', summary: '恰好做完' }, 240_000);
    expect(m.rec.state).toBe('done');
  });

  it('expired → 也先撤销后改派(R2/R4,评审 I-08);从未接受计 dispatch_rounds', () => {
    const m = mk();
    m.dispatchTo(B, offerBody(), 0);
    m.onTimer('offer_ttl', 60_001);
    expect(m.rec.state).toBe('reclaiming');
    const actions = m.onTimer('drain', 60_001 + 30_000);
    expect(m.rec.dispatchRounds).toBe(1);
    expect(m.rec.acceptedFailedBudget).toBe(0);
    expect(dispatched(actions)[0]?.nextAttempt).toBe(2);
  });

  it('reject(busy,retry_after) → 不排除;dispatch_rounds 耗尽(max=3)→ escalate(§11 结构化)', () => {
    const m = mk();
    m.dispatchTo(B, offerBody(), 0);
    m.onMessage('task.reject', B, 1, { reason_code: 'busy', retryable: true, retry_after_ms: 5000 }, 10);
    expect(m.rec.excluded[B]).toBeUndefined();
    expect(m.redispatchTo(C, offerBody(), 20).length).toBeGreaterThan(0);
    m.onMessage('task.reject', C, 2, { reason_code: 'busy', retryable: true, retry_after_ms: 5000 }, 30);
    expect(m.redispatchTo(A, offerBody(), 40).length).toBeGreaterThan(0);
    m.onMessage('task.reject', A, 3, { reason_code: 'busy', retryable: true, retry_after_ms: 5000 }, 50);
    expect(m.rec.state).toBe('escalated');
    expect(m.terminal).toBe(true);
  });

  it('R0:迟到旧 attempt 消息 → reject(stale_attempt) 回执 + 审计', () => {
    const m = mk();
    m.dispatchTo(B, offerBody(), 0);
    m.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 0);
    const actions = m.onMessage('task.result', B, 0, { status: 'done' }, 50);
    const msgs = sends(actions);
    expect(msgs[0]?.type).toBe('task.reject');
    expect(msgs[0]?.body.reason_code).toBe('stale_attempt');
    expect(actions.some((a) => a.kind === 'audit' && a.event === 'stale_attempt_rejected')).toBe(true);
  });

  it('用户取消:cancelling→ack→closed;超时→强制 closed(I-06);竞态 result→done', () => {
    const m = mk();
    m.dispatchTo(B, offerBody(), 0);
    m.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 0);
    const actions = m.cancelByUser(1_000);
    expect(m.rec.state).toBe('cancelling');
    expect(sends(actions)[0]?.type).toBe('task.cancel');
    m.onMessage('task.cancel.ack', B, 1, {}, 1_100);
    expect(m.rec.state).toBe('closed');

    const m2 = mk();
    m2.dispatchTo(B, offerBody(), 0);
    m2.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 0);
    m2.cancelByUser(1_000);
    m2.onTimer('cancel_wait', 31_000);
    expect(m2.rec.state).toBe('closed');

    const m3 = mk();
    m3.dispatchTo(B, offerBody(), 0);
    m3.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 0);
    m3.cancelByUser(1_000);
    m3.onMessage('task.result', B, 1, { status: 'done', summary: '抢在取消前完成' }, 1_050);
    expect(m3.rec.state).toBe('done');
  });
});