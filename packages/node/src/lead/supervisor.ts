/**
 * 牵头方任务监督器:持有同机全部活动任务,每次转移后落检查点;
 * 进程重启后 restoreAll() 从存储恢复(接管 = 检查点重放,01 §4.4)。
 */
import type { QlongParams } from '@qlong/core';
import type { LeadAction, LeadHistoryEntry } from './machine.js';
import { LeadTaskMachine } from './machine.js';
import { checkpointLeadMachine, restoreLeadMachine } from './checkpoint.js';
import type { CheckpointStore } from './store.js';

export interface SupervisorDeps {
  store: CheckpointStore;
  params?: QlongParams;
  validateAcceptance?: (b: Record<string, unknown>) => boolean;
}

export class LeadSupervisor {
  private machines = new Map<string, LeadTaskMachine>();

  constructor(private readonly deps: SupervisorDeps) {}

  create(taskId: string, kind: 'aid' | 'project'): LeadTaskMachine {
    const m = new LeadTaskMachine({
      task_id: taskId,
      kind,
      params: this.deps.params,
      validateAcceptance: this.deps.validateAcceptance,
    });
    this.machines.set(taskId, m);
    this.persist(m);
    return m;
  }

  /** 进程重启后调用:从存储恢复全部任务(含终态,供查询/审计) */
  restoreAll(): string[] {
    for (const taskId of this.deps.store.list()) {
      const blob = this.deps.store.load(taskId);
      if (!blob) continue;
      const m = restoreLeadMachine(blob, this.deps);
      this.machines.set(taskId, m);
    }
    return [...this.machines.keys()];
  }

  get(taskId: string): LeadTaskMachine | undefined {
    return this.machines.get(taskId);
  }

  dispatch(taskId: string, target: string, offerBody: Record<string, unknown>, now: number): LeadAction[] {
    const m = this.must(taskId);
    const actions = m.dispatchTo(target, offerBody, now);
    this.persist(m);
    return actions;
  }

  redispatch(taskId: string, target: string, offerBody: Record<string, unknown>, now: number): LeadAction[] {
    const m = this.must(taskId);
    const actions = m.redispatchTo(target, offerBody, now);
    this.persist(m);
    return actions;
  }

  deliver(
    taskId: string,
    type: string,
    from: string,
    attempt: number,
    body: Record<string, unknown>,
    now: number,
  ): LeadAction[] {
    const m = this.must(taskId);
    const actions = m.onMessage(type, from, attempt, body, now);
    this.persist(m);
    return actions;
  }

  tick(taskId: string, timer: Parameters<LeadTaskMachine['onTimer']>[0], now: number): LeadAction[] {
    const m = this.must(taskId);
    const actions = m.onTimer(timer, now);
    this.persist(m);
    return actions;
  }

  cancel(taskId: string, now: number): LeadAction[] {
    const m = this.must(taskId);
    const actions = m.cancelByUser(now);
    this.persist(m);
    return actions;
  }

  historyOf(taskId: string): readonly LeadHistoryEntry[] {
    return this.must(taskId).rec.history;
  }

  private must(taskId: string): LeadTaskMachine {
    const m = this.machines.get(taskId);
    if (!m) throw new Error(`supervisor: 任务不存在 ${taskId}`);
    return m;
  }

  private persist(m: LeadTaskMachine): void {
    this.deps.store.save(m.task_id, checkpointLeadMachine(m));
  }
}

