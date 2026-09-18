import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envelopeDigest, newId, type EnvelopeV1 } from '@qlong/core';
import type { FencedDriver, RunFence, RunHandle, RunOutcome } from '../src/driver/run-handle.js';
import { DurableExecutor, type DurableExecutorOptions } from '../src/runtime/executor.js';
import { NodeRuntimeStore, type RuntimeJson } from '../src/runtime/store.js';
import type { Outbound } from '../src/wire.js';
import { env, failCommit, fixture, LOCAL, open, OTHER, SENDER } from './runtime-store-helpers.js';

const TEAM = 'executor-test-team';
const KEY = 'executor:v2';
const EPOCH = Date.parse('2026-09-16T12:00:00Z');
let now = EPOCH;
const result: RunOutcome = { kind: 'result', body: { status: 'done', summary: 'done' } };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function corruptField(snapshot: RuntimeJson, path: string, value: RuntimeJson): void {
  const keys = path.split('.');
  let target = snapshot as Record<string, RuntimeJson>;
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, RuntimeJson>;
  target[keys.at(-1)!] = value;
}

function offer(overrides: Partial<EnvelopeV1> = {}): EnvelopeV1 {
  return env({ ts: new Date(now).toISOString(), exp: new Date(now + 60_000).toISOString(),
    from: { node_id: SENDER, team_id: TEAM, key_epoch: 1 },
    body: { kind: 'aid', summary: 'trusted embedded work', lease_ms: 900, offer_ttl_ms: 300 }, ...overrides });
}

function seal(out: Outbound): EnvelopeV1 {
  return offer({ type: out.type, from: { node_id: LOCAL, team_id: TEAM, key_epoch: 1 },
    to: { node_id: out.to_node }, task_id: out.task_id!, attempt: out.attempt!,
    ...(out.reply_to ? { reply_to: out.reply_to } : {}), body: out.body });
}

function control(input: EnvelopeV1, type: string, body: Record<string, unknown> = {}): EnvelopeV1 {
  return offer({ type, task_id: input.task_id, attempt: input.attempt, body });
}

class FakeDriver implements FencedDriver {
  readonly entered = deferred<void>();
  readonly runs: Array<{
    handle: RunHandle;
    outcome: ReturnType<typeof deferred<RunOutcome>>;
    stopped: ReturnType<typeof deferred<void>>;
    stopEntered: ReturnType<typeof deferred<void>>;
  }> = [];
  startBarrier: Promise<void> = Promise.resolve();
  recovery: 'stopped' | 'unknown' = 'unknown';

  constructor(readonly store: NodeRuntimeStore) {}

  start = vi.fn(async (fence: RunFence, _offer: Record<string, unknown>): Promise<RunHandle> => {
    // Reads would throw on store reentry if start/stop/recover were called inside a transaction.
    expect(this.store.state(KEY)?.value).toMatchObject({ generation: fence.generation,
      slot: { phase: 'starting', mayHaveStarted: true, fence } });
    expect(this.store.pendingEffects(undefined, true)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fence.run_id, kind: 'executor.run' }),
    ]));
    expect(Object.isFrozen(fence)).toBe(true);
    const outcome = deferred<RunOutcome>();
    const stopped = deferred<void>();
    const stopEntered = deferred<void>();
    const handle: RunHandle = Object.freeze({ fence, closed: outcome.promise, stop: vi.fn(() => {
      expect(this.store.state(KEY)?.value).toMatchObject({ slot: { fence } });
      stopEntered.resolve();
      return stopped.promise;
    }) });
    this.runs.push({ handle, outcome, stopped, stopEntered });
    this.entered.resolve();
    await this.startBarrier;
    return handle;
  });

  recover = vi.fn(async (fence: RunFence): Promise<'stopped' | 'unknown'> => {
    expect(this.store.state(KEY)?.value).toMatchObject({ slot: { fence } });
    return this.recovery;
  });
}

async function setup(overrides: Partial<DurableExecutorOptions> = {}, recovered = true) {
  const f = fixture();
  const driver = new FakeDriver(f.runtime);
  const executor = new DurableExecutor({ store: f.runtime, nodeId: LOCAL, teamId: TEAM, seal, driver, ...overrides });
  if (recovered) await executor.recover();
  const deliver = (input: EnvelopeV1, authorized = true) => {
    expect(['new', 'duplicate']).toContain(f.runtime.receive(input));
    executor.consume(input, authorized);
  };
  const outputs = (type: string) => f.runtime.all().map((item) => item.envelope).filter((item) => item.type === type);
  return { ...f, driver, executor, deliver, outputs };
}

beforeEach(() => { now = EPOCH; vi.spyOn(Date, 'now').mockImplementation(() => now); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('DurableExecutor single slot on real temporary SQLite', () => {
  it('requires completed recovery before admitting any offer', async () => {
    const f = await setup({}, false);
    f.deliver(offer());
    expect(f.executor.snapshot().slot).toBeNull();
    expect(f.outputs('task.reject')[0]!.body.reason_code).toBe('busy');
    expect(f.outputs('task.accept')).toEqual([]);
    expect(f.driver.start).not.toHaveBeenCalled();
    await f.executor.recover();
    f.deliver(offer());
    expect(f.executor.snapshot().slot?.phase).toBe('prepared');
    expect(f.outputs('task.accept')).toHaveLength(1);
  });

  it('commits intent before start, deduplicates offers/results and returns detached status', async () => {
    const f = await setup();
    const input = offer();
    f.deliver(input);
    const accepted = f.outputs('task.accept')[0]!;
    expect(f.executor.snapshot().slot?.phase).toBe('prepared');
    expect(f.driver.start).not.toHaveBeenCalled();
    f.deliver(input);
    f.deliver({ ...input, msg_id: newId() });
    expect(f.outputs('task.accept')).toEqual([accepted]);
    const copy = f.executor.snapshot();
    copy.slot!.offer.summary = 'mutated';
    copy.generation = 999;
    await Promise.all([f.executor.settle(), f.executor.settle()]);
    expect(f.driver.start).toHaveBeenCalledTimes(1);
    expect(f.executor.snapshot()).toMatchObject({ generation: 1, slot: { phase: 'running', offer: input.body } });
    f.driver.runs[0]!.outcome.resolve(result);
    await Promise.resolve();
    await f.executor.settle();
    f.deliver(input);
    await f.executor.settle();
    expect(f.executor.snapshot().slot).toBeNull();
    expect(f.outputs('task.result')).toHaveLength(1);
    expect(f.runtime.pendingEffects(undefined, true)).toEqual([]);
    expect(f.driver.start).toHaveBeenCalledTimes(1);
  });

  it('reopens a prepared intent and starts exactly once, preserving its fence and accept ID', async () => {
    const f = await setup();
    const input = offer();
    f.deliver(input);
    const before = f.executor.snapshot();
    const accepted = f.outputs('task.accept')[0]!;
    f.store.close();
    const runtime = new NodeRuntimeStore(open({ ...f.options, mode: 'open' }), LOCAL);
    const driver = new FakeDriver(runtime);
    const executor = new DurableExecutor({ store: runtime, nodeId: LOCAL, teamId: TEAM, seal, driver });
    await executor.recover();
    expect(driver.recover).not.toHaveBeenCalled();
    expect(executor.snapshot()).toEqual(before);
    executor.consume(input, true);
    await executor.settle();
    expect(driver.start).toHaveBeenCalledTimes(1);
    expect(driver.runs[0]!.handle.fence).toEqual(before.slot!.fence);
    expect(runtime.all()[0]!.envelope).toEqual(accepted);
    driver.runs[0]!.outcome.resolve(result);
    await Promise.resolve();
    await executor.settle();
  });

  it.each(['starting', 'running', 'stopping'] as const)('never replays persisted %s; unknown recovery keeps the slot', async (phase) => {
    const f = await setup();
    f.deliver(offer());
    // Crash cut immediately after the indicated local commit, before any recovery callback.
    const saved = f.executor.snapshot();
    saved.slot!.phase = phase;
    saved.slot!.mayHaveStarted = true;
    if (phase === 'stopping') saved.slot!.stopReason = 'shutdown';
    f.runtime.transition(KEY, f.runtime.state(KEY)!.revision, () => ({ state: saved as unknown as RuntimeJson }));
    f.store.close();
    const runtime = new NodeRuntimeStore(open({ ...f.options, mode: 'open' }), LOCAL);
    const driver = new FakeDriver(runtime);
    const executor = new DurableExecutor({ store: runtime, nodeId: LOCAL, teamId: TEAM, seal, driver });
    await executor.recover();
    await executor.settle();
    expect(driver.recover).toHaveBeenCalledTimes(1);
    expect(driver.recover).toHaveBeenCalledWith(saved.slot!.fence);
    expect(driver.start).not.toHaveBeenCalled();
    expect(executor.snapshot().slot?.phase).toBe('recovery_required');
    const busy = offer({ attempt: 2, task_id: saved.slot!.fence.task_id });
    runtime.receive(busy);
    executor.consume(busy, true);
    expect(runtime.all().at(-1)!.envelope.body.reason_code).toBe('busy');
    await expect(executor.close()).rejects.toThrow('closure unconfirmed');
    expect(runtime.pendingEffects(undefined, true)).toHaveLength(1);
    driver.recovery = 'stopped';
    await executor.recover();
    expect(executor.snapshot().slot).toBeNull();
    expect(runtime.pendingEffects(undefined, true)).toEqual([]);
    expect(driver.start).not.toHaveBeenCalled();
  });

  it('keeps higher attempts busy and defers cancel ack until exact stop confirmation', async () => {
    const f = await setup();
    const input = offer();
    f.deliver(input);
    await f.executor.settle();
    const first = f.driver.runs[0]!;
    f.deliver(offer({ task_id: input.task_id, attempt: 2 }));
    f.deliver(control(input, 'task.cancel'));
    const stopping = f.executor.settle();
    await first.stopEntered.promise;
    expect(f.outputs('task.cancel.ack')).toEqual([]);
    expect(f.executor.snapshot().slot?.phase).toBe('stopping');
    f.deliver(offer());
    expect(f.outputs('task.reject').map((e) => e.body.reason_code)).toEqual(['busy', 'busy']);
    first.stopped.resolve();
    await stopping;
    expect(f.outputs('task.cancel.ack')).toHaveLength(1);
    expect(f.executor.snapshot().slot).toBeNull();
    f.deliver(offer());
    await f.executor.settle();
    const second = f.executor.snapshot().slot!;
    expect(second.fence.generation).toBe(2);
    // Late closed callback from the stopped handle cannot complete or overwrite the new run.
    first.outcome.resolve(result);
    await Promise.resolve();
    await f.executor.settle();
    expect(f.executor.snapshot().slot).toEqual(second);
    expect(f.outputs('task.result')).toEqual([]);
    f.driver.runs[1]!.outcome.resolve(result);
    await Promise.resolve();
    await f.executor.settle();
  });

  it('stops a late start handle after cancellation before releasing the slot', async () => {
    const f = await setup();
    const gate = deferred<void>();
    f.driver.startBarrier = gate.promise;
    const input = offer();
    f.deliver(input);
    const settling = f.executor.settle();
    await f.driver.entered.promise;
    expect(f.executor.snapshot().slot?.phase).toBe('starting');
    f.deliver(control(input, 'task.cancel'));
    const recovery = f.executor.recover(); // Must join the in-flight start, not clear its fence.
    f.deliver(offer());
    expect(f.outputs('task.reject')[0]!.body.reason_code).toBe('busy');
    expect(f.outputs('task.cancel.ack')).toEqual([]);
    gate.resolve();
    const run = f.driver.runs[0]!;
    await run.stopEntered.promise;
    expect(f.driver.recover).not.toHaveBeenCalled();
    expect(f.executor.snapshot().slot?.fence).toEqual(run.handle.fence);
    run.stopped.resolve();
    await Promise.all([settling, recovery]);
    expect(f.outputs('task.cancel.ack')).toHaveLength(1);
    expect(f.executor.snapshot().slot).toBeNull();
  });

  it('can cancel a prepared run without invoking the driver', async () => {
    const f = await setup();
    const input = offer();
    f.deliver(input);
    f.deliver(control(input, 'task.cancel'));
    expect(f.outputs('task.cancel.ack')).toEqual([]);
    await f.executor.settle();
    expect(f.outputs('task.cancel.ack')).toHaveLength(1);
    expect(f.driver.start).not.toHaveBeenCalled();
    expect(f.driver.recover).not.toHaveBeenCalled();
  });

  it('persists heartbeat identity/sequence; only bound business renewal extends an unexpired lease', async () => {
    const f = await setup();
    const input = offer();
    f.deliver(input);
    await f.executor.settle();
    const original = f.executor.snapshot().slot!.leaseDeadline;
    now += 300;
    f.executor.tick();
    const progress = f.outputs('task.progress')[0]!;
    const slot = f.executor.snapshot().slot!;
    expect(progress.body).toMatchObject({ generation: slot.fence.generation, run_id: slot.fence.run_id, seq: 1 });
    expect(slot.progress).toMatchObject({ msg_id: progress.msg_id, seq: 1 });
    expect(f.runtime.stored(LOCAL, progress.msg_id, envelopeDigest(progress))).toBe(true);
    f.deliver(control(input, 'transport.ack', { msg_id: progress.msg_id }));
    expect(f.executor.snapshot().slot!.leaseDeadline).toBe(original);
    const body = { generation: slot.fence.generation, run_id: slot.fence.run_id,
      progress_msg_id: progress.msg_id, progress_seq: 1, renewal_seq: 7, deadline_ms: now + slot.leaseMs };
    for (const wrong of [{ ...body, run_id: newId() }, { ...body, generation: 2 },
      { ...body, progress_seq: 2 }, { ...body, progress_msg_id: newId() }, { ...body, renewal_seq: 0 },
      { ...body, deadline_ms: now + slot.leaseMs + 1 }, { ...body, deadline_ms: original },
      { ...body, deadline_ms: original - 1 }, { generation: body.generation, run_id: body.run_id,
        progress_msg_id: progress.msg_id, seq: 1, lease_deadline_ms: now + slot.leaseMs }]) {
      f.deliver(control(input, 'task.lease.renew', wrong));
      expect(f.executor.snapshot().slot!.leaseDeadline).toBe(original);
    }
    f.deliver(control(input, 'task.lease.renew', body), false);
    f.deliver({ ...control(input, 'task.lease.renew', body), from: { node_id: OTHER, team_id: TEAM, key_epoch: 1 } });
    f.deliver({ ...control(input, 'task.lease.renew', body), attempt: 2 });
    f.deliver({ ...control(input, 'task.lease.renew', body), task_id: newId() });
    expect(f.executor.snapshot().slot!.leaseDeadline).toBe(original);
    f.deliver(control(input, 'task.lease.renew', body));
    expect(f.executor.snapshot().slot).toMatchObject({ leaseDeadline: now + slot.leaseMs,
      lastRenewalSeq: 7, seq: 1, progress: null });
    const renewedDeadline = f.executor.snapshot().slot!.leaseDeadline;
    now += 100;
    f.deliver(control(input, 'task.lease.renew', { ...body, renewal_seq: 8, deadline_ms: now + slot.leaseMs }));
    expect(f.executor.snapshot().slot!.leaseDeadline).toBe(renewedDeadline);
    now += 200;
    f.executor.tick();
    const latest = f.outputs('task.progress').at(-1)!;
    expect(latest.body.seq).toBe(2);
    const next = { ...body, progress_seq: 2, progress_msg_id: latest.msg_id, deadline_ms: now + slot.leaseMs };
    f.deliver(control(input, 'task.lease.renew', next)); // Renewal sequence must advance independently.
    expect(f.executor.snapshot().slot!.leaseDeadline).toBe(renewedDeadline);
    f.deliver(control(input, 'task.lease.renew', { ...next, renewal_seq: 11 }));
    expect(f.executor.snapshot().slot).toMatchObject({ leaseDeadline: next.deadline_ms,
      lastRenewalSeq: 11, seq: 2, progress: null });
    now += 300;
    f.executor.tick();
    const pending = f.outputs('task.progress').at(-1)!;
    now = next.deadline_ms;
    f.deliver(control(input, 'task.lease.renew', { ...body, progress_seq: 3, renewal_seq: 12,
      progress_msg_id: pending.msg_id, deadline_ms: now + slot.leaseMs }));
    expect(f.executor.snapshot().slot!.leaseDeadline).toBe(next.deadline_ms);
    f.executor.tick();
    expect(f.executor.snapshot().slot?.phase).toBe('stopping');
    const stopping = f.executor.settle();
    await f.driver.runs[0]!.stopEntered.promise;
    expect(f.executor.snapshot().slot).not.toBeNull();
    f.driver.runs[0]!.stopped.resolve();
    await stopping;
    expect(f.outputs('task.fail')[0]!.body.summary).toBe('lease_expired');
  });

  it.each(['no_driver', 'project', 'unauthorized', 'cross_team', 'policy', 'caps', 'requires', 'expired',
    'envelope_expired'])('durably rejects %s offers', async (reason) => {
    const f = await setup(reason === 'no_driver' ? { driver: undefined } : reason === 'policy' ? { policy: () => ({ ok: false }) } : {});
    const input = offer();
    if (reason === 'project') input.body.kind = 'project';
    if (reason === 'cross_team') input.from.team_id = 'other-team';
    if (reason === 'caps') input.body.required_caps = ['tool:not-present'];
    if (reason === 'requires') input.body.requires = [{ class: 'confirm', value: 'work', reason: 'test' }];
    if (reason === 'expired') input.ts = new Date(now - 301).toISOString();
    if (reason === 'envelope_expired') {
      input.ts = new Date(now - 100).toISOString();
      input.exp = new Date(now).toISOString();
    }
    f.deliver(input, reason !== 'unauthorized');
    await f.executor.settle();
    expect(f.executor.snapshot().slot).toBeNull();
    expect(f.outputs('task.accept')).toEqual([]);
    expect(f.driver.start).not.toHaveBeenCalled();
    expect(f.outputs('task.reject')).toHaveLength(1);
    expect(f.outputs('task.reject')[0]).toMatchObject({ reply_to: input.msg_id, body: {
      reason_code: ['expired', 'envelope_expired'].includes(reason) ? 'expired' :
        reason === 'caps' ? 'unsupported_caps' : 'policy_denied',
    } });
    f.deliver(input, reason !== 'unauthorized');
    expect(f.outputs('task.reject')).toHaveLength(1);
    expect(f.runtime.pending()).toEqual([]);
  });

  it('treats failed start/stop as uncertain and never fabricates a cancel acknowledgement', async () => {
    const f = await setup();
    const input = offer();
    f.deliver(input);
    await f.executor.settle();
    f.deliver(control(input, 'task.cancel'));
    const stopping = f.executor.settle();
    const run = f.driver.runs[0]!;
    await run.stopEntered.promise;
    run.stopped.reject(new Error('driver failure'));
    await stopping;
    expect(f.executor.snapshot().slot?.phase).toBe('recovery_required');
    expect(f.outputs('task.cancel.ack')).toEqual([]);
    run.outcome.resolve(result); // Exact closed fulfillment may subsequently prove quiescence.
    await Promise.resolve();
    await f.executor.settle();
    expect(f.outputs('task.cancel.ack')).toHaveLength(1);
    const g = await setup();
    g.driver.start.mockRejectedValueOnce(new Error('ambiguous start'));
    g.deliver(offer());
    await g.executor.settle();
    await g.executor.settle();
    expect(g.executor.snapshot().slot?.phase).toBe('recovery_required');
    expect(g.driver.start).toHaveBeenCalledTimes(1);
  });

  it('close awaits confirmed stop and rejects subsequent offers', async () => {
    const f = await setup();
    f.deliver(offer());
    await f.executor.settle();
    const closing = f.executor.close();
    const run = f.driver.runs[0]!;
    await run.stopEntered.promise;
    expect(f.executor.snapshot().slot).not.toBeNull();
    run.outcome.resolve(result); // Closure also wins if stop itself remains pending.
    await closing;
    f.deliver(offer());
    await f.executor.settle();
    expect(f.driver.start).toHaveBeenCalledTimes(1);
    expect(f.outputs('task.reject').at(-1)!.body.reason_code).toBe('busy');
  });

  it('propagates real SQLite commit faults, calls a sanitized callback and never starts rolled-back work', async () => {
    const onFault = vi.fn();
    const f = await setup({ onFault });
    const input = offer();
    f.runtime.receive(input);
    failCommit(f.store, 'consume');
    expect(() => f.executor.consume(input, true)).toThrow();
    expect(f.store.state).toBe('faulted');
    expect(onFault).toHaveBeenCalledWith();
    expect(onFault.mock.calls.every((args) => args.length === 0)).toBe(true);
    expect(f.driver.start).not.toHaveBeenCalled();
    f.store.close();
    const reopened = new NodeRuntimeStore(open({ ...f.options, mode: 'open' }), LOCAL);
    expect(reopened.state(KEY)).toBeUndefined();
    expect(reopened.pending()).toEqual([input]);
    expect(reopened.all()).toEqual([]);
  });

  it('retains completed dedup and generation after reopening', async () => {
    const f = await setup();
    const input = offer();
    f.deliver(input);
    await f.executor.settle();
    f.driver.runs[0]!.outcome.resolve(result);
    await Promise.resolve();
    await f.executor.settle();
    const completed = f.outputs('task.result')[0]!;
    f.store.close();
    const runtime = new NodeRuntimeStore(open({ ...f.options, mode: 'open' }), LOCAL);
    const driver = new FakeDriver(runtime);
    const executor = new DurableExecutor({ store: runtime, nodeId: LOCAL, teamId: TEAM, seal, driver });
    await executor.recover();
    const duplicate = { ...input, msg_id: newId() };
    runtime.receive(duplicate);
    executor.consume(duplicate, true);
    await executor.settle();
    expect(driver.start).not.toHaveBeenCalled();
    expect(executor.snapshot()).toMatchObject({ generation: 1, slot: null });
    expect(runtime.all().filter((item) => item.envelope.type === 'task.result')).toEqual([
      { envelope: completed, attempts: 0, lastAt: 0 },
    ]);
  });

  it('does not treat rejected closed as proof of termination', async () => {
    const f = await setup();
    f.deliver(offer());
    await f.executor.settle();
    f.driver.runs[0]!.outcome.reject(new Error('closure unknown'));
    await Promise.resolve();
    await f.executor.settle();
    expect(f.executor.snapshot().slot?.phase).toBe('recovery_required');
    expect(f.outputs('task.result')).toEqual([]);
    expect(f.outputs('task.fail')).toEqual([]);
    f.driver.recovery = 'stopped';
    await f.executor.recover();
    expect(f.executor.snapshot().slot).toBeNull();
    expect(f.outputs('task.fail')).toHaveLength(1);
  });

  it('keeps a known run fenced after a storage fault, and close still attempts its exact stop', async () => {
    const f = await setup();
    f.deliver(offer());
    await f.executor.settle();
    const run = f.driver.runs[0]!;
    // The actual driver's stop is independent of SQLite, unlike FakeDriver's normal assertions.
    vi.mocked(run.handle.stop).mockImplementation(() => { run.stopEntered.resolve(); return run.stopped.promise; });
    f.store.close();
    const closing = f.executor.close();
    const rejected = expect(closing).rejects.toThrow();
    await run.stopEntered.promise;
    expect(run.handle.stop).toHaveBeenCalledTimes(1);
    run.stopped.resolve();
    await rejected;
    const runtime = new NodeRuntimeStore(open({ ...f.options, mode: 'open' }), LOCAL);
    expect(runtime.state(KEY)?.value).toMatchObject({ slot: { phase: 'running', fence: run.handle.fence } });
    expect(runtime.pendingEffects(undefined, true)).toHaveLength(1);
  });

  it('runs signing and policy callbacks outside the store transform', async () => {
    let runtime: NodeRuntimeStore;
    const policy = vi.fn(() => { runtime.state(KEY); return { ok: true } as const; });
    const signing = vi.fn((out: Outbound) => { runtime.state(KEY); return seal(out); });
    const f = await setup({ policy, seal: signing });
    runtime = f.runtime;
    f.deliver(offer());
    await f.executor.settle();
    expect(policy).toHaveBeenCalledTimes(1);
    expect(signing).toHaveBeenCalled();
    expect(f.executor.snapshot().slot?.phase).toBe('running');
    f.driver.runs[0]!.outcome.resolve(result);
    await Promise.resolve();
    await f.executor.settle();
  });

  it.each(['task.cancel', 'task.lease.renew', 'transport.ack'])('does not reply to unauthorized or expired %s control', async (type) => {
    const f = await setup();
    const input = offer();
    f.deliver(input);
    const before = f.executor.snapshot();
    const outbox = f.runtime.all();
    f.deliver(control(input, type), false);
    f.deliver({ ...control(input, type), from: { node_id: OTHER, team_id: 'other-team', key_epoch: 1 } });
    f.deliver({ ...control(input, type), ts: new Date(now - 1).toISOString(), exp: new Date(now).toISOString() });
    expect(f.executor.snapshot()).toEqual(before);
    expect(f.runtime.all()).toEqual(outbox);
  });

  it.each<[string, RuntimeJson]>([
    ['version', 1], ['generation', -1], ['nodeId', OTHER], ['teamId', 'wrong-team'],
    ['slot.fence', null], ['slot.fence.task_id', 'bad'], ['slot.fence.run_id', 'bad'],
    ['slot.fence.generation', 2], ['slot.fence.attempt', 1.5], ['slot.lead', 'bad'],
    ['slot.offerMsgId', 'bad'], ['slot.phase', 'done'], ['slot.mayHaveStarted', false],
    ['slot.offer', []], ['slot.offer', null], ['slot.offer.kind', 'project'], ['slot.offer.summary', 42],
    ['slot.offer.project', {}], ['slot.offer.payload_ref', 'ref'], ['slot.offer.requires', [null]],
    ['slot.offer.required_caps', [42]], ['slot.offer.lease_ms', '900'], ['slot.offer.offer_ttl_ms', 0],
    ['slot.offer.metadata', { budget: 1.5 }],
    ['slot.leaseMs', 901], ['slot.leaseDeadline', 'later'], ['slot.leaseDeadline', -1],
    ['slot.heartbeatAt', 1.5], ['slot.seq', -1], ['slot.seq', 1.5], ['slot.lastRenewalSeq', null],
    ['slot.lastRenewalSeq', -1], ['slot.lastRenewalSeq', '1'], ['slot.progress', []], ['slot.progress', null],
    ['slot.progress.msg_id', 'bad'], ['slot.progress.seq', 2], ['slot.progress.sentAt', -1],
    ['slot.progress.sentAt', EPOCH + 900], ['slot.cancelMsgId', 'bad'], ['slot.cancelMsgId', SENDER],
    ['slot.stopReason', 'unknown'], ['last', {}],
  ])('rejects malformed persisted %s without healing or invoking recovery', async (path, value) => {
    const f = await setup();
    f.deliver(offer());
    const saved = f.executor.snapshot();
    Object.assign(saved.slot!, { phase: 'running', mayHaveStarted: true, seq: 1,
      progress: { msg_id: newId(), seq: 1, sentAt: now } });
    const corrupted = saved as unknown as RuntimeJson;
    corruptField(corrupted, path, value);
    f.runtime.transition(KEY, f.runtime.state(KEY)!.revision, () => ({ state: corrupted }));
    const before = f.runtime.state(KEY);
    const executor = new DurableExecutor({ store: f.runtime, nodeId: LOCAL, teamId: TEAM, seal, driver: f.driver });
    expect(() => executor.snapshot()).toThrow('Invalid durable executor state');
    await expect(executor.recover()).rejects.toThrow('recovery required');
    expect(() => executor.tick()).toThrow('recovery required');
    expect(f.runtime.state(KEY)).toEqual(before);
    expect(f.driver.start).not.toHaveBeenCalled();
    expect(f.driver.recover).not.toHaveBeenCalled();
    expect(f.runtime.pendingEffects(undefined, true)).toHaveLength(1);
  });

  it.each<[string, RuntimeJson]>([
    ['last.fence', null], ['last.fence.task_id', 'bad'], ['last.fence.run_id', 'bad'],
    ['last.fence.attempt', 0], ['last.fence.generation', 2], ['last.lead', 'bad'],
    ['last.outcome', []], ['last.outcome.kind', 'stopped'], ['last.outcome.body', null],
    ['last.outcome.body', { cost: 1.5 }],
  ])('rejects malformed persisted terminal %s before using dedup/cancel state', async (path, value) => {
    const f = await setup();
    const input = offer();
    f.deliver(input);
    const saved = f.executor.snapshot();
    saved.last = { fence: saved.slot!.fence, lead: SENDER, outcome: structuredClone(result) };
    saved.slot = null;
    const corrupted = saved as unknown as RuntimeJson;
    corruptField(corrupted, path, value);
    f.runtime.transition(KEY, f.runtime.state(KEY)!.revision, () => ({ state: corrupted }));
    const before = f.runtime.state(KEY);
    const executor = new DurableExecutor({ store: f.runtime, nodeId: LOCAL, teamId: TEAM, seal, driver: f.driver });
    await expect(executor.recover()).rejects.toThrow('Invalid durable executor state');
    const cancel = control(input, 'task.cancel');
    f.runtime.receive(cancel);
    expect(() => executor.consume(cancel, true)).toThrow('recovery required');
    expect(f.runtime.state(KEY)).toEqual(before);
    expect(f.outputs('task.cancel.ack')).toEqual([]);
    expect(f.driver.recover).not.toHaveBeenCalled();
  });

  it('does not infer a missing renewal high-water mark from legacy progress state', async () => {
    const f = await setup();
    f.deliver(offer());
    const saved = f.runtime.state(KEY)!.value;
    const slot = (saved as Record<string, RuntimeJson>).slot as Record<string, RuntimeJson>;
    delete slot.lastRenewalSeq;
    slot.renewedSeq = 0;
    f.runtime.transition(KEY, f.runtime.state(KEY)!.revision, () => ({ state: saved }));
    await expect(f.executor.recover()).rejects.toThrow('Invalid durable executor state');
    expect(f.runtime.state(KEY)!.value).toEqual(saved);
    expect(f.driver.start).not.toHaveBeenCalled();
  });

  it.each(['consume', 'tick'] as const)('immediately stops the exact live handle after a %s storage fault; uncertain close rejects', async (operation) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const onFault = vi.fn();
    const f = await setup({ driverTimeoutMs: 50, onFault });
    const input = offer();
    f.deliver(input);
    await f.executor.settle();
    const run = f.driver.runs[0]!;
    vi.mocked(run.handle.stop).mockImplementation(() => { run.stopEntered.resolve(); return run.stopped.promise; });
    if (operation === 'consume') {
      const cancel = control(input, 'task.cancel');
      f.runtime.receive(cancel);
      failCommit(f.store, 'consume');
      expect(() => f.executor.consume(cancel, true)).toThrow();
    } else {
      f.store.close();
      now += 300;
      expect(() => f.executor.tick()).toThrow();
    }
    await run.stopEntered.promise; // No settle/close needed to initiate the safety stop.
    expect(run.handle.stop).toHaveBeenCalledTimes(1);
    expect(onFault).toHaveBeenCalledWith();
    const closing = expect(f.executor.close()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(50);
    await closing;
    run.stopped.resolve(); // Late proof cannot repair faulted storage or publish an ack.
    await vi.advanceTimersByTimeAsync(0);
    await expect(f.executor.recover()).rejects.toThrow('recovery required');
    f.store.close();
    const runtime = new NodeRuntimeStore(open({ ...f.options, mode: 'open' }), LOCAL);
    expect(runtime.state(KEY)?.value).toMatchObject({ slot: { phase: 'running', fence: run.handle.fence } });
    expect(runtime.pendingEffects(undefined, true)).toHaveLength(1);
    expect(runtime.all().some((entry) => entry.envelope.type === 'task.cancel.ack')).toBe(false);
  });

  it('bounds a hung start at the default 5000ms while tick can expire its lease', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = await setup();
    f.driver.startBarrier = deferred<void>().promise;
    f.deliver(offer());
    const settling = f.executor.settle();
    await f.driver.entered.promise;
    now += 900;
    f.executor.tick();
    expect(f.executor.snapshot().slot).toMatchObject({ phase: 'stopping', stopReason: 'lease_expired' });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(f.executor.snapshot().slot?.phase).toBe('stopping');
    await vi.advanceTimersByTimeAsync(1);
    await settling;
    expect(f.executor.snapshot().slot?.phase).toBe('recovery_required');
    await expect(f.executor.close()).rejects.toThrow('closure unconfirmed');
    expect(f.driver.start).toHaveBeenCalledTimes(1);
    expect(f.runtime.pendingEffects(undefined, true)).toHaveLength(1);
  });

  it('stops a returned start handle after an intervening consume commit failure', async () => {
    const f = await setup();
    const gate = deferred<void>();
    f.driver.startBarrier = gate.promise;
    const input = offer();
    f.deliver(input);
    const settling = f.executor.settle();
    const rejected = expect(settling).rejects.toThrow('recovery required');
    await f.driver.entered.promise;
    const run = f.driver.runs[0]!;
    vi.mocked(run.handle.stop).mockImplementation(() => { run.stopEntered.resolve(); return run.stopped.promise; });
    const cancel = control(input, 'task.cancel');
    f.runtime.receive(cancel);
    failCommit(f.store, 'consume');
    expect(() => f.executor.consume(cancel, true)).toThrow();
    gate.resolve();
    await run.stopEntered.promise;
    expect(run.handle.stop).toHaveBeenCalledTimes(1);
    run.stopped.resolve();
    await rejected;
    await expect(f.executor.close()).rejects.toThrow('recovery required');
    f.store.close();
    const runtime = new NodeRuntimeStore(open({ ...f.options, mode: 'open' }), LOCAL);
    expect(runtime.state(KEY)?.value).toMatchObject({ slot: { phase: 'starting', fence: run.handle.fence } });
    expect(runtime.pendingEffects(undefined, true)).toHaveLength(1);
    expect(runtime.all().some((entry) => entry.envelope.type === 'task.cancel.ack')).toBe(false);
  });

  it('bounds recovery and ignores late recovery results until explicit reconciliation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = await setup();
    f.deliver(offer());
    const saved = f.executor.snapshot();
    saved.slot!.phase = 'starting';
    saved.slot!.mayHaveStarted = true;
    f.runtime.transition(KEY, f.runtime.state(KEY)!.revision, () => ({ state: saved as unknown as RuntimeJson }));
    const status = deferred<'stopped' | 'unknown'>();
    f.driver.recover.mockImplementationOnce(() => status.promise);
    const executor = new DurableExecutor({ store: f.runtime, nodeId: LOCAL, teamId: TEAM,
      seal, driver: f.driver, driverTimeoutMs: 50 });
    const recovering = executor.recover();
    await vi.advanceTimersByTimeAsync(50);
    await recovering;
    expect(executor.snapshot().slot?.phase).toBe('recovery_required');
    status.resolve('stopped');
    await vi.advanceTimersByTimeAsync(0);
    expect(executor.snapshot().slot?.phase).toBe('recovery_required');
    await expect(executor.close()).rejects.toThrow('closure unconfirmed');
    f.driver.recovery = 'stopped';
    await executor.recover();
    expect(executor.snapshot().slot).toBeNull();
    expect(f.driver.start).not.toHaveBeenCalled();
  });

  it('keeps consume/tick responsive during start, fences timeout and stops a late returned handle', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = await setup({ driverTimeoutMs: 50 });
    const gate = deferred<void>();
    f.driver.startBarrier = gate.promise;
    const input = offer();
    f.deliver(input);
    const settling = f.executor.settle();
    await f.driver.entered.promise;
    now += 300;
    f.executor.tick();
    const slot = f.executor.snapshot().slot!;
    expect(slot.phase).toBe('starting');
    const progress = f.outputs('task.progress')[0]!;
    f.deliver(control(input, 'task.lease.renew', { generation: slot.fence.generation, run_id: slot.fence.run_id,
      progress_msg_id: progress.msg_id, progress_seq: 1, renewal_seq: 4, deadline_ms: now + slot.leaseMs }));
    expect(f.executor.snapshot().slot).toMatchObject({ lastRenewalSeq: 4, progress: null, leaseDeadline: now + slot.leaseMs });
    f.deliver(control(input, 'task.cancel'));
    await vi.advanceTimersByTimeAsync(50);
    await settling;
    expect(f.executor.snapshot().slot).toMatchObject({ phase: 'recovery_required', fence: slot.fence });
    f.driver.recovery = 'stopped';
    await f.executor.recover(); // In-flight invocation, not driver.recover, still owns this fence.
    expect(f.driver.recover).not.toHaveBeenCalled();
    await expect(f.executor.close()).rejects.toThrow('closure unconfirmed');
    expect(f.outputs('task.cancel.ack')).toEqual([]);
    gate.resolve();
    const run = f.driver.runs[0]!;
    await run.stopEntered.promise;
    expect(f.executor.snapshot().slot?.fence).toEqual(run.handle.fence);
    expect(f.outputs('task.cancel.ack')).toEqual([]);
    run.stopped.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await f.executor.settle();
    expect(f.executor.snapshot().slot).toBeNull();
    expect(f.outputs('task.cancel.ack')).toHaveLength(1);
    expect(f.outputs('task.result')).toEqual([]);
    expect(f.driver.start).toHaveBeenCalledTimes(1);
  });

  it('bounds a hung stop without fabricating success, then accepts late exact stop proof', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = await setup({ driverTimeoutMs: 50 });
    const input = offer();
    f.deliver(input);
    await f.executor.settle();
    f.deliver(control(input, 'task.cancel'));
    const stopping = f.executor.settle();
    const run = f.driver.runs[0]!;
    await run.stopEntered.promise;
    await vi.advanceTimersByTimeAsync(50);
    await stopping;
    expect(f.executor.snapshot().slot?.phase).toBe('recovery_required');
    await expect(f.executor.close()).rejects.toThrow('closure unconfirmed');
    expect(f.outputs('task.cancel.ack')).toEqual([]);
    expect(run.handle.stop).toHaveBeenCalledTimes(1);
    run.stopped.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await f.executor.settle();
    expect(f.executor.snapshot().slot).toBeNull();
    expect(f.outputs('task.cancel.ack')).toHaveLength(1);
  });
});

describe('DurableExecutor 单 exec 归属仲裁(C2b: 接管 fence 后陈旧 lead offer/control 被拒)', () => {
  it('fence 抬升 attempt 后拒绝被取代 lead 的陈旧 attempt offer,并放行更高 attempt', async () => {
    const f = await setup();
    const taskId = newId();
    // 接管后的新 lead(OTHER)以 fence 抬升的 attempt=2 重派,运行并结算。
    const fenced = offer({ task_id: taskId, attempt: 2, from: { node_id: OTHER, team_id: TEAM, key_epoch: 1 } });
    f.deliver(fenced);
    await f.executor.settle();
    f.driver.runs[0]!.outcome.resolve(result);
    await Promise.resolve();
    await f.executor.settle();
    expect(f.executor.snapshot()).toMatchObject({
      generation: 1, slot: null, last: { fence: { task_id: taskId, attempt: 2 }, lead: OTHER },
    });
    // 被取代的旧 lead(SENDER)迟到重放 attempt=1 与相等的 attempt=2:皆 stale_attempt 且不可重试。
    f.deliver(offer({ task_id: taskId, attempt: 1 }));
    f.deliver(offer({ task_id: taskId, attempt: 2 }));
    const rejects = f.outputs('task.reject');
    expect(rejects.map((e) => e.body.reason_code)).toEqual(['stale_attempt', 'stale_attempt']);
    expect(rejects.every((e) => e.body.retryable === false)).toBe(true);
    expect(f.executor.snapshot().slot).toBeNull();
    expect(f.driver.start).toHaveBeenCalledTimes(1); // 陈旧 attempt 绝不二次执行
    // 真正更高的 attempt(下一轮 fence)仍可被接纳,generation 单调推进。
    f.deliver(offer({ task_id: taskId, attempt: 3, from: { node_id: OTHER, team_id: TEAM, key_epoch: 1 } }));
    expect(f.executor.snapshot().slot).toMatchObject({ fence: { task_id: taskId, attempt: 3, generation: 2 }, lead: OTHER });
  });

  it('忽略非当前 lead/attempt 的取消控制,而真正属主仍可取消(守卫基于身份而非一律拒绝)', async () => {
    const f = await setup();
    const input = offer(); // from SENDER, attempt=1
    f.deliver(input);
    await f.executor.settle();
    expect(f.executor.snapshot().slot?.phase).toBe('running');
    const before = f.executor.snapshot();
    const outbox = f.runtime.all();
    // 同队但非属主的 lead(OTHER)即便精确命中 task_id/attempt 也不能取消该运行。
    f.deliver({ ...control(input, 'task.cancel'), from: { node_id: OTHER, team_id: TEAM, key_epoch: 1 } });
    // 当前 lead 针对被 fence 取代的 attempt(2≠1)同样被忽略。
    f.deliver({ ...control(input, 'task.cancel'), attempt: 2 });
    expect(f.executor.snapshot()).toEqual(before); // 运行未受影响:仍 running,无 stopping,无 cancel.ack
    expect(f.runtime.all()).toEqual(outbox);
    // 反证:真正属主(SENDER, attempt=1)的取消照常生效,证明守卫基于身份而非把取消整体禁用。
    f.deliver(control(input, 'task.cancel'));
    expect(f.executor.snapshot().slot?.phase).toBe('stopping');
  });

  it('单槽串行归属:在途运行期间被 fence 的更高 attempt offer 得 busy(可重试),结算后方可接管', async () => {
    const f = await setup();
    const taskId = newId();
    const first = offer({ task_id: taskId, attempt: 1 }); // 旧 lead SENDER
    f.deliver(first);
    await f.executor.settle();
    expect(f.executor.snapshot().slot).toMatchObject({ fence: { task_id: taskId, attempt: 1, generation: 1 }, lead: SENDER });
    // 后继 lead 的 fence offer 无法抢占在途单槽 → busy(可重试),归属不变。
    f.deliver(offer({ task_id: taskId, attempt: 2, from: { node_id: OTHER, team_id: TEAM, key_epoch: 1 } }));
    expect(f.outputs('task.reject').at(-1)!.body).toMatchObject({ reason_code: 'busy', retryable: true });
    expect(f.executor.snapshot().slot!.lead).toBe(SENDER);
    // 旧运行结算 → last 记录 SENDER/attempt=1。
    f.driver.runs[0]!.outcome.resolve(result);
    await Promise.resolve();
    await f.executor.settle();
    expect(f.executor.snapshot()).toMatchObject({ generation: 1, slot: null, last: { fence: { attempt: 1 }, lead: SENDER } });
    // 后继 lead 抬升 attempt 后重派(attempt=3,与 busy 那发 attempt=2 不同 → 不触发 R1 去重)→ 接纳、
    // generation 单调推进(1→2)、归属移交 OTHER;accept 路由到新 lead。
    f.deliver(offer({ task_id: taskId, attempt: 3, from: { node_id: OTHER, team_id: TEAM, key_epoch: 1 } }));
    expect(f.executor.snapshot().slot).toMatchObject({ fence: { task_id: taskId, attempt: 3, generation: 2 }, lead: OTHER });
    expect(f.outputs('task.accept').at(-1)!.to).toMatchObject({ node_id: OTHER });
  });
});