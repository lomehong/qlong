import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PARAMS, lostAfterMs, newId, type EnvelopeV1 } from '@qlong/core';
import { DurableLead, leadStateKey, type DurableLeadOptions } from '../src/runtime/lead.js';
import { NodeRuntimeStore, type RuntimeJson } from '../src/runtime/store.js';
import { DurableTaskReporter, TASK_REPORT_KIND, type TaskReport, type TaskReportSink } from '../src/runtime/report.js';
import type { Outbound } from '../src/wire.js';
import { env, fixture, LOCAL, open, OTHER } from './runtime-store-helpers.js';

const TEAM = 'lead-test-team';
const EXEC = '20000000-0000-4000-8000-000000000009';
const EXEC2 = '20000000-0000-4000-8000-00000000000a';
const EXEC3 = '20000000-0000-4000-8000-00000000000b';
const EPOCH = Date.parse('2026-09-16T12:00:00Z');
// The machine derives the offer deadline from params (it ignores offerBody.offer_ttl_ms), so the
// test's ttl must equal the aid default for the arithmetic to line up with the persisted deadline.
const TTL = DEFAULT_PARAMS.offerTtlMsAid;
const LEASE = 90_000; // lostAfterMs = 2*(90000/3)+30000 = 90000
let now = EPOCH;

function seal(out: Outbound): EnvelopeV1 {
  return env({
    type: out.type, ts: new Date(now).toISOString(), exp: new Date(now + 60_000).toISOString(),
    from: { node_id: LOCAL, team_id: TEAM, key_epoch: 1 }, to: { node_id: out.to_node, team_id: TEAM },
    task_id: out.task_id!, attempt: out.attempt!, ...(out.reply_to ? { reply_to: out.reply_to } : {}), body: out.body,
  });
}

function receipt(type: string, taskId: string, attempt: number, body: Record<string, unknown> = {}, from = EXEC): EnvelopeV1 {
  return env({
    type, ts: new Date(now).toISOString(), exp: new Date(now + 60_000).toISOString(),
    from: { node_id: from, team_id: TEAM, key_epoch: 1 }, to: { node_id: LOCAL, team_id: TEAM },
    task_id: taskId, attempt, body,
  });
}

const offerBody = (kind: 'aid' | 'project' = 'aid'): Record<string, unknown> =>
  ({ kind, summary: 'work', offer_ttl_ms: TTL, lease_ms: LEASE });

function setup(overrides: Partial<DurableLeadOptions> = {}) {
  const f = fixture();
  const lead = new DurableLead({ store: f.runtime, nodeId: LOCAL, teamId: TEAM, seal, ...overrides });
  const deliver = (input: EnvelopeV1, authorized = true): void => {
    expect(['new', 'duplicate']).toContain(f.runtime.receive(input));
    lead.consume(input, authorized);
  };
  const outputs = (type: string): EnvelopeV1[] => f.runtime.all().map((i) => i.envelope).filter((i) => i.type === type);
  const reports = (): TaskReport[] => f.runtime.pendingEffects(undefined, true)
    .filter((e) => e.kind === TASK_REPORT_KIND).map((e) => e.payload as unknown as TaskReport);
  return { ...f, lead, deliver, outputs, reports };
}

beforeEach(() => { now = EPOCH; vi.spyOn(Date, 'now').mockImplementation(() => now); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('DurableLead minimal lifecycle (B1b: originate/dispatch/receipt + report intents)', () => {
  it('originates a led task in drafting without any report intent or outbound offer', () => {
    const f = setup();
    const taskId = newId();
    expect(f.lead.originate(taskId, 'aid')).toBe(true);
    expect(f.lead.snapshot(taskId)).toMatchObject({ state: 'drafting', attempt: 0, target: null, task_seq: 0 });
    expect(f.runtime.all()).toEqual([]);
    expect(f.reports()).toEqual([]);
    expect(f.lead.originate(taskId, 'aid')).toBe(false); // idempotent
    expect(f.lead.snapshot(taskId)).toMatchObject({ state: 'drafting', task_seq: 0 });
  });

  it('dispatches an offer and atomically records a durable offered report intent', () => {
    const f = setup();
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    expect(f.lead.dispatch(taskId, EXEC, offerBody())).toBe(true);
    const offers = f.outputs('task.offer');
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ type: 'task.offer', to: { node_id: EXEC }, task_id: taskId, attempt: 1 });
    expect(f.lead.snapshot(taskId)).toMatchObject({ state: 'offered', attempt: 1, target: EXEC, task_seq: 1 });
    expect(f.reports()).toEqual([{
      task_id: taskId, team_id: TEAM, lead: LOCAL, exec: EXEC, attempt: 1, status: 'offered', type: 'aid', task_seq: 1,
    }]);
    expect(f.lead.dispatch(taskId, EXEC, offerBody())).toBe(false); // already left drafting
    expect(f.outputs('task.offer')).toHaveLength(1);
  });

  it('consumes an accept into running and appends the next report revision', () => {
    const f = setup();
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    f.lead.dispatch(taskId, EXEC, offerBody());
    f.deliver(receipt('task.accept', taskId, 1, { lease_ms: LEASE }));
    expect(f.lead.snapshot(taskId)).toMatchObject({ state: 'running', attempt: 1, target: EXEC, task_seq: 2 });
    expect(f.reports().map((r) => [r.status, r.task_seq])).toEqual([['offered', 1], ['running', 2]]);
  });

  it('consumes a result into done and a fatal fail into failed, each reporting the terminal revision', () => {
    const done = setup({ validateAcceptance: () => true });
    const doneTask = newId();
    done.lead.originate(doneTask, 'project');
    done.lead.dispatch(doneTask, EXEC, offerBody('project'));
    done.deliver(receipt('task.accept', doneTask, 1, { lease_ms: LEASE }));
    done.deliver(receipt('task.result', doneTask, 1, { status: 'done' }));
    expect(done.lead.snapshot(doneTask)).toMatchObject({ state: 'done', task_seq: 3 });
    expect(done.reports().map((r) => [r.status, r.task_seq])).toEqual([['offered', 1], ['running', 2], ['done', 3]]);
    expect(done.reports()[2]).toMatchObject({ status: 'done', type: 'project', exec: EXEC, attempt: 1 });

    const failed = setup();
    const failedTask = newId();
    failed.lead.originate(failedTask, 'aid');
    failed.lead.dispatch(failedTask, EXEC, offerBody());
    failed.deliver(receipt('task.accept', failedTask, 1, { lease_ms: LEASE }));
    failed.deliver(receipt('task.fail', failedTask, 1, { reason_code: 'other', retryable: false }));
    expect(failed.lead.snapshot(failedTask)).toMatchObject({ state: 'failed', task_seq: 3 });
    expect(failed.reports().at(-1)).toMatchObject({ status: 'failed', task_seq: 3, type: 'aid' });
  });

  it('ignores receipts from a non-target node, a mismatched attempt, or an unauthorized sender', () => {
    const f = setup();
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    f.lead.dispatch(taskId, EXEC, offerBody());
    const before = f.lead.snapshot(taskId);
    f.deliver(receipt('task.accept', taskId, 1, {}, OTHER)); // wrong node
    f.deliver(receipt('task.accept', taskId, 2, {})); // wrong attempt
    f.deliver(receipt('task.accept', taskId, 1, {}), false); // unauthorized
    expect(f.lead.snapshot(taskId)).toMatchObject({ state: before!.state, attempt: before!.attempt, task_seq: before!.task_seq });
    expect(f.reports().map((r) => r.status)).toEqual(['offered']);
  });

  it('aligns task_seq across a store reopen and never fabricates or resets a report revision', () => {
    const f = setup();
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    f.lead.dispatch(taskId, EXEC, offerBody());
    f.deliver(receipt('task.accept', taskId, 1, { lease_ms: LEASE }));
    expect(f.lead.snapshot(taskId)?.task_seq).toBe(2);
    f.store.close();

    const runtime = new NodeRuntimeStore(open({ ...f.options, mode: 'open' }), LOCAL);
    const lead = new DurableLead({ store: runtime, nodeId: LOCAL, teamId: TEAM, seal });
    expect(lead.snapshot(taskId)).toMatchObject({ state: 'running', attempt: 1, target: EXEC, task_seq: 2 });
    const pending = runtime.pendingEffects(undefined, true).filter((e) => e.kind === TASK_REPORT_KIND);
    expect(pending.map((e) => (e.payload as unknown as TaskReport).task_seq)).toEqual([1, 2]);

    const result = receipt('task.result', taskId, 1, { status: 'done' });
    expect(['new', 'duplicate']).toContain(runtime.receive(result));
    lead.consume(result, true);
    expect(lead.snapshot(taskId)).toMatchObject({ state: 'done', task_seq: 3 });
  });

  it('produces report intents the DurableTaskReporter delivers to the center in task_seq order', async () => {
    const f = setup({ validateAcceptance: () => true });
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    f.lead.dispatch(taskId, EXEC, offerBody());
    f.deliver(receipt('task.accept', taskId, 1, { lease_ms: LEASE }));
    f.deliver(receipt('task.result', taskId, 1, { status: 'done' }));
    const delivered: TaskReport[] = [];
    const post = vi.fn<TaskReportSink>(async (r) => { delivered.push(r); return { ok: true, status: 200 }; });
    const reporter = new DurableTaskReporter({ store: f.runtime, post });
    expect(await reporter.flush()).toEqual({ delivered: 3, pending: 0 });
    expect(delivered.map((r) => [r.status, r.task_seq])).toEqual([['offered', 1], ['running', 2], ['done', 3]]);
    expect(f.reports()).toEqual([]);
  });

  it('rejects malformed persisted lead state without healing, dispatching, or reporting', () => {
    const f = setup();
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    f.lead.dispatch(taskId, EXEC, offerBody());
    const key = leadStateKey(taskId);
    const saved = f.runtime.state(key)!.value as Record<string, RuntimeJson>;
    saved.state = 'bogus';
    f.runtime.transition(key, f.runtime.state(key)!.revision, () => ({ state: saved as RuntimeJson }));
    const lead = new DurableLead({ store: f.runtime, nodeId: LOCAL, teamId: TEAM, seal });
    expect(() => lead.snapshot(taskId)).toThrow('Invalid durable lead state');
    expect(() => lead.dispatch(taskId, EXEC, offerBody())).toThrow('recovery required');
    expect(f.reports().map((r) => r.status)).toEqual(['offered']);
  });
});

describe('DurableLead timers/reclaim/escalate/redispatch (B1c: durable lifecycle enrichment)', () => {
  it('fires a persisted offer_ttl on tick, reclaims with a task.cancel and reports the revision', () => {
    const f = setup();
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    f.lead.dispatch(taskId, EXEC, offerBody());
    expect(f.lead.snapshot(taskId)?.offerTtlUntil).toBe(EPOCH + TTL); // deadline persisted for restart

    now += TTL; // not yet due (strict >= at the deadline instant fires; step one past to be unambiguous)
    f.lead.tick(now);
    expect(f.lead.snapshot(taskId)).toMatchObject({ state: 'reclaiming' });
    expect(f.outputs('task.cancel')).toHaveLength(1);
    expect(f.outputs('task.cancel')[0]).toMatchObject({ to: { node_id: EXEC }, task_id: taskId, attempt: 1, body: { reason: 'reclaim' } });
    expect(f.reports().map((r) => [r.status, r.task_seq])).toEqual([['offered', 1], ['reclaiming', 2]]);
  });

  it('reclaims a running task on lease loss, but a drain-window result still wins the race', () => {
    const f = setup({ validateAcceptance: () => true });
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    f.lead.dispatch(taskId, EXEC, offerBody());
    f.deliver(receipt('task.accept', taskId, 1, { lease_ms: LEASE }));
    const lost = lostAfterMs(LEASE, DEFAULT_PARAMS);
    expect(f.lead.snapshot(taskId)?.leaseDeadline).toBe(EPOCH + lost);

    now += lost;
    f.lead.tick(now);
    expect(f.lead.snapshot(taskId)).toMatchObject({ state: 'reclaiming' });
    // R4/R5 race: a result arriving inside the drain window closes the task as done.
    f.deliver(receipt('task.result', taskId, 1, { status: 'done' }));
    expect(f.lead.snapshot(taskId)).toMatchObject({ state: 'done' });
    expect(f.reports().map((r) => r.status)).toEqual(['offered', 'running', 'reclaiming', 'done']);
  });

  it('burns budget on drain expiry and redispatches attempt+1 through the injected target selector', () => {
    const selectTarget = vi.fn(() => ({ target: EXEC2, offerBody: offerBody() }));
    const f = setup({ selectTarget });
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    f.lead.dispatch(taskId, EXEC, offerBody());
    now += TTL;
    f.lead.tick(now); // offered -> reclaiming (never accepted => dispatch_rounds budget)
    expect(f.lead.snapshot(taskId)).toMatchObject({ state: 'reclaiming' });

    now += DEFAULT_PARAMS.drainMs;
    f.lead.tick(now); // drain -> budget -> requestDispatch -> selector -> redispatch attempt 2
    expect(selectTarget).toHaveBeenCalledWith(expect.objectContaining({ task_id: taskId, nextAttempt: 2, kind: 'aid' }));
    expect(f.lead.snapshot(taskId)).toMatchObject({ state: 'offered', attempt: 2, target: EXEC2, dispatchRounds: 1 });
    const offers = f.outputs('task.offer');
    expect(offers).toHaveLength(2);
    expect(offers[1]).toMatchObject({ to: { node_id: EXEC2 }, attempt: 2 });
    expect(f.reports().at(-1)).toMatchObject({ status: 'offered', attempt: 2, exec: EXEC2 });
  });

  it('leaves a task in drafting when the selector has no target, then redispatches on a later tick', () => {
    let target: string | null = null;
    const selectTarget = vi.fn(() => (target ? { target, offerBody: offerBody() } : null));
    const f = setup({ selectTarget });
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    f.lead.dispatch(taskId, EXEC, offerBody());
    now += TTL;
    f.lead.tick(now); // -> reclaiming
    now += DEFAULT_PARAMS.drainMs;
    f.lead.tick(now); // drain -> requestDispatch -> selector null -> stays drafting (attempt not advanced)
    expect(f.lead.snapshot(taskId)).toMatchObject({ state: 'drafting', attempt: 1, dispatchRounds: 1 });

    target = EXEC2; // a target frees up; the next tick retries the pending redispatch
    f.lead.tick(now);
    expect(f.lead.snapshot(taskId)).toMatchObject({ state: 'offered', attempt: 2, target: EXEC2 });
  });

  it('escalates durably once the dispatch-round budget is exhausted and reports the terminal revision', () => {
    const f = setup({ selectTarget: () => ({ target: EXEC2, offerBody: offerBody() }) });
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    f.lead.dispatch(taskId, EXEC, offerBody());
    // Each offer_ttl expiry + drain burns one dispatch round and redispatches to EXEC2.
    for (let round = 0; round < DEFAULT_PARAMS.maxDispatchRounds; round++) {
      now += TTL;
      f.lead.tick(now); // offered -> reclaiming
      now += DEFAULT_PARAMS.drainMs;
      f.lead.tick(now); // drain -> budget/redispatch (or escalate on the last round)
    }
    expect(f.lead.snapshot(taskId)).toMatchObject({ state: 'escalated', dispatchRounds: DEFAULT_PARAMS.maxDispatchRounds });
    expect(f.reports().at(-1)).toMatchObject({ status: 'escalated' });
  });

  it('cancels by user into cancelling, then closes on the executor ack, reporting each revision', () => {
    const f = setup();
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    f.lead.dispatch(taskId, EXEC, offerBody());
    f.deliver(receipt('task.accept', taskId, 1, { lease_ms: LEASE }));
    expect(f.lead.cancel(taskId, now)).toBe(true);
    expect(f.lead.snapshot(taskId)).toMatchObject({ state: 'cancelling' });
    expect(f.outputs('task.cancel').at(-1)).toMatchObject({ to: { node_id: EXEC }, body: { reason: 'user' } });
    f.deliver(receipt('task.cancel.ack', taskId, 1, {}));
    expect(f.lead.snapshot(taskId)).toMatchObject({ state: 'closed' });
    expect(f.reports().map((r) => r.status)).toEqual(['offered', 'running', 'cancelling', 'closed']);
  });

  it('forces a cancelling task closed when the cancel_wait deadline passes without an ack', () => {
    const f = setup();
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    f.lead.dispatch(taskId, EXEC, offerBody());
    f.deliver(receipt('task.accept', taskId, 1, { lease_ms: LEASE }));
    f.lead.cancel(taskId, now);
    expect(f.lead.snapshot(taskId)?.cancelWaitUntil).toBe(now + DEFAULT_PARAMS.cancelWaitMs);
    now += DEFAULT_PARAMS.cancelWaitMs;
    f.lead.tick(now);
    expect(f.lead.snapshot(taskId)).toMatchObject({ state: 'closed' });
  });

  it('persists a permanent exclusion and hands it to the target selector on redispatch', () => {
    const selectTarget = vi.fn(() => ({ target: EXEC2, offerBody: offerBody() }));
    const f = setup({ selectTarget });
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    f.lead.dispatch(taskId, EXEC, offerBody());
    // A retryable fail after accept reclaims; unsupported_caps is not the reject path, so drive exclusion
    // through a reject with a persistent code before the offer is accepted.
    f.deliver(receipt('task.reject', taskId, 1, { reason_code: 'unsupported_caps' }));
    expect(f.lead.snapshot(taskId)?.excluded).toMatchObject({ [EXEC]: 'permanent' });
    // reject burns a dispatch round and re-offers inline through the selector (net state offered, attempt 2)
    expect(f.lead.snapshot(taskId)).toMatchObject({ state: 'offered', attempt: 2, target: EXEC2, dispatchRounds: 1 });
    expect(selectTarget).toHaveBeenCalledWith(expect.objectContaining({ excluded: { [EXEC]: 'permanent' }, nextAttempt: 2 }));
  });

  it('survives a store reopen mid-reclaim: deadlines/budget persist and no timer fires early', () => {
    const f = setup({ selectTarget: () => ({ target: EXEC2, offerBody: offerBody() }) });
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    f.lead.dispatch(taskId, EXEC, offerBody());
    now += TTL;
    f.lead.tick(now); // -> reclaiming, drainUntil persisted
    const before = f.lead.snapshot(taskId);
    expect(before?.drainUntil).toBe(now + DEFAULT_PARAMS.drainMs);
    f.store.close();

    const runtime = new NodeRuntimeStore(open({ ...f.options, mode: 'open' }), LOCAL);
    const lead = new DurableLead({ store: runtime, nodeId: LOCAL, teamId: TEAM, seal,
      selectTarget: () => ({ target: EXEC2, offerBody: offerBody() }) });
    expect(lead.snapshot(taskId)).toMatchObject({ state: before!.state, attempt: before!.attempt, task_seq: before!.task_seq });
    // A tick before the persisted drain deadline must NOT fire it (no fabricated timer).
    lead.tick(now + DEFAULT_PARAMS.drainMs - 1);
    expect(lead.snapshot(taskId)).toMatchObject({ state: 'reclaiming' });
    // Crossing the persisted deadline drives the redispatch exactly once.
    lead.tick(now + DEFAULT_PARAMS.drainMs);
    expect(lead.snapshot(taskId)).toMatchObject({ state: 'offered', attempt: 2, target: EXEC2 });
  });

  it('fails closed on a corrupt persisted record and refuses to fire timers or heal', () => {
    const f = setup();
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    f.lead.dispatch(taskId, EXEC, offerBody());
    const key = leadStateKey(taskId);
    const saved = f.runtime.state(key)!.value as Record<string, RuntimeJson>;
    saved.attempt = -1;
    f.runtime.transition(key, f.runtime.state(key)!.revision, () => ({ state: saved as RuntimeJson }));
    const lead = new DurableLead({ store: f.runtime, nodeId: LOCAL, teamId: TEAM, seal });
    expect(() => lead.tick(now)).toThrow('Invalid durable lead state');
    expect(() => lead.snapshot(taskId)).toThrow('Invalid durable lead state');
  });
});

describe('DurableLead 业务续租生产半(B2a: task.progress → 密封 task.lease.renew + 持久 renewalSeq)', () => {
  it('running 收到带 msg_id 的 v2 task.progress → 密封 task.lease.renew 并持久化单调 renewalSeq(不产上报修订)', () => {
    const f = setup();
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    f.lead.dispatch(taskId, EXEC, offerBody());
    f.deliver(receipt('task.accept', taskId, 1, { lease_ms: LEASE }));
    const generation = 3;
    const runId = newId();
    const progress = receipt('task.progress', taskId, 1, { state: 'working', seq: 1, generation, run_id: runId });
    f.deliver(progress);
    const renews = f.outputs('task.lease.renew');
    expect(renews).toHaveLength(1);
    expect(renews[0]).toMatchObject({
      type: 'task.lease.renew', to: { node_id: EXEC }, task_id: taskId, attempt: 1, reply_to: progress.msg_id,
    });
    // progress_msg_id 绑定信封 msg_id;deadline_ms = now + 执行方实际 leaseMs(= EPOCH + LEASE)
    expect(renews[0]!.body).toEqual({
      generation, run_id: runId, progress_msg_id: progress.msg_id, progress_seq: 1,
      renewal_seq: 1, deadline_ms: EPOCH + LEASE,
    });
    expect(f.lead.snapshot(taskId)?.renewalSeq).toBe(1);
    // progress 不改牵头状态 → 不追加上报修订(仍只有 offered/running)
    expect(f.reports().map((r) => r.status)).toEqual(['offered', 'running']);
  });

  it('renewalSeq 跨 store 重启对齐并继续单调递增(绝不重置/伪造)', () => {
    const f = setup();
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    f.lead.dispatch(taskId, EXEC, offerBody());
    f.deliver(receipt('task.accept', taskId, 1, { lease_ms: LEASE }));
    const generation = 3;
    const runId = newId();
    f.deliver(receipt('task.progress', taskId, 1, { seq: 1, generation, run_id: runId }));
    expect(f.lead.snapshot(taskId)?.renewalSeq).toBe(1);
    f.store.close();

    const runtime = new NodeRuntimeStore(open({ ...f.options, mode: 'open' }), LOCAL);
    const lead = new DurableLead({ store: runtime, nodeId: LOCAL, teamId: TEAM, seal });
    expect(lead.snapshot(taskId)?.renewalSeq).toBe(1); // 持久对齐,重启不重置
    const p2 = receipt('task.progress', taskId, 1, { seq: 2, generation, run_id: runId });
    expect(['new', 'duplicate']).toContain(runtime.receive(p2));
    lead.consume(p2, true);
    const renews = runtime.all().map((i) => i.envelope).filter((i) => i.type === 'task.lease.renew');
    expect(renews.at(-1)?.body).toMatchObject({
      progress_msg_id: p2.msg_id, progress_seq: 2, renewal_seq: 2, deadline_ms: EPOCH + LEASE,
    });
    expect(lead.snapshot(taskId)?.renewalSeq).toBe(2);
  });
});

describe('DurableLead owner 强制改派适配器(E3/OWNER-COMMAND §4.4: redispatch 镜像 cancel,单任务 CAS 事务)', () => {
  it('redispatch 经单任务 CAS 事务:running→reclaiming 原子提交 state + task.cancel + reclaiming 上报修订,并持久排除当前 target', () => {
    const f = setup();
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    f.lead.dispatch(taskId, EXEC, offerBody());
    f.deliver(receipt('task.accept', taskId, 1, { lease_ms: LEASE }));
    expect(f.lead.redispatch(taskId, now)).toBe(true); // 状态净变化
    expect(f.lead.snapshot(taskId)).toMatchObject({ state: 'reclaiming', target: EXEC, excluded: { [EXEC]: 'once' } });
    expect(f.outputs('task.cancel').at(-1)).toMatchObject({ to: { node_id: EXEC }, task_id: taskId, attempt: 1, body: { reason: 'reclaim' } });
    expect(f.reports().map((r) => [r.status, r.task_seq])).toEqual([['offered', 1], ['running', 2], ['reclaiming', 3]]);
  });

  it('redispatch 后 drain 经 tick → 选择器收到排除快照 → 改派到不同节点(EXEC2),绝不回原节点', () => {
    const selectTarget = vi.fn(() => ({ target: EXEC2, offerBody: offerBody() }));
    const f = setup({ selectTarget });
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    f.lead.dispatch(taskId, EXEC, offerBody());
    f.deliver(receipt('task.accept', taskId, 1, { lease_ms: LEASE }));
    f.lead.redispatch(taskId, now); // running→reclaiming, excluded[EXEC]='once'
    now += DEFAULT_PARAMS.drainMs;
    f.lead.tick(now); // drain→预算→requestDispatch→选择器→redispatch attempt2
    expect(selectTarget).toHaveBeenCalledWith(expect.objectContaining({ task_id: taskId, nextAttempt: 2, excluded: { [EXEC]: 'once' } }));
    expect(f.lead.snapshot(taskId)).toMatchObject({ state: 'offered', attempt: 2, target: EXEC2 });
  });

  it('redispatch 幂等(§1.7 at-least-once):重复应用第二次 no-op,不产重复 task.cancel/上报修订/不推 task_seq', () => {
    const f = setup();
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    f.lead.dispatch(taskId, EXEC, offerBody());
    f.deliver(receipt('task.accept', taskId, 1, { lease_ms: LEASE }));
    expect(f.lead.redispatch(taskId, now)).toBe(true);
    const cancels = f.outputs('task.cancel').length;
    const reports = f.reports().length;
    const seq = f.lead.snapshot(taskId)?.task_seq;
    expect(f.lead.redispatch(taskId, now)).toBe(false); // reclaiming→no-op,无净变化,不提交
    expect(f.outputs('task.cancel')).toHaveLength(cancels);
    expect(f.reports()).toHaveLength(reports);
    expect(f.lead.snapshot(taskId)?.task_seq).toBe(seq);
  });

  it('redispatch 对未 originate 的任务抛出(不静默伪造改派)', () => {
    const f = setup();
    expect(() => f.lead.redispatch(newId(), now)).toThrow('not originated');
  });

  it('redispatch 对损坏持久状态 fail-closed(recovery required),绝不伪造改派', () => {
    const f = setup();
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    f.lead.dispatch(taskId, EXEC, offerBody());
    const key = leadStateKey(taskId);
    const saved = f.runtime.state(key)!.value as Record<string, RuntimeJson>;
    saved.state = 'bogus';
    f.runtime.transition(key, f.runtime.state(key)!.revision, () => ({ state: saved as RuntimeJson }));
    const lead = new DurableLead({ store: f.runtime, nodeId: LOCAL, teamId: TEAM, seal });
    expect(() => lead.redispatch(taskId, now)).toThrow('recovery required');
  });
});
