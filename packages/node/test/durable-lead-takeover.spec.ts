import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PARAMS, newId, type EnvelopeV1 } from '@qlong/core';
import { DurableLead, type DurableLeadOptions } from '../src/runtime/lead.js';
import { TASK_REPORT_KIND, type TaskReport } from '../src/runtime/report.js';
import type { Outbound } from '../src/wire.js';
import { env, fixture, LOCAL, OTHER } from './runtime-store-helpers.js';

/**
 * C2a:DurableLead 跨机接管 fence(v1 lead/takeover.ts 的持久端口)。
 * origin(nodeId=LOCAL)与 target(nodeId=OTHER)是两台独立 SQLite;origin 导出在途牵头任务,
 * target 导入并按 attempt 高水位仲裁:本地 ≥ 导入 → fenced(禁双主回退);终态 → archived(不重跑);
 * 在途 → attempt+1 归位 drafting(旧执行方迟到消息即刻 R0 stale),task_seq 原样保留供序号单调续接。
 */
const TEAM = 'lead-takeover-team';
const EXEC = '20000000-0000-4000-8000-000000000009';
const EXEC2 = '20000000-0000-4000-8000-00000000000a';
const EPOCH = Date.parse('2026-09-16T12:00:00Z');
// 机器从 params 派生 offer 死线(忽略 offerBody.offer_ttl_ms),故 ttl 取 aid 默认以对齐持久死线算术。
const TTL = DEFAULT_PARAMS.offerTtlMsAid;
const LEASE = 90_000; // lostAfterMs = 2*(90000/3)+30000 = 90000
let now = EPOCH;

const sealFrom = (nodeId: string) => (out: Outbound): EnvelopeV1 => env({
  type: out.type, ts: new Date(now).toISOString(), exp: new Date(now + 60_000).toISOString(),
  from: { node_id: nodeId, team_id: TEAM, key_epoch: 1 }, to: { node_id: out.to_node, team_id: TEAM },
  task_id: out.task_id!, attempt: out.attempt!, ...(out.reply_to ? { reply_to: out.reply_to } : {}), body: out.body,
});

const receiptTo = (to: string, type: string, taskId: string, attempt: number,
  body: Record<string, unknown> = {}, from = EXEC): EnvelopeV1 => env({
  type, ts: new Date(now).toISOString(), exp: new Date(now + 60_000).toISOString(),
  from: { node_id: from, team_id: TEAM, key_epoch: 1 }, to: { node_id: to, team_id: TEAM },
  task_id: taskId, attempt, body,
});

const offerBody = (): Record<string, unknown> => ({ kind: 'aid', summary: 'work', offer_ttl_ms: TTL, lease_ms: LEASE });

function makeLead(nodeId: string, overrides: Partial<DurableLeadOptions> = {}) {
  const f = fixture({}, nodeId);
  const lead = new DurableLead({ store: f.runtime, nodeId, teamId: TEAM, seal: sealFrom(nodeId), ...overrides });
  const deliver = (input: EnvelopeV1, authorized = true): void => {
    expect(['new', 'duplicate']).toContain(f.runtime.receive(input));
    lead.consume(input, authorized);
  };
  const outputs = (type: string): EnvelopeV1[] => f.runtime.all().map((i) => i.envelope).filter((i) => i.type === type);
  const reports = (): TaskReport[] => f.runtime.pendingEffects(undefined, true)
    .filter((e) => e.kind === TASK_REPORT_KIND).map((e) => e.payload as unknown as TaskReport);
  return { ...f, lead, deliver, outputs, reports };
}

const origin = (o: Partial<DurableLeadOptions> = {}) => makeLead(LOCAL, o);
const target = (o: Partial<DurableLeadOptions> = {}) => makeLead(OTHER, o);

beforeEach(() => { now = EPOCH; vi.spyOn(Date, 'now').mockImplementation(() => now); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('DurableLead 跨机接管 fence(C2a: export/import + attempt 高水位仲裁)', () => {
  it('在途任务 export→import:fence 到 attempt+1、归位 drafting、保留 target 与 task_seq', () => {
    const o = origin();
    const taskId = newId();
    o.lead.originate(taskId, 'aid');
    o.lead.dispatch(taskId, EXEC, offerBody());
    expect(o.lead.snapshot(taskId)).toMatchObject({ state: 'offered', attempt: 1, target: EXEC, task_seq: 1 });

    const bundle = o.lead.exportTasks();
    expect(bundle).toMatchObject({ v: 1, requires_origin_stopped: true });
    expect(bundle.tasks.map((t) => t.task_id)).toEqual([taskId]);

    const t = target();
    expect(t.lead.importTasks(bundle)).toEqual({ imported: [taskId], fenced: [], archived: [] });
    // fence:attempt 1 → 2、归位 drafting 待重派;target/task_seq 保留(序号单调续接,绝不重置/伪造)
    expect(t.lead.snapshot(taskId)).toMatchObject({ state: 'drafting', attempt: 2, target: EXEC, task_seq: 1 });
  });

  it('禁双主回退:本地 attempt 高水位 ≥ 导入 → fenced 跳过,本地状态不被覆盖', () => {
    const o = origin();
    const taskId = newId();
    o.lead.originate(taskId, 'aid');
    o.lead.dispatch(taskId, EXEC, offerBody()); // 导出侧 attempt 1
    const bundle = o.lead.exportTasks();

    const t = target();
    t.lead.originate(taskId, 'aid');
    t.lead.dispatch(taskId, EXEC2, offerBody()); // 本地 attempt 1
    t.deliver(receiptTo(OTHER, 'task.accept', taskId, 1, { lease_ms: LEASE }, EXEC2)); // → running attempt 1
    const before = t.lead.snapshot(taskId);

    const result = t.lead.importTasks(bundle); // 导入 attempt 1 ≤ 本地 1 → fenced
    expect(result.fenced).toEqual([taskId]);
    expect(result.imported).toEqual([]);
    expect(t.lead.snapshot(taskId)).toEqual(before); // 未被回退覆盖
  });

  it('终态任务仅归档,不接管重跑:state 保持终态、不归位 drafting', () => {
    const o = origin();
    const taskId = newId();
    o.lead.originate(taskId, 'aid');
    o.lead.dispatch(taskId, EXEC, offerBody());
    o.deliver(receiptTo(LOCAL, 'task.accept', taskId, 1, { lease_ms: LEASE }));
    o.deliver(receiptTo(LOCAL, 'task.result', taskId, 1, { summary: 'done' }));
    expect(o.lead.snapshot(taskId)).toMatchObject({ state: 'done' });
    const bundle = o.lead.exportTasks();

    const t = target();
    expect(t.lead.importTasks(bundle)).toEqual({ imported: [], fenced: [], archived: [taskId] });
    expect(t.lead.snapshot(taskId)).toMatchObject({ state: 'done' }); // 归档保留终态,绝不重跑
  });

  it('fence 后旧执行方迟到 accept(attempt=1)被 R0 stale_attempt 拒,状态不回退', () => {
    const o = origin();
    const taskId = newId();
    o.lead.originate(taskId, 'aid');
    o.lead.dispatch(taskId, EXEC, offerBody());
    const bundle = o.lead.exportTasks();

    const t = target();
    t.lead.importTasks(bundle); // attempt → 2, drafting, target 仍 EXEC
    t.deliver(receiptTo(OTHER, 'task.accept', taskId, 1, { lease_ms: LEASE })); // 旧执行方 attempt 1 < 2
    expect(t.outputs('task.reject').some((r) => r.body.reason_code === 'stale_attempt')).toBe(true);
    expect(t.lead.snapshot(taskId)).toMatchObject({ state: 'drafting', attempt: 2 });
  });

  it('fence 归位 drafting 后 tick 经注入选择器重派 attempt+1、密封新 offer 并续接 task_seq', () => {
    const o = origin();
    const taskId = newId();
    o.lead.originate(taskId, 'aid');
    o.lead.dispatch(taskId, EXEC, offerBody());
    const bundle = o.lead.exportTasks();

    const t = target({ selectTarget: (req) => ({ target: EXEC2, offerBody: { ...offerBody(), summary: 're' + req.nextAttempt } }) });
    t.lead.importTasks(bundle); // attempt 2 drafting, task_seq 1
    t.lead.tick(now);
    expect(t.lead.snapshot(taskId)).toMatchObject({ state: 'offered', attempt: 3, target: EXEC2, task_seq: 2 });
    const offers = t.outputs('task.offer');
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ to: { node_id: EXEC2 }, task_id: taskId, attempt: 3 });
    // 上报续接:接管后首条修订 task_seq=2(> origin 的 1),中心据序号单调接受而非 409 丢弃
    expect(t.reports().map((r) => [r.status, r.attempt, r.task_seq, r.lead])).toEqual([['offered', 3, 2, OTHER]]);
  });

  it('从未派发(attempt=0 drafting)的任务 import 原样归位,不 fence 越界(target 仍 null)', () => {
    const o = origin();
    const taskId = newId();
    o.lead.originate(taskId, 'aid'); // attempt 0 drafting,无在途执行权可 fence
    const bundle = o.lead.exportTasks();

    const t = target();
    expect(t.lead.importTasks(bundle).imported).toEqual([taskId]);
    expect(t.lead.snapshot(taskId)).toMatchObject({ state: 'drafting', attempt: 0, target: null, task_seq: 0 });
  });

  it('损坏 bundle(非法 task:attempt≥1 却 target=null)→ importTasks 抛出 fail-closed,绝不静默跳过', () => {
    const t = target();
    const bad = {
      v: 1, exported_at: new Date(now).toISOString(), requires_origin_stopped: true,
      tasks: [{ task_id: newId(), task: { version: 2, task_seq: 0, state: 'drafting', attempt: 1, target: null } }],
    };
    expect(() => t.lead.importTasks(bad as never)).toThrow();
  });
});
