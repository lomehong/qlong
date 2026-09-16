import { assert, constantFrom, jsonValue, property } from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canApplyLeaseRenewal, isLeaseFence, isLeaseRenewalBody } from '../src/lease.js';
import type { LeaseFence, LeaseRenewalBody } from '../src/lease.js';

const taskId = '11111111-1111-4111-8111-111111111111';
const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const progressMsgId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const otherId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const fence: LeaseFence = { task_id: taskId, attempt: 2, generation: 3, run_id: runId };
const body: LeaseRenewalBody = {
  generation: 3,
  run_id: runId,
  progress_msg_id: progressMsgId,
  progress_seq: 4,
  renewal_seq: 2,
  deadline_ms: 1_400,
};
const input = {
  body,
  fence,
  progressMsgId,
  progressSeq: 4,
  lastRenewalSeq: 1,
  now: 1_000,
  maxLeaseMs: 500,
  currentDeadlineMs: 1_100,
};
const invalidCounters: unknown[] = [undefined, null, false, '1', 0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1];
const invalidIds: unknown[] = [undefined, null, 1, {}, '', 'not-a-uuid', `${runId} `, runId.slice(1)];

describe('lease guards', () => {
  it('accepts required fields and ignores unknown extensions like the v1 envelope', () => {
    expect(isLeaseFence(fence)).toBe(true);
    expect(isLeaseRenewalBody(body)).toBe(true);
    expect(isLeaseFence({ ...fence, future: true, run_id: runId.toUpperCase() })).toBe(true);
    expect(isLeaseRenewalBody({ ...body, future: true })).toBe(true);
  });

  it.each([undefined, null, false, 1, 'body', [], [body], new Date(0), () => body].map((value) => ({ value })))('rejects non-record input $value', ({ value }) => {
    expect(isLeaseFence(value)).toBe(false);
    expect(isLeaseRenewalBody(value)).toBe(false);
    expect(canApplyLeaseRenewal({ ...input, body: value })).toBe(false);
  });

  it.each(Object.keys(fence))('requires fence.%s', (field) => {
    const malformed: Record<string, unknown> = { ...fence };
    delete malformed[field];
    expect(isLeaseFence(malformed)).toBe(false);
  });

  it.each(Object.keys(body))('requires body.%s', (field) => {
    const malformed: Record<string, unknown> = { ...body };
    delete malformed[field];
    expect(isLeaseRenewalBody(malformed)).toBe(false);
    expect(canApplyLeaseRenewal({ ...input, body: malformed })).toBe(false);
  });

  it.each(['attempt', 'generation'])('enforces positive safe integer fence.%s', (field) => {
    for (const value of invalidCounters) expect(isLeaseFence({ ...fence, [field]: value })).toBe(false);
    for (const value of [1, Number.MAX_SAFE_INTEGER]) expect(isLeaseFence({ ...fence, [field]: value })).toBe(true);
  });

  it.each(['generation', 'progress_seq', 'renewal_seq'])('enforces positive safe integer body.%s', (field) => {
    for (const value of invalidCounters) {
      const malformed = { ...body, [field]: value };
      expect(isLeaseRenewalBody(malformed)).toBe(false);
      expect(canApplyLeaseRenewal({ ...input, body: malformed })).toBe(false);
    }
    for (const value of [1, Number.MAX_SAFE_INTEGER]) expect(isLeaseRenewalBody({ ...body, [field]: value })).toBe(true);
  });

  it.each(['task_id', 'run_id'])('requires UUID fence.%s', (field) => {
    for (const value of invalidIds) expect(isLeaseFence({ ...fence, [field]: value })).toBe(false);
  });

  it.each(['run_id', 'progress_msg_id'])('requires UUID body.%s', (field) => {
    for (const value of invalidIds) expect(isLeaseRenewalBody({ ...body, [field]: value })).toBe(false);
  });

  it('requires a finite deadline without coercion; envelope validation owns wire integer rules', () => {
    for (const deadline_ms of [undefined, null, '1400', NaN, Infinity, -Infinity]) {
      expect(isLeaseRenewalBody({ ...body, deadline_ms })).toBe(false);
    }
    expect(isLeaseRenewalBody({ ...body, deadline_ms: 1_400.5 })).toBe(true);
  });
});

describe('canApplyLeaseRenewal', () => {
  it('accepts a matching renewal without mutating caller state', () => {
    const frozen = Object.freeze({ ...input, body: Object.freeze({ ...body }), fence: Object.freeze({ ...fence }) });
    expect(canApplyLeaseRenewal(frozen)).toBe(true);
    expect(frozen).toEqual(input);
  });

  it.each([{ generation: 2 }, { generation: 4 }, { run_id: otherId }])('rejects a stale or different run fence %j', (change) => {
    expect(canApplyLeaseRenewal({ ...input, body: { ...body, ...change } })).toBe(false);
  });

  it('requires caller envelope binding to reject old attempts and other tasks', () => {
    // Authentication/type validation precede this caller-side task/attempt binding.
    const applyBound = (envelope: { task_id: string; attempt: number }) =>
      envelope.task_id === fence.task_id && envelope.attempt === fence.attempt && canApplyLeaseRenewal(input);
    expect(applyBound({ task_id: taskId, attempt: 1 })).toBe(false);
    expect(applyBound({ task_id: otherId, attempt: 2 })).toBe(false);
    expect(applyBound({ task_id: taskId, attempt: 3 })).toBe(false);
    expect(applyBound({ task_id: taskId, attempt: 2 })).toBe(true);
    // No incoming task/attempt exists in the body: this predicate alone cannot bind it.
    expect(canApplyLeaseRenewal({ ...input, fence: { ...fence, attempt: 1 } })).toBe(true);
  });

  it('requires external authentication, current lead and the task.lease.renew message type', () => {
    const envelope = { type: 'task.lease.renew', from: 'current-lead', task_id: taskId, attempt: 2 };
    const applyAuthenticated = (incoming: typeof envelope, signatureVerified: boolean) =>
      signatureVerified && incoming.type === 'task.lease.renew' && incoming.from === 'current-lead'
      && incoming.task_id === fence.task_id && incoming.attempt === fence.attempt && canApplyLeaseRenewal(input);
    expect(applyAuthenticated(envelope, true)).toBe(true);
    expect(applyAuthenticated(envelope, false)).toBe(false);
    expect(applyAuthenticated({ ...envelope, from: 'former-lead' }, true)).toBe(false);
    expect(applyAuthenticated({ ...envelope, type: 'task.progress' }, true)).toBe(false);
    expect(applyAuthenticated({ ...envelope, type: 'task.lease_renew' }, true)).toBe(false);
  });

  it.each([{ progress_msg_id: otherId }, { progress_seq: 3 }, { progress_seq: 5 }])('requires the exact outstanding progress %j', (change) => {
    expect(canApplyLeaseRenewal({ ...input, body: { ...body, ...change } })).toBe(false);
  });

  it('accepts first and skipped renewal sequences, but rejects duplicates and older sequences', () => {
    expect(canApplyLeaseRenewal({ ...input, lastRenewalSeq: 0, body: { ...body, renewal_seq: 1 } })).toBe(true);
    expect(canApplyLeaseRenewal({ ...input, body: { ...body, renewal_seq: 10 } })).toBe(true);
    expect(canApplyLeaseRenewal({ ...input, body: { ...body, renewal_seq: Number.MAX_SAFE_INTEGER } })).toBe(true);
    expect(canApplyLeaseRenewal({ ...input, lastRenewalSeq: 2 })).toBe(false);
    expect(canApplyLeaseRenewal({ ...input, lastRenewalSeq: 3 })).toBe(false);
  });

  it('rejects a replay after the caller records an accepted renewal', () => {
    expect(canApplyLeaseRenewal(input)).toBe(true);
    expect(canApplyLeaseRenewal({ ...input, lastRenewalSeq: body.renewal_seq, currentDeadlineMs: body.deadline_ms })).toBe(false);
  });

  it('requires the new outstanding progress even when the renewal sequence advances', () => {
    const next = {
      ...input, progressMsgId: otherId, progressSeq: 5,
      lastRenewalSeq: body.renewal_seq, currentDeadlineMs: body.deadline_ms,
      body: { ...body, renewal_seq: 3 },
    };
    expect(canApplyLeaseRenewal(next)).toBe(false);
    expect(canApplyLeaseRenewal({ ...next, body: { ...next.body, progress_msg_id: otherId } })).toBe(false);
    const nextBody = { ...next.body, progress_msg_id: otherId, progress_seq: 5 };
    expect(canApplyLeaseRenewal({ ...next, body: nextBody })).toBe(true);
    expect(canApplyLeaseRenewal({ ...next, body: { ...nextBody, renewal_seq: 2 } })).toBe(false);
    // Consumed/cleared progress can no longer authorize a renewal.
    expect(canApplyLeaseRenewal({ ...next, body: nextBody, progressMsgId: '', progressSeq: 0 })).toBe(false);
  });

  it('supports fractional local clocks while enforcing the same strict deadline boundaries', () => {
    const fractional = { ...input, now: 1_000.25, currentDeadlineMs: 1_000.5, maxLeaseMs: 0.5 };
    expect(canApplyLeaseRenewal({ ...fractional, body: { ...body, deadline_ms: 1_000.75 } })).toBe(true);
    expect(canApplyLeaseRenewal({ ...fractional, body: { ...body, deadline_ms: 1_000.76 } })).toBe(false);
    expect(canApplyLeaseRenewal({ ...fractional, body: { ...body, deadline_ms: 1_000.25 } })).toBe(false);
    expect(canApplyLeaseRenewal({ ...fractional, now: 1_000.5, body: { ...body, deadline_ms: 1_000.75 } })).toBe(false);
  });

  it.each([999, 1_000, 1_001, 1_500, 1_501])('enforces the open/closed deadline window at %s', (deadline_ms) => {
    expect(canApplyLeaseRenewal({ ...input, body: { ...body, deadline_ms } })).toBe(deadline_ms > input.now && deadline_ms <= 1_500);
  });

  it.each([1_099, 1_100, 1_101])('never revives an expired local lease at now=%s', (now) => {
    expect(canApplyLeaseRenewal({ ...input, now })).toBe(now < input.currentDeadlineMs);
  });

  it.each(['now', 'currentDeadlineMs', 'maxLeaseMs'])('rejects non-finite or non-numeric local %s', (field) => {
    for (const value of [undefined, null, '1000', NaN, Infinity, -Infinity]) {
      expect(canApplyLeaseRenewal({ ...input, [field]: value })).toBe(false);
    }
  });

  it('rejects a non-positive lease limit and overflowing deadline limit', () => {
    for (const maxLeaseMs of [0, -1]) expect(canApplyLeaseRenewal({ ...input, maxLeaseMs })).toBe(false);
    expect(canApplyLeaseRenewal({ ...input, now: 1e308, currentDeadlineMs: 1.7e308, maxLeaseMs: 1e308, body: { ...body, deadline_ms: 1.5e308 } })).toBe(false);
  });

  it('rejects invalid local counters, fence and outstanding progress ID', () => {
    for (const value of invalidCounters) {
      expect(canApplyLeaseRenewal({ ...input, progressSeq: value as number })).toBe(false);
      if (value !== 0) expect(canApplyLeaseRenewal({ ...input, lastRenewalSeq: value as number })).toBe(false);
      expect(canApplyLeaseRenewal({ ...input, fence: { ...fence, attempt: value as number } })).toBe(false);
    }
    for (const value of invalidIds) expect(canApplyLeaseRenewal({ ...input, progressMsgId: value as string })).toBe(false);
    expect(canApplyLeaseRenewal({ ...input, fence: null as unknown as LeaseFence })).toBe(false);
  });
});

describe('property: malformed lease data', () => {
  it('never throws on arbitrary JSON and only applies validated bodies', () => {
    assert(property(jsonValue(), (value) => {
      expect(typeof isLeaseFence(value)).toBe('boolean');
      expect(typeof isLeaseRenewalBody(value)).toBe('boolean');
      const applied = canApplyLeaseRenewal({ ...input, body: value });
      expect(typeof applied).toBe('boolean');
      if (!isLeaseRenewalBody(value)) expect(applied).toBe(false);
    }), { numRuns: 500, seed: 20260916 });
  });

  it('rejects missing required fields even with arbitrary JSON extensions', () => {
    assert(property(jsonValue(), constantFrom(...Object.keys(body)), constantFrom(...Object.keys(fence)), (value, bodyField, fenceField) => {
      const malformedBody: Record<string, unknown> = { ...body, future: value };
      const malformedFence: Record<string, unknown> = { ...fence, future: value };
      delete malformedBody[bodyField];
      delete malformedFence[fenceField];
      expect(isLeaseRenewalBody(malformedBody)).toBe(false);
      expect(isLeaseFence(malformedFence)).toBe(false);
      expect(canApplyLeaseRenewal({ ...input, body: malformedBody })).toBe(false);
    }), { numRuns: 500, seed: 20260917 });
  });
});