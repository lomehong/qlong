import { describe, expect, it, vi } from 'vitest';
import { LeadTaskMachine, type LeadInit, type LeadState } from '../src/lead/machine.js';
import { ExecutorMachine, type ExecState } from '../src/executor/machine.js';

const TASK = '66666666-6666-4666-8666-666666666666';
const OTHER_TASK = '99999999-9999-4999-8999-999999999999';
const PEER = '22222222-2222-4222-8222-222222222222';
const OTHER_PEER = '44444444-4444-4444-8444-444444444444';
const MSG = '77777777-7777-4777-8777-777777777777';
const OFFER = { kind: 'project', summary: 's', lease_ms: 300_000, offer_ttl_ms: 60_000 };
const RESULT = { status: 'done', summary: 'ok', acceptance_results: [{ check: 'x', pass: true }] };
const RESULT_STATES = ['running', 'reclaiming', 'cancelling'] as const;
const LEAD_STATES: LeadState[] = ['drafting', 'offered', ...RESULT_STATES, 'done', 'failed', 'escalated', 'closed'];
const EXEC_STATES: ExecState[] = ['idle', 'offered', 'running', 'result_sent', 'fail_sent', 'rejected', 'stopped', 'cleaned'];

function runningLead(init: Partial<LeadInit> = {}): LeadTaskMachine {
  const m = new LeadTaskMachine({ task_id: TASK, kind: 'project', ...init });
  m.dispatchTo(PEER, { ...OFFER, kind: m.rec.kind }, 0);
  m.onMessage('task.accept', PEER, 1, { lease_ms: OFFER.lease_ms }, 0);
  return m;
}

function resultState(state: typeof RESULT_STATES[number], init: Partial<LeadInit> = {}): LeadTaskMachine {
  const m = runningLead(init);
  if (state === 'running') m.onMessage('task.progress', PEER, 1, { seq: 1 }, 200_000);
  if (state === 'reclaiming') m.onTimer('lease', m.rec.leaseDeadline!);
  if (state === 'cancelling') m.cancelByUser(230_000);
  expect(m.rec.state).toBe(state);
  return m;
}

function offer(over: Partial<Parameters<ExecutorMachine['onOffer']>[0]> = {}): Parameters<ExecutorMachine['onOffer']>[0] {
  return { from: PEER, task_id: TASK, attempt: 1, msg_id: MSG, body: OFFER, now: 0, ...over };
}

function runningExecutor(): ExecutorMachine {
  const m = new ExecutorMachine();
  m.onOffer(offer());
  m.onHeartbeatDue(100_000);
  return m;
}

describe('lead peer and attempt safety', () => {
  it.each(LEAD_STATES)('ignores foreign peers without actions or mutations in %s', (state) => {
    const validateAcceptance = vi.fn(() => true);
    const m = runningLead({ validateAcceptance });
    m.rec.state = state;
    m.terminal = ['done', 'failed', 'escalated', 'closed'].includes(state);
    const before = structuredClone(m.rec);
    for (const type of ['task.accept', 'task.reject', 'task.progress', 'task.result', 'task.fail', 'task.cancel.ack']) {
      for (const attempt of [0, 1, 2]) {
        expect(m.onMessage(type, OTHER_PEER, attempt, { ...RESULT, retryable: false }, 240_000)).toEqual([]);
        expect(m.rec).toEqual(before);
      }
    }
    expect(validateAcceptance).not.toHaveBeenCalled();
  });

  it.each(RESULT_STATES)('does not accept a current-peer result from another attempt in %s', (state) => {
    const validateAcceptance = vi.fn(() => true);
    const m = resultState(state, { validateAcceptance });
    const before = structuredClone(m.rec);
    for (const attempt of [0, 2]) {
      const actions = m.onMessage('task.result', PEER, attempt, RESULT, 240_000);
      expect(actions).toContainEqual(expect.objectContaining({ kind: 'audit', event: 'stale_attempt_rejected' }));
      expect(m.rec).toEqual(before);
    }
    expect(validateAcceptance).not.toHaveBeenCalled();
  });

  it('binds the peer to the new dispatch, not a previously authorized executor', () => {
    const m = resultState('reclaiming', { validateAcceptance: () => true });
    m.onMessage('task.cancel.ack', PEER, 1, {}, 240_000);
    m.redispatchTo(OTHER_PEER, OFFER, 250_000);
    expect(m.onMessage('task.accept', PEER, 2, {}, 250_001)).toEqual([]);
    expect(m.rec.state).toBe('offered');
    m.onMessage('task.accept', OTHER_PEER, 2, {}, 250_002);
    expect(m.onMessage('task.result', PEER, 2, RESULT, 250_003)).toEqual([]);
    m.onMessage('task.result', OTHER_PEER, 2, RESULT, 250_004);
    expect(m.rec.state).toBe('done');
  });

  it('cannot close a targetless cancellation through an unsolicited ack', () => {
    const m = new LeadTaskMachine({ task_id: TASK, kind: 'aid' });
    m.cancelByUser(0);
    expect(m.onMessage('task.cancel.ack', PEER, 0, {}, 1)).toEqual([]);
    expect(m.rec.state).toBe('cancelling');
    m.onTimer('cancel_wait', m.rec.cancelWaitUntil!);
    expect(m.rec.state).toBe('closed');
  });

  it.each(['reclaiming', 'cancelling'] as const)('still handles current-peer fail and cancel.ack in %s', (state) => {
    const failed = resultState(state);
    failed.onMessage('task.fail', PEER, 1, { reason_code: 'internal_error', retryable: false }, 240_000);
    expect(failed.rec.state).toBe(state === 'reclaiming' ? 'failed' : 'closed');
    const acked = resultState(state);
    acked.onMessage('task.cancel.ack', PEER, 1, {}, 240_000);
    expect(acked.rec.state).toBe(state === 'reclaiming' ? 'drafting' : 'closed');
  });
});

describe('lead acceptance safety', () => {
  it.each(RESULT_STATES)('fails closed for PROJECT without a validator in %s', (state) => {
    for (const body of [{ status: 'done' }, { ...RESULT, acceptance_results: [] }, RESULT]) {
      const m = resultState(state);
      const actions = m.onMessage('task.result', PEER, 1, body, 240_000);
      expect(m.rec.state).toBe(state === 'running' ? 'reclaiming' : state);
      expect(m.terminal).toBe(false);
      expect(actions.some((a) => a.kind === 'terminal')).toBe(false);
      expect(m.rec.history.at(-1)?.outcome).toBe('acceptance_failed');
    }
  });

  it.each(RESULT_STATES)('allows PROJECT done only through the supplied validator in %s', (state) => {
    const validateAcceptance = vi.fn((body: Record<string, unknown>) => body.summary === 'ok');
    const m = resultState(state, { validateAcceptance });
    const actions = m.onMessage('task.result', PEER, 1, RESULT, 240_000);
    expect(validateAcceptance).toHaveBeenCalledExactlyOnceWith(RESULT);
    expect(m.rec.state).toBe('done');
    expect(m.terminal).toBe(true);
    expect(actions).toContainEqual({ kind: 'terminal', state: 'done' });
    expect(m.rec.history.at(-1)?.outcome).toBe('result_delivered');
  });

  it.each(RESULT_STATES)('honors a validator veto even for self-reported passing results in %s', (state) => {
    const validateAcceptance = vi.fn(() => false);
    const m = resultState(state, { validateAcceptance });
    m.onMessage('task.result', PEER, 1, RESULT, 240_000);
    expect(validateAcceptance).toHaveBeenCalledExactlyOnceWith(RESULT);
    expect(m.rec.state).toBe(state === 'running' ? 'reclaiming' : state);
    expect(m.rec.history.at(-1)?.outcome).toBe('acceptance_failed');
  });

  it.each(['ack', 'timeout'] as const)('keeps cancellation pending after failed acceptance until %s', (completion) => {
    const m = resultState('cancelling', { validateAcceptance: () => false });
    const deadline = m.rec.cancelWaitUntil;
    expect(m.onMessage('task.result', PEER, 1, RESULT, 240_000)).toEqual([]);
    expect(m.rec.cancelWaitUntil).toBe(deadline);
    expect(m.rec.cancelReason).toBe('user');
    expect(m.rec.acceptedFailedBudget).toBe(0);
    if (completion === 'ack') m.onMessage('task.cancel.ack', PEER, 1, {}, 240_001);
    else m.onTimer('cancel_wait', deadline!);
    expect(m.rec.state).toBe('closed');
  });

  it.each(RESULT_STATES)('retains aid default acceptance compatibility in %s', (state) => {
    for (const body of [{ status: 'done' }, { ...RESULT, acceptance_results: [] }, RESULT]) {
      const m = resultState(state, { kind: 'aid' });
      m.onMessage('task.result', PEER, 1, body, 240_000);
      expect(m.rec.state).toBe('done');
    }
    const rejected = resultState(state, { kind: 'aid' });
    rejected.onMessage('task.result', PEER, 1, { ...RESULT, acceptance_results: [{ pass: false }] }, 240_000);
    expect(rejected.rec.state).toBe(state === 'running' ? 'reclaiming' : state);
  });
});

describe('executor expired-offer safety', () => {
  it.each(['offered', 'running', 'paused'] as const)('preserves the %s slot when rejecting expired offers', (state) => {
    for (const incoming of [
      { task_id: OTHER_TASK, from: PEER }, { task_id: OTHER_TASK, from: OTHER_PEER },
      { attempt: 2, from: PEER }, { attempt: 2, from: OTHER_PEER },
    ]) {
      for (const exp of [new Date(0).toISOString(), 'invalid-exp']) {
        const m = runningExecutor();
        if (state === 'offered') m.rec.state = 'offered'; // The synchronous offer gate normally skips this transient state.
        if (state === 'paused') m.onLeaseSelfTimeout(m.rec.leaseSelfDeadline!);
        const record = m.rec;
        const before = structuredClone(record);
        const rejectedOffer = offer({ ...incoming, exp, now: 3_600_000 });
        expect(m.onOffer(rejectedOffer)).toEqual([{
          kind: 'send',
          msg: {
            type: 'task.reject', to_node: incoming.from, task_id: rejectedOffer.task_id,
            attempt: rejectedOffer.attempt, reply_to: MSG, body: { reason_code: 'expired' },
          },
        }]);
        expect(m.rec).toBe(record);
        expect(m.rec).toEqual(before);
        const cancel = m.onCancel(PEER, 1);
        expect(cancel.some((a) => a.kind === 'send' && a.msg.type === 'task.cancel.ack')).toBe(true);
        expect(m.rec.state).toBe('stopped');
      }
    }
  });

  it('still replaces a running attempt when the higher offer is fresh', () => {
    const m = runningExecutor();
    const actions = m.onOffer(offer({ attempt: 2, now: 100_001, exp: new Date(3_600_000).toISOString() }));
    expect(actions).toContainEqual({ kind: 'stopDriver' });
    expect(actions).toContainEqual({ kind: 'startDriver', task_id: TASK, attempt: 2, offer: OFFER });
    expect(actions.findIndex((a) => a.kind === 'stopDriver')).toBeLessThan(actions.findIndex((a) => a.kind === 'startDriver'));
    expect(m.rec).toMatchObject({ state: 'running', task_id: TASK, attempt: 2, from: PEER });
  });

  it('does not erase a delivered-result tombstone with an expired higher offer', () => {
    const m = runningExecutor();
    m.onDriverCompleted(RESULT);
    const before = structuredClone(m.rec);
    m.onOffer(offer({ attempt: 2, now: 3_600_000, exp: new Date(0).toISOString() }));
    expect(m.rec).toEqual(before);
    expect(m.onOffer(offer())).toEqual([]);
  });
});

describe('executor cancellation safety', () => {
  it.each(EXEC_STATES)('ignores wrong-peer and wrong-attempt cancellations in %s', (state) => {
    const m = runningExecutor();
    m.rec.state = state;
    const before = structuredClone(m.rec);
    for (const from of [PEER, OTHER_PEER]) {
      for (const attempt of [0, 1, 2]) {
        if (from === PEER && attempt === 1) continue;
        expect(m.onCancel(from, attempt)).toEqual([]);
        expect(m.rec).toEqual(before);
      }
    }
  });

  it.each(['offered', 'running'] as const)('honors matching cancellation in %s', (state) => {
    const m = runningExecutor();
    m.rec.state = state;
    const actions = m.onCancel(PEER, 1);
    expect(m.rec.state).toBe('stopped');
    expect(actions.some((a) => a.kind === 'stopDriver')).toBe(state === 'running');
    expect(actions).toContainEqual(expect.objectContaining({ kind: 'cancelTimers' }));
    expect(actions).toContainEqual({ kind: 'send', msg: {
      type: 'task.cancel.ack', to_node: PEER, task_id: TASK, attempt: 1, reply_to: undefined, body: {},
    } });
  });

  it('does not leak a completed but undelivered result to another peer or attempt', () => {
    const m = runningExecutor();
    m.rec.driverCompleted = true;
    m.rec.resultBody = RESULT;
    expect(m.onCancel(OTHER_PEER, 1)).toEqual([]);
    expect(m.onCancel(PEER, 0)).toEqual([]);
    const actions = m.onCancel(PEER, 1);
    expect(m.rec.state).toBe('result_sent');
    expect(actions.some((a) => a.kind === 'send' && a.msg.type === 'task.result' && a.msg.body.completed_before_cancel === true)).toBe(true);
  });

  it('acknowledges a delivered result only to the matching peer and attempt without resending it', () => {
    const m = runningExecutor();
    m.onDriverCompleted(RESULT);
    const before = structuredClone(m.rec);
    expect(m.onCancel(OTHER_PEER, 1)).toEqual([]);
    expect(m.onCancel(PEER, 0)).toEqual([]);
    expect(m.onCancel(PEER, 2)).toEqual([]);
    expect(m.onCancel(PEER, 1)).toEqual([{ kind: 'send', msg: {
      type: 'task.cancel.ack', to_node: PEER, task_id: TASK, attempt: 1,
      reply_to: undefined, body: { completed_before_cancel: true },
    } }]);
    expect(m.rec).toEqual(before);
  });
});