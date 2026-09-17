import { describe, expect, it, vi } from 'vitest';
import { newId } from '@qlong/core';
import { NodeRuntimeStore, type RuntimeJson } from '../src/runtime/store.js';
import {
  DurableTaskReporter, TASK_REPORT_KIND, taskReportEffect, type TaskReport, type TaskReportSink,
} from '../src/runtime/report.js';
import { fixture, open, LOCAL } from './runtime-store-helpers.js';

const TEAM = 'reporter-test-team';
const EXEC = '20000000-0000-4000-8000-000000000009';
const KEY = (taskId: string): string => `lead:report:${taskId}`;

function report(overrides: Partial<TaskReport> = {}): TaskReport {
  return {
    task_id: newId(), team_id: TEAM, lead: LOCAL, exec: EXEC,
    attempt: 1, status: 'offered', type: 'aid', task_seq: 0, ...overrides,
  };
}

/**
 * Seed report intents exactly as a durable lead transition would: each reported revision is one
 * committed transition that appends a task.report effect and advances the state revision, so every
 * earlier report intent is superseded and only includeSuperseded can see it.
 */
function seed(runtime: NodeRuntimeStore, taskId: string, reports: TaskReport[]): void {
  const stateKey = KEY(taskId);
  let revision = runtime.state(stateKey)?.revision ?? 0;
  for (const report of reports) {
    runtime.transition(stateKey, revision, () => ({
      state: { task_seq: report.task_seq },
      effects: [taskReportEffect(report, newId())],
    }));
    revision += 1;
  }
}

function pendingReports(runtime: NodeRuntimeStore): TaskReport[] {
  return runtime.pendingEffects(undefined, true)
    .filter((effect) => effect.kind === TASK_REPORT_KIND)
    .map((effect) => effect.payload as unknown as TaskReport);
}

describe('DurableTaskReporter (v2 durable task projection intent pump)', () => {
  it('delivers a recorded task report and completes its durable intent', async () => {
    const f = fixture();
    const posted = report();
    seed(f.runtime, posted.task_id, [posted]);
    const post = vi.fn<TaskReportSink>(async () => ({ ok: true, status: 200 }));
    const reporter = new DurableTaskReporter({ store: f.runtime, post });

    const result = await reporter.flush();

    expect(post).toHaveBeenCalledExactlyOnceWith(posted);
    expect(result).toEqual({ delivered: 1, pending: 0 });
    expect(pendingReports(f.runtime)).toEqual([]);
  });

  it('keeps an undelivered report pending and retries it after a store reopen at the same task_seq', async () => {
    const f = fixture();
    const posted = report({ status: 'running', task_seq: 3 });
    seed(f.runtime, posted.task_id, [posted]);
    const failing = vi.fn<TaskReportSink>(async () => ({ ok: false, status: 500 }));
    const reporter = new DurableTaskReporter({ store: f.runtime, post: failing });

    expect(await reporter.flush()).toEqual({ delivered: 0, pending: 1 });
    // Iron law: a failed projection is never dropped; it stays pending for the next pump.
    expect(pendingReports(f.runtime)).toEqual([posted]);

    // Restart: the intent survives the reopen with its original task_seq, never fabricated or reset.
    f.store.close();
    const runtime = new NodeRuntimeStore(open({ ...f.options, mode: 'open' }), LOCAL);
    const delivered: TaskReport[] = [];
    const recovered = new DurableTaskReporter({
      store: runtime,
      post: async (r) => { delivered.push(r); return { ok: true, status: 200 }; },
    });

    expect(await recovered.flush()).toEqual({ delivered: 1, pending: 0 });
    expect(delivered).toEqual([posted]);
    expect(delivered[0]!.task_seq).toBe(3);
  });

  it('delivers one task in task_seq order, holds later revisions on failure, and isolates other tasks', async () => {
    const f = fixture();
    const taskA = newId();
    const taskB = newId();
    const a0 = report({ task_id: taskA, status: 'offered', task_seq: 0 });
    const a1 = report({ task_id: taskA, status: 'running', task_seq: 1 });
    const a2 = report({ task_id: taskA, status: 'done', task_seq: 2 });
    const b0 = report({ task_id: taskB, status: 'offered', task_seq: 0 });
    seed(f.runtime, taskA, [a0, a1, a2]);
    seed(f.runtime, taskB, [b0]);
    const seen: TaskReport[] = [];
    // task_seq 1 of task A is refused; A's later revision must not overtake it, but task B is independent.
    const post = vi.fn<TaskReportSink>(async (r) => {
      seen.push(r);
      return r.task_id === taskA && r.task_seq === 1 ? { ok: false, status: 503 } : { ok: true, status: 200 };
    });
    const reporter = new DurableTaskReporter({ store: f.runtime, post });

    expect(await reporter.flush()).toEqual({ delivered: 2, pending: 2 });
    expect(seen).toEqual([a0, a1, b0]); // a2 held behind the failed a1; ordering preserved per task
    expect(pendingReports(f.runtime)).toEqual(expect.arrayContaining([a1, a2]));
    expect(pendingReports(f.runtime)).not.toContainEqual(a0);
  });

  it('treats a 409 as an already-recorded revision and completes the intent instead of retrying forever', async () => {
    const f = fixture();
    const posted = report({ status: 'done', task_seq: 5 });
    seed(f.runtime, posted.task_id, [posted]);
    const post = vi.fn<TaskReportSink>(async () => ({ ok: false, status: 409 }));
    const reporter = new DurableTaskReporter({ store: f.runtime, post });

    expect(await reporter.flush()).toEqual({ delivered: 1, pending: 0 });
    expect(post).toHaveBeenCalledExactlyOnceWith(posted);
    expect(pendingReports(f.runtime)).toEqual([]);
  });

  it('drains pending reports on close within the deadline and never drops them when it expires', async () => {
    const draining = fixture();
    const first = report({ status: 'offered', task_seq: 0 });
    const second = report({ task_id: first.task_id, status: 'done', task_seq: 1 });
    seed(draining.runtime, first.task_id, [first, second]);
    const okReporter = new DurableTaskReporter({
      store: draining.runtime, post: async () => ({ ok: true, status: 200 }),
    });
    expect(await okReporter.close(1_000)).toEqual({ delivered: 2, pending: 0 });

    const stuck = fixture();
    const stuckReport = report();
    seed(stuck.runtime, stuckReport.task_id, [stuckReport]);
    const failReporter = new DurableTaskReporter({
      store: stuck.runtime, post: async () => ({ ok: false, status: 500 }),
    });
    // A bounded give-up must leave the intent pending for the next process, not silently discard it.
    expect(await failReporter.close(30)).toEqual({ delivered: 0, pending: 1 });
    expect(pendingReports(stuck.runtime)).toEqual([stuckReport]);
  });

  it('fails closed on a corrupt report intent instead of delivering or silently dropping it', async () => {
    const f = fixture();
    const corrupt = {
      task_id: 'not-a-uuid', team_id: TEAM, lead: LOCAL, exec: null,
      attempt: 1, status: 'bogus', type: 'aid', task_seq: 0,
    } as unknown as RuntimeJson;
    f.runtime.transition(KEY(newId()), 0, () => ({
      state: { task_seq: 0 },
      effects: [{ id: newId(), kind: TASK_REPORT_KIND, payload: corrupt }],
    }));
    const post = vi.fn<TaskReportSink>(async () => ({ ok: true, status: 200 }));
    const reporter = new DurableTaskReporter({ store: f.runtime, post });

    await expect(reporter.flush()).rejects.toThrow('Invalid durable task report intent');
    expect(post).not.toHaveBeenCalled();
    // Corruption enters recovery, never silent rebuild: the intent is still pending, undelivered.
    expect(f.runtime.pendingEffects(undefined, true).filter((e) => e.kind === TASK_REPORT_KIND)).toHaveLength(1);
  });
});
