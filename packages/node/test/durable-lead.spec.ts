import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId, type EnvelopeV1 } from '@qlong/core';
import { DurableLead, leadStateKey, type DurableLeadOptions } from '../src/runtime/lead.js';
import { NodeRuntimeStore, type RuntimeJson } from '../src/runtime/store.js';
import { DurableTaskReporter, TASK_REPORT_KIND, type TaskReport, type TaskReportSink } from '../src/runtime/report.js';
import type { Outbound } from '../src/wire.js';
import { env, fixture, LOCAL, open, OTHER } from './runtime-store-helpers.js';

const TEAM = 'lead-test-team';
const EXEC = '20000000-0000-4000-8000-000000000009';
const EPOCH = Date.parse('2026-09-16T12:00:00Z');
let now = EPOCH;

/** Test seal: assemble a signed outbound envelope from the lead (LOCAL) to its target. */
function seal(out: Outbound): EnvelopeV1 {
  return env({
    type: out.type, ts: new Date(now).toISOString(), exp: new Date(now + 60_000).toISOString(),
    from: { node_id: LOCAL, team_id: TEAM, key_epoch: 1 }, to: { node_id: out.to_node, team_id: TEAM },
    task_id: out.task_id!, attempt: out.attempt!, ...(out.reply_to ? { reply_to: out.reply_to } : {}), body: out.body,
  });
}

/** Inbound receipt from the executor to the lead (LOCAL). */
function receipt(type: string, taskId: string, attempt: number, body: Record<string, unknown> = {}, from = EXEC): EnvelopeV1 {
  return env({
    type, ts: new Date(now).toISOString(), exp: new Date(now + 60_000).toISOString(),
    from: { node_id: from, team_id: TEAM, key_epoch: 1 }, to: { node_id: LOCAL, team_id: TEAM },
    task_id: taskId, attempt, body,
  });
}

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

describe('DurableLead (v2 durable task origination + projection intent production)', () => {
  it('originates a led task in drafting without any report intent or outbound offer', () => {
    const f = setup();
    const taskId = newId();
    expect(f.lead.originate(taskId, 'aid')).toBe(true);
    expect(f.lead.snapshot(taskId)).toMatchObject({ state: 'drafting', attempt: 0, target: null, task_seq: 0 });
    expect(f.runtime.all()).toEqual([]);
    expect(f.reports()).toEqual([]);
    // Idempotent: re-originating the same task neither duplicates state nor advances the sequence.
    expect(f.lead.originate(taskId, 'aid')).toBe(false);
    expect(f.lead.snapshot(taskId)).toMatchObject({ state: 'drafting', task_seq: 0 });
  });

  it('dispatches an offer and atomically records a durable offered report intent', () => {
    const f = setup();
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    expect(f.lead.dispatch(taskId, EXEC, { kind: 'aid', summary: 'work' })).toBe(true);
    const offers = f.outputs('task.offer');
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ type: 'task.offer', to: { node_id: EXEC }, task_id: taskId, attempt: 1 });
    expect(f.lead.snapshot(taskId)).toMatchObject({
      state: 'offered', attempt: 1, target: EXEC, task_seq: 1, offerMsgId: offers[0]!.msg_id,
    });
    // The report intent is committed in the SAME transition as the offer, never before or after.
    expect(f.reports()).toEqual([{
      task_id: taskId, team_id: TEAM, lead: LOCAL, exec: EXEC, attempt: 1, status: 'offered', type: 'aid', task_seq: 1,
    }]);
    // A second dispatch is refused: the task already left drafting.
    expect(f.lead.dispatch(taskId, EXEC, { kind: 'aid', summary: 'work' })).toBe(false);
    expect(f.outputs('task.offer')).toHaveLength(1);
  });

  it('consumes an accept into running and appends the next report revision', () => {
    const f = setup();
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    f.lead.dispatch(taskId, EXEC, { kind: 'aid', summary: 'work' });
    f.deliver(receipt('task.accept', taskId, 1, { lease_ms: 900 }));
    expect(f.lead.snapshot(taskId)).toMatchObject({ state: 'running', attempt: 1, target: EXEC, task_seq: 2 });
    expect(f.reports().map((r) => [r.status, r.task_seq])).toEqual([['offered', 1], ['running', 2]]);
    expect(f.reports()[1]).toMatchObject({ status: 'running', task_seq: 2, exec: EXEC, lead: LOCAL });
  });

  it('consumes a result into done and a fatal fail into failed, each reporting the terminal revision', () => {
    const done = setup();
    const doneTask = newId();
    done.lead.originate(doneTask, 'project');
    done.lead.dispatch(doneTask, EXEC, { kind: 'project', summary: 'work' });
    done.deliver(receipt('task.accept', doneTask, 1));
    done.deliver(receipt('task.result', doneTask, 1, { status: 'done' }));
    expect(done.lead.snapshot(doneTask)).toMatchObject({ state: 'done', task_seq: 3 });
    expect(done.reports().map((r) => [r.status, r.task_seq])).toEqual([['offered', 1], ['running', 2], ['done', 3]]);
    expect(done.reports()[2]).toMatchObject({ status: 'done', type: 'project', exec: EXEC, attempt: 1 });

    const failed = setup();
    const failedTask = newId();
    failed.lead.originate(failedTask, 'aid');
    failed.lead.dispatch(failedTask, EXEC, { kind: 'aid', summary: 'work' });
    failed.deliver(receipt('task.accept', failedTask, 1));
    failed.deliver(receipt('task.fail', failedTask, 1, { reason_code: 'other', retryable: false }));
    expect(failed.lead.snapshot(failedTask)).toMatchObject({ state: 'failed', task_seq: 3 });
    expect(failed.reports().at(-1)).toMatchObject({ status: 'failed', task_seq: 3, type: 'aid' });
  });

  it('ignores receipts from a non-target node, a mismatched attempt, or an unauthorized sender', () => {
    const f = setup();
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    f.lead.dispatch(taskId, EXEC, { kind: 'aid', summary: 'work' });
    const before = f.lead.snapshot(taskId);
    f.deliver(receipt('task.accept', taskId, 1, {}, OTHER)); // wrong node
    f.deliver(receipt('task.accept', taskId, 2, {})); // wrong attempt
    f.deliver(receipt('task.accept', taskId, 1, {}), false); // unauthorized
    expect(f.lead.snapshot(taskId)).toEqual(before);
    // Only the dispatch report exists; no phantom running/done revision was fabricated.
    expect(f.reports().map((r) => r.status)).toEqual(['offered']);
  });

  it('aligns task_seq across a store reopen and never fabricates or resets a report revision', () => {
    const f = setup();
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    f.lead.dispatch(taskId, EXEC, { kind: 'aid', summary: 'work' });
    f.deliver(receipt('task.accept', taskId, 1));
    const before = f.lead.snapshot(taskId);
    expect(before?.task_seq).toBe(2);
    f.store.close();

    const runtime = new NodeRuntimeStore(open({ ...f.options, mode: 'open' }), LOCAL);
    const lead = new DurableLead({ store: runtime, nodeId: LOCAL, teamId: TEAM, seal });
    expect(lead.snapshot(taskId)).toEqual(before); // task_seq 2 preserved verbatim, not reset to 0
    const pending = runtime.pendingEffects(undefined, true).filter((e) => e.kind === TASK_REPORT_KIND);
    expect(pending.map((e) => (e.payload as unknown as TaskReport).task_seq)).toEqual([1, 2]);

    // A post-restart result continues the monotonic sequence at 3.
    const result = receipt('task.result', taskId, 1, { status: 'done' });
    expect(['new', 'duplicate']).toContain(runtime.receive(result));
    lead.consume(result, true);
    expect(lead.snapshot(taskId)).toMatchObject({ state: 'done', task_seq: 3 });
  });

  it('produces report intents the DurableTaskReporter delivers to the center in task_seq order', async () => {
    const f = setup();
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    f.lead.dispatch(taskId, EXEC, { kind: 'aid', summary: 'work' });
    f.deliver(receipt('task.accept', taskId, 1));
    f.deliver(receipt('task.result', taskId, 1, { status: 'done' }));
    const delivered: TaskReport[] = [];
    const post = vi.fn<TaskReportSink>(async (r) => { delivered.push(r); return { ok: true, status: 200 }; });
    const reporter = new DurableTaskReporter({ store: f.runtime, post });

    expect(await reporter.flush()).toEqual({ delivered: 3, pending: 0 });
    expect(delivered.map((r) => [r.status, r.task_seq])).toEqual([['offered', 1], ['running', 2], ['done', 3]]);
    expect(f.reports()).toEqual([]); // every intent completed after delivery
  });

  it('rejects malformed persisted lead state without healing, dispatching, or reporting', () => {
    const f = setup();
    const taskId = newId();
    f.lead.originate(taskId, 'aid');
    f.lead.dispatch(taskId, EXEC, { kind: 'aid', summary: 'work' });
    const key = leadStateKey(taskId);
    const saved = f.runtime.state(key)!.value as Record<string, RuntimeJson>;
    saved.state = 'bogus';
    f.runtime.transition(key, f.runtime.state(key)!.revision, () => ({ state: saved as RuntimeJson }));

    const lead = new DurableLead({ store: f.runtime, nodeId: LOCAL, teamId: TEAM, seal });
    expect(() => lead.snapshot(taskId)).toThrow('Invalid durable lead state');
    // Fail-closed: the latched lead refuses further mutation rather than rebuilding or re-dispatching.
    expect(() => lead.dispatch(taskId, EXEC, { kind: 'aid', summary: 'work' })).toThrow('recovery required');
    // Corruption enters recovery, never silent rebuild: the pre-corruption intent is untouched, no new one.
    expect(f.reports().map((r) => r.status)).toEqual(['offered']);
  });
});
