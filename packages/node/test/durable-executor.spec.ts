import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envelopeDigest, newId, type EnvelopeV1 } from '@qlong/core';
import type { ArtifactPublisher, ExecutorWorkspace, FencedDriver, RunContext, RunFence, RunHandle, RunOutcome } from '../src/driver/run-handle.js';
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

/** e2d-2:携契约的 PROJECT offer(共享产物仓交付);与 lead 派发形状一致。 */
function projectOffer(overrides: Partial<EnvelopeV1> = {}): EnvelopeV1 {
  return offer({ body: { kind: 'project', summary: 'build it', lease_ms: 900, offer_ttl_ms: 300,
    contract: { deliverables: [{ path: 'dist/report.md' }] } }, ...overrides });
}

class FakeDriver implements FencedDriver {
  readonly entered = deferred<void>();
  readonly runs: Array<{
    handle: RunHandle;
    outcome: ReturnType<typeof deferred<RunOutcome>>;
    stopped: ReturnType<typeof deferred<void>>;
    stopEntered: ReturnType<typeof deferred<void>>;
    ctx?: RunContext;
  }> = [];
  startBarrier: Promise<void> = Promise.resolve();
  recovery: 'stopped' | 'unknown' = 'unknown';

  constructor(readonly store: NodeRuntimeStore) {}

  start = vi.fn(async (fence: RunFence, _offer: Record<string, unknown>, ctx?: RunContext): Promise<RunHandle> => {
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
    this.runs.push({ handle, outcome, stopped, stopEntered, ctx });
    this.entered.resolve();
    await this.startBarrier;
    return handle;
  });

  recover = vi.fn(async (fence: RunFence): Promise<'stopped' | 'unknown'> => {
    expect(this.store.state(KEY)?.value).toMatchObject({ slot: { fence } });
    return this.recovery;
  });
}

/** e2d-1c:记录型 ExecutorWorkspace 桩——prepare 断言其在事务外、'starting' 提交前运行。 */
class FakeWorkspace implements ExecutorWorkspace {
  readonly prepared: RunFence[] = [];
  readonly released: RunFence[] = [];
  failPrepare = false;
  constructor(readonly store: NodeRuntimeStore) {}
  async prepare(fence: Readonly<RunFence>, _offer: Record<string, unknown>): Promise<RunContext> {
    // 读取会在事务重入时抛错;断言 prepare 在 SQL 事务外、且早于 'starting'/mayHaveStarted 提交。
    expect(this.store.state(KEY)?.value).toMatchObject({ slot: { phase: 'prepared', fence } });
    if (this.failPrepare) throw new Error('prepare boom');
    this.prepared.push({ ...fence });
    return { cwd: `/ws/${fence.run_id}` };
  }
  async release(fence: Readonly<RunFence>): Promise<void> { this.released.push({ ...fence }); }
}

/** e2d-2:记录型 ArtifactPublisher 桩——publish 断言其在事务外(结果尚未密封)运行,返回注入 artifacts 的 outcome。 */
class FakePublisher implements ArtifactPublisher {
  readonly published: Array<{ fence: RunFence; offer: Record<string, unknown>; ctx?: RunContext; outcome: RunOutcome }> = [];
  fail = false;
  invalid = false;
  constructor(readonly store: NodeRuntimeStore) {}
  async publish(fence: Readonly<RunFence>, offer: Record<string, unknown>, ctx: RunContext | undefined, outcome: RunOutcome): Promise<RunOutcome> {
    // 读取会在事务重入时抛错;断言 publish 在 SQL 事务外、且结果尚未密封(slot 仍在)。
    expect(this.store.state(KEY)?.value).toMatchObject({ slot: { fence } });
    if (this.fail) throw new Error('publish boom');
    this.published.push({ fence: { ...fence }, offer: structuredClone(offer), ctx, outcome: structuredClone(outcome) });
    if (this.invalid) return { kind: 'bogus' } as unknown as RunOutcome;
    return { kind: 'result', body: { ...outcome.body,
      artifacts: [{ repo: 'r', manifest: 'm', branch: `qlong/${fence.task_id}/a${fence.attempt}` }] } };
  }
}

/** 装配带 FakeDriver + FakeWorkspace + FakePublisher 的执行器;三者共享同一真实临时 SQLite。 */
async function setupPub(recovered = true) {
  const f = fixture();
  const driver = new FakeDriver(f.runtime);
  const workspace = new FakeWorkspace(f.runtime);
  const publisher = new FakePublisher(f.runtime);
  const executor = new DurableExecutor({ store: f.runtime, nodeId: LOCAL, teamId: TEAM, seal, driver, workspace, publisher });
  if (recovered) await executor.recover();
  const deliver = (input: EnvelopeV1, authorized = true) => {
    expect(['new', 'duplicate']).toContain(f.runtime.receive(input));
    executor.consume(input, authorized);
  };
  const outputs = (type: string) => f.runtime.all().map((item) => item.envelope).filter((item) => item.type === type);
  return { ...f, driver, workspace, publisher, executor, deliver, outputs };
}

/** 装配带 FakeDriver + FakeWorkspace 的执行器;两者共享同一真实临时 SQLite。 */
async function setupWs(recovered = true) {
  const f = fixture();
  const driver = new FakeDriver(f.runtime);
  const workspace = new FakeWorkspace(f.runtime);
  const executor = new DurableExecutor({ store: f.runtime, nodeId: LOCAL, teamId: TEAM, seal, driver, workspace });
  if (recovered) await executor.recover();
  const deliver = (input: EnvelopeV1, authorized = true) => {
    expect(['new', 'duplicate']).toContain(f.runtime.receive(input));
    executor.consume(input, authorized);
  };
  const outputs = (type: string) => f.runtime.all().map((item) => item.envelope).filter((item) => item.type === type);
  return { ...f, driver, workspace, executor, deliver, outputs };
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

describe('DurableExecutor 接管↔恢复联动(C2c: recover 不复活旧 lead 陈旧 run)', () => {
  it('运行中重启:recover 可证静默时对账陈旧 run 为终态而绝不复活,清空 slot 后新 lead 更高 attempt 可接管', async () => {
    const f = await setup();
    const taskId = newId();
    f.deliver(offer({ task_id: taskId, attempt: 1 })); // 旧 lead SENDER attempt 1
    await f.executor.settle();
    expect(f.executor.snapshot().slot).toMatchObject({ fence: { task_id: taskId, attempt: 1 }, lead: SENDER, phase: 'running' });
    // 执行方在运行中重启:关闭 store,以持久句柄重开新 executor;C1 recover 据 pid 消失判 stopped(可证静默)。
    f.store.close();
    const runtime = new NodeRuntimeStore(open({ ...f.options, mode: 'open' }), LOCAL);
    const driver = new FakeDriver(runtime);
    driver.recovery = 'stopped';
    const executor = new DurableExecutor({ store: runtime, nodeId: LOCAL, teamId: TEAM, seal, driver });
    const outputs = (type: string) => runtime.all().map((i) => i.envelope).filter((i) => i.type === type);
    const redeliver = (input: EnvelopeV1) => { expect(['new', 'duplicate']).toContain(runtime.receive(input)); executor.consume(input, true); };
    await executor.recover();
    // 不复活:recover 绝不重新 start 陈旧 run;对账为终态(failed/execution_interrupted),slot 清空、last 记旧 lead/attempt。
    expect(driver.start).not.toHaveBeenCalled();
    expect(executor.snapshot()).toMatchObject({ generation: 1, slot: null, last: { fence: { task_id: taskId, attempt: 1 }, lead: SENDER } });
    expect(outputs('task.fail').map((e) => e.body.summary)).toEqual(['execution_interrupted']);
    // 陈旧 attempt 无论来自哪个 lead 皆被 stale_attempt 拒(守卫基于 last 高水位、与 sender 无关):
    // OTHER 滞后的 attempt=1(尚未 R1 记录 → 抵达仲裁)→ stale_attempt,绝不复活已对账的陈旧 run。
    redeliver(offer({ task_id: taskId, attempt: 1, from: { node_id: OTHER, team_id: TEAM, key_epoch: 1 } }));
    expect(outputs('task.reject').at(-1)!.body).toMatchObject({ reason_code: 'stale_attempt', retryable: false });
    expect(driver.start).not.toHaveBeenCalled();
    // 接管后的新 lead(OTHER)以更高 attempt=2 → 放行、generation 单调推进(1→2)、归属移交 OTHER。
    redeliver(offer({ task_id: taskId, attempt: 2, from: { node_id: OTHER, team_id: TEAM, key_epoch: 1 } }));
    expect(executor.snapshot().slot).toMatchObject({ fence: { task_id: taskId, attempt: 2, generation: 2 }, lead: OTHER });
  });

  it('无法证明静默时 recover 判 unknown → recovery_required 占用单槽,新 lead offer 得 busy(可重试)而非在不确定期复活陈旧 run', async () => {
    const f = await setup();
    const taskId = newId();
    f.deliver(offer({ task_id: taskId, attempt: 1 }));
    await f.executor.settle();
    f.store.close();
    const runtime = new NodeRuntimeStore(open({ ...f.options, mode: 'open' }), LOCAL);
    const driver = new FakeDriver(runtime); // recovery 默认 'unknown':活孤儿不可证身份
    const executor = new DurableExecutor({ store: runtime, nodeId: LOCAL, teamId: TEAM, seal, driver });
    const outputs = (type: string) => runtime.all().map((i) => i.envelope).filter((i) => i.type === type);
    const redeliver = (input: EnvelopeV1) => { expect(['new', 'duplicate']).toContain(runtime.receive(input)); executor.consume(input, true); };
    await executor.recover();
    expect(driver.start).not.toHaveBeenCalled(); // 不复活
    expect(executor.snapshot().slot).toMatchObject({ phase: 'recovery_required', fence: { task_id: taskId, attempt: 1 }, lead: SENDER });
    // 陈旧 run 未对账为终态前占用单槽:新 lead 更高 attempt 得 busy(可重试),绝不在不确定期并发复活。
    redeliver(offer({ task_id: taskId, attempt: 2, from: { node_id: OTHER, team_id: TEAM, key_epoch: 1 } }));
    expect(outputs('task.reject').at(-1)!.body).toMatchObject({ reason_code: 'busy', retryable: true });
    expect(driver.start).not.toHaveBeenCalled();
  });
});

describe('DurableExecutor per-fence 工作区生命周期(e2d-1)', () => {
  it('在 driver.start 前于事务外 prepare 工作区,并把解析 cwd 传给驱动', async () => {
    const f = await setupWs();
    const input = offer();
    f.deliver(input);
    const fence = f.executor.snapshot().slot!.fence;
    await f.executor.settle();
    // prepare 早于 'starting' 提交(FakeWorkspace 内部断言 phase='prepared' 且可读取=事务外)
    expect(f.workspace.prepared).toEqual([{ ...fence }]);
    expect(f.driver.runs[0]!.ctx).toEqual({ cwd: `/ws/${fence.run_id}` });
    expect(f.executor.snapshot().slot?.phase).toBe('running');
  });

  it('运行中不 release;结果提交后才 release(finish 之后、事务外)', async () => {
    const f = await setupWs();
    const input = offer();
    f.deliver(input);
    await f.executor.settle();
    const fence = f.executor.snapshot().slot!.fence;
    expect(f.workspace.released).toEqual([]); // 在途不提前清理
    f.driver.runs[0]!.outcome.resolve(result);
    await Promise.resolve();
    await f.executor.settle();
    expect(f.executor.snapshot().slot).toBeNull();
    expect(f.outputs('task.result')).toHaveLength(1);
    expect(f.workspace.released).toEqual([{ ...fence }]); // 提交后清理
  });

  it('取消在途 run:静默前不 release(保留在途产物),静默+提交后才 release', async () => {
    const f = await setupWs();
    const input = offer();
    f.deliver(input);
    await f.executor.settle();
    const run = f.driver.runs[0]!;
    const fence = f.executor.snapshot().slot!.fence;
    f.deliver(control(input, 'task.cancel'));
    const stopping = f.executor.settle();
    await run.stopEntered.promise;
    expect(f.executor.snapshot().slot?.phase).toBe('stopping');
    expect(f.workspace.released).toEqual([]); // 进程未静默,工作区必须保留
    run.stopped.resolve();
    await stopping;
    expect(f.executor.snapshot().slot).toBeNull();
    expect(f.outputs('task.cancel.ack')).toHaveLength(1);
    expect(f.workspace.released).toEqual([{ ...fence }]);
  });

  it('prepare 失败 → task.fail(workspace_prepare_failed),不触发 driver.start,并 release 且不转 recovery_required', async () => {
    const f = await setupWs();
    f.workspace.failPrepare = true;
    const input = offer();
    f.deliver(input);
    const fence = f.executor.snapshot().slot!.fence;
    await f.executor.settle();
    expect(f.driver.start).not.toHaveBeenCalled();
    expect(f.executor.snapshot().slot).toBeNull(); // 干净失败,未升级 recovery_required
    expect(f.outputs('task.fail')[0]!.body.summary).toBe('workspace_prepare_failed');
    expect(f.workspace.released).toEqual([{ ...fence }]); // 部分目录被清理
  });

  it('未注入 workspace 端口 → driver.start 收到 ctx undefined(向后兼容)', async () => {
    const f = await setup();
    const input = offer();
    f.deliver(input);
    await f.executor.settle();
    expect(f.driver.runs[0]!.ctx).toBeUndefined();
    expect(f.executor.snapshot().slot?.phase).toBe('running');
  });

  /** 模拟崩溃后重启:持久化一个 mayHaveStarted 的 run,用新执行器+新工作区 recover。 */
  async function restartWith(recovery: 'stopped' | 'unknown') {
    const f = fixture();
    const driver1 = new FakeDriver(f.runtime);
    const ws1 = new FakeWorkspace(f.runtime);
    const ex1 = new DurableExecutor({ store: f.runtime, nodeId: LOCAL, teamId: TEAM, seal, driver: driver1, workspace: ws1 });
    await ex1.recover();
    const input = offer();
    f.runtime.receive(input); ex1.consume(input, true);
    const saved = ex1.snapshot();
    saved.slot!.phase = 'running'; saved.slot!.mayHaveStarted = true;
    f.runtime.transition(KEY, f.runtime.state(KEY)!.revision, () => ({ state: saved as unknown as RuntimeJson }));
    const fence = saved.slot!.fence;
    f.store.close();
    const runtime = new NodeRuntimeStore(open({ ...f.options, mode: 'open' }), LOCAL);
    const driver2 = new FakeDriver(runtime);
    driver2.recovery = recovery;
    const ws2 = new FakeWorkspace(runtime);
    const ex2 = new DurableExecutor({ store: runtime, nodeId: LOCAL, teamId: TEAM, seal, driver: driver2, workspace: ws2 });
    const outputs = (type: string) => runtime.all().map((i) => i.envelope).filter((i) => i.type === type);
    await ex2.recover();
    return { driver2, ws2, ex2, fence, outputs };
  }

  it('重启恢复 stopped → finish+release 清理上一进程遗留工作区(按 fence,无需本进程 prepare)', async () => {
    const { driver2, ws2, ex2, fence, outputs } = await restartWith('stopped');
    expect(driver2.recover).toHaveBeenCalledWith(fence);
    expect(ex2.snapshot().slot).toBeNull();
    expect(outputs('task.fail')[0]!.body.summary).toBe('execution_interrupted');
    expect(ws2.prepared).toEqual([]);            // 本进程从未 prepare
    expect(ws2.released).toEqual([{ ...fence }]); // 仍按 fence release 清理遗留
  });

  it('重启恢复 unknown → recovery_required,不 release(保留在途产物待运维)', async () => {
    const { ws2, ex2, fence } = await restartWith('unknown');
    expect(ex2.snapshot().slot).toMatchObject({ phase: 'recovery_required', fence });
    expect(ws2.released).toEqual([]); // 不可证静默时绝不清理
  });
});

describe('DurableExecutor 完成路径产物发布(e2d-2)', () => {
  it('结果完成时于事务外 publish(传 fence/offer/ctx/outcome),并把注入的 artifacts 密封进 task.result', async () => {
    const f = await setupPub();
    const input = offer();
    f.deliver(input);
    await f.executor.settle();
    const fence = f.executor.snapshot().slot!.fence;
    f.driver.runs[0]!.outcome.resolve(result);
    await Promise.resolve();
    await f.executor.settle();
    expect(f.publisher.published).toHaveLength(1);
    expect(f.publisher.published[0]!.fence).toEqual({ ...fence });
    expect(f.publisher.published[0]!.offer).toMatchObject({ kind: 'aid', summary: 'trusted embedded work' });
    expect(f.publisher.published[0]!.ctx).toEqual({ cwd: `/ws/${fence.run_id}` }); // ctx 从 start 续接到完成路径
    expect(f.publisher.published[0]!.outcome).toEqual(result);                      // 收到驱动原始 result
    expect(f.executor.snapshot().slot).toBeNull();
    const sealed = f.outputs('task.result');
    expect(sealed).toHaveLength(1);
    expect(sealed[0]!.body.artifacts).toEqual([{ repo: 'r', manifest: 'm', branch: `qlong/${fence.task_id}/a${fence.attempt}` }]);
    expect(f.workspace.released).toEqual([{ ...fence }]); // publish 后仍 release
  });

  it('publish 抛错 → 干净 task.fail(artifact_publish_failed),绝不伪装成功交付,仍 release', async () => {
    const f = await setupPub();
    f.publisher.fail = true;
    const input = offer();
    f.deliver(input);
    await f.executor.settle();
    const fence = f.executor.snapshot().slot!.fence;
    f.driver.runs[0]!.outcome.resolve(result);
    await Promise.resolve();
    await f.executor.settle();
    expect(f.executor.snapshot().slot).toBeNull();          // 干净失败,未升级 recovery_required
    expect(f.outputs('task.result')).toHaveLength(0);        // 未发布产物绝不密封为 result
    expect(f.outputs('task.fail')[0]!.body.summary).toBe('artifact_publish_failed');
    expect(f.workspace.released).toEqual([{ ...fence }]);
  });

  it('publish 返回非法 outcome → fail-closed task.fail,不密封畸形结果', async () => {
    const f = await setupPub();
    f.publisher.invalid = true;
    const input = offer();
    f.deliver(input);
    await f.executor.settle();
    f.driver.runs[0]!.outcome.resolve(result);
    await Promise.resolve();
    await f.executor.settle();
    expect(f.outputs('task.result')).toHaveLength(0);
    expect(f.outputs('task.fail')[0]!.body.summary).toBe('artifact_publish_failed');
    expect(f.executor.snapshot().slot).toBeNull();
  });

  it('结果已就绪但随后取消:stopReason 优先 → 不 publish,密封 cancel.ack 而非 result', async () => {
    const f = await setupPub();
    const input = offer();
    f.deliver(input);
    await f.executor.settle();
    f.driver.runs[0]!.outcome.resolve(result); // live.outcome = result
    await Promise.resolve();
    f.deliver(control(input, 'task.cancel'));    // slot.stopReason = 'cancel'
    await f.executor.settle();
    expect(f.publisher.published).toEqual([]);   // 取消的 run 不发布产物(避免为陈旧完成做 git I/O)
    expect(f.outputs('task.result')).toHaveLength(0);
    expect(f.outputs('task.cancel.ack')).toHaveLength(1);
    expect(f.executor.snapshot().slot).toBeNull();
  });

  it('未注入 publisher → result 原样密封,无 artifacts(向后兼容)', async () => {
    const f = await setupWs();
    const input = offer();
    f.deliver(input);
    await f.executor.settle();
    f.driver.runs[0]!.outcome.resolve(result);
    await Promise.resolve();
    await f.executor.settle();
    const sealed = f.outputs('task.result');
    expect(sealed).toHaveLength(1);
    expect(sealed[0]!.body).toMatchObject(result.body); // 原样密封
    expect(sealed[0]!.body.artifacts).toBeUndefined();  // 无 artifacts 注入
  });
});

describe('DurableExecutor PROJECT 准入门控(e2d-2)', () => {
  it('装配 publisher(共享产物仓已配置)→ PROJECT offer 准入,task.accept 并建槽', async () => {
    const f = await setupPub();
    const input = projectOffer();
    f.deliver(input);
    expect(f.outputs('task.accept')).toHaveLength(1);
    expect(f.executor.snapshot().slot).toMatchObject({ offer: { kind: 'project' }, fence: { task_id: input.task_id, attempt: 1 } });
  });

  it('未装配 publisher(无共享产物仓)→ PROJECT offer policy_denied fail-closed,不建槽', async () => {
    const f = await setup(); // 无 publisher
    const input = projectOffer();
    f.deliver(input);
    expect(f.outputs('task.reject').at(-1)!.body).toMatchObject({ reason_code: 'policy_denied' });
    expect(f.executor.snapshot().slot).toBeNull();
  });

  it('PROJECT offer 缺契约 → 即便装配 publisher 仍 policy_denied(形状闸)', async () => {
    const f = await setupPub();
    const input = offer({ body: { kind: 'project', summary: 'build it', lease_ms: 900, offer_ttl_ms: 300 } });
    f.deliver(input);
    expect(f.outputs('task.reject').at(-1)!.body).toMatchObject({ reason_code: 'policy_denied' });
    expect(f.executor.snapshot().slot).toBeNull();
  });

  it('aid offer 不受门控影响:无 publisher 仍准入(向后兼容)', async () => {
    const f = await setup(); // 无 publisher
    const input = offer();
    f.deliver(input);
    expect(f.outputs('task.accept')).toHaveLength(1);
    expect(f.executor.snapshot().slot).toMatchObject({ offer: { kind: 'aid' } });
  });
});