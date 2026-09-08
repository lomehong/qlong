import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkpointLeadMachine, pendingTimers, restoreLeadMachine } from '../src/lead/checkpoint.js';
import { JsonFileStore, MemoryStore } from '../src/lead/store.js';
import { LeadSupervisor } from '../src/lead/supervisor.js';
import { LeadTaskMachine } from '../src/lead/machine.js';

const TASK = '66666666-6666-4666-8666-666666666666';
const B = '22222222-2222-4222-8222-222222222222';
const BODY = { kind: 'project', summary: 's', lease_ms: 300000, offer_ttl_ms: 60000 };

describe('检查点序列化(01 §4.4)', () => {
  it('running 态往返:attempt/history/状态保留,恢复后可继续到终态', () => {
    const m = new LeadTaskMachine({ task_id: TASK, kind: 'project' });
    m.dispatchTo(B, BODY, 0);
    m.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 100);
    const blob = checkpointLeadMachine(m);
    const m2 = restoreLeadMachine(blob);
    expect(m2.rec.state).toBe('running');
    expect(m2.rec.attempt).toBe(1);
    expect(m2.rec.history).toHaveLength(1);
    expect(m2.terminal).toBe(false);
    m2.onMessage('task.result', B, 1, { status: 'done', summary: '恢复后交付' }, 200);
    expect(m2.rec.state).toBe('done');
  });

  it('pendingTimers:按状态重挂清单(offered/running/reclaiming/cancelling)', () => {
    const m = new LeadTaskMachine({ task_id: TASK, kind: 'project' });
    m.dispatchTo(B, BODY, 0);
    expect(pendingTimers(m)).toEqual([{ timer: 'offer_ttl', atMs: 60_000 }]);
    m.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 100);
    expect(pendingTimers(m)).toEqual([{ timer: 'lease', atMs: 230_100 }]);
  });
});

describe('存储:Memory + JsonFile(原子写)', () => {
  it('JsonFileStore 保存/加载/列举/删除', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'qlong-cp-')), 'cp');
    const store = new JsonFileStore(dir);
    store.save(TASK, '{"a":1}');
    expect(existsSync(join(dir, `${TASK}.cp.json`))).toBe(true);
    expect(store.load(TASK)).toBe('{"a":1}');
    expect(store.list()).toEqual([TASK]);
    store.delete(TASK);
    expect(store.list()).toEqual([]);
  });

  it('同进程崩溃语义:MemoryStore 在新实例中为空,文件存储跨进程', () => {
    const s1 = new MemoryStore();
    s1.save(TASK, 'x');
    expect(new MemoryStore().list()).toEqual([]);
    void s1;
  });
});

describe('接管:进程重启 + 检查点重放(01 §4.4)', () => {
  it('running 中崩溃 → 恢复 → 交付结果 → done', () => {
    const store = new MemoryStore();
    const s1 = new LeadSupervisor({ store });
    s1.create(TASK, 'project');
    s1.dispatch(TASK, B, BODY, 0);
    s1.deliver(TASK, 'task.accept', B, 1, { lease_ms: 300000 }, 100);
    expect(s1.get(TASK)?.rec.state).toBe('running');
    void s1; // —— 进程崩溃,一切内存态丢失 ——

    const s2 = new LeadSupervisor({ store });
    s2.restoreAll();
    const m2 = s2.get(TASK);
    expect(m2?.rec.state).toBe('running');
    expect(pendingTimers(m2 as LeadTaskMachine)).toEqual([{ timer: 'lease', atMs: 230_100 }]);
    s2.deliver(TASK, 'task.result', B, 1, { status: 'done', summary: '恢复后交付' }, 300);
    expect(s2.get(TASK)?.rec.state).toBe('done');
  });

  it('reclaiming 中崩溃 → 恢复 → cancel.ack 提前收口 → 改派 → offered(attempt=2)', () => {
    const store = new MemoryStore();
    const s1 = new LeadSupervisor({ store });
    s1.create(TASK, 'project');
    s1.dispatch(TASK, B, BODY, 0);
    s1.deliver(TASK, 'task.accept', B, 1, { lease_ms: 300000 }, 0);
    s1.deliver(TASK, 'task.fail', B, 1, { reason_code: 'internal_error', retryable: true, summary: 'x' }, 100);
    expect(s1.get(TASK)?.rec.state).toBe('reclaiming');

    const s2 = new LeadSupervisor({ store });
    s2.restoreAll();
    expect(pendingTimers(s2.get(TASK) as LeadTaskMachine)).toEqual([{ timer: 'drain', atMs: 30_100 }]);
    const actions = s2.deliver(TASK, 'task.cancel.ack', B, 1, {}, 5_000);
    expect(actions.some((a) => a.kind === 'requestDispatch')).toBe(true);
    s2.redispatch(TASK, B, BODY, 5_100);
    expect(s2.get(TASK)?.rec.state).toBe('offered');
    expect(s2.get(TASK)?.rec.attempt).toBe(2);
  });

  it('终态任务恢复后保持终态;JsonFileStore 跨进程接管', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'qlong-cp-')), 'cp');
    const s1 = new LeadSupervisor({ store: new JsonFileStore(dir) });
    s1.create(TASK, 'project');
    s1.dispatch(TASK, B, BODY, 0);
    s1.deliver(TASK, 'task.accept', B, 1, { lease_ms: 300000 }, 0);
    s1.deliver(TASK, 'task.result', B, 1, { status: 'done', summary: 'ok' }, 100);

    const s2 = new LeadSupervisor({ store: new JsonFileStore(dir) });
    s2.restoreAll();
    expect(s2.get(TASK)?.rec.state).toBe('done');
    expect(s2.get(TASK)?.terminal).toBe(true);
  });
});