import { describe, expect, it } from 'vitest';
import { Registry } from '../src/directory.js';

describe('任务注册表(v0.2)', () => {
  it('upsertTask + listTasks 按团队过滤', () => {
    const r = new Registry({ now: () => Date.now() });
    r.upsertTask({ task_id: 't1', type: 'project', team_id: 'team-a', lead: 'n1', exec: 'n2', attempt: 1, status: 'running' });
    r.upsertTask({ task_id: 't2', type: 'aid', team_id: 'team-b', lead: 'n3', exec: 'n4', attempt: 1, status: 'done' });
    r.upsertTask({ task_id: 't3', type: 'project', team_id: 'team-a', lead: 'n1', exec: 'n5', attempt: 2, status: 'done' });
    const tasksA = r.listTasks('team-a');
    expect(tasksA).toHaveLength(2);
    expect(tasksA[0]!.task_id).toBe('t1');
    expect(tasksA[1]!.status).toBe('done');
  });

  it('upsert 同 task_id 覆盖', () => {
    const r = new Registry({ now: () => Date.now() });
    r.upsertTask({ task_id: 't1', type: 'project', team_id: 'team-a', lead: 'n1', exec: 'n2', attempt: 1, status: 'running' });
    r.upsertTask({ task_id: 't1', type: 'project', team_id: 'team-a', lead: 'n1', exec: 'n2', attempt: 2, status: 'done' });
    expect(r.listTasks('team-a')).toHaveLength(1);
    expect(r.listTasks('team-a')[0]!.status).toBe('done');
  });
});