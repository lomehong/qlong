/**
 * 牵头方检查点与接管(01 §4.4 / 评审 I-35 定案):
 * v1 接管 = 同一物理节点上的进程重启 + 本地检查点重放;图谱不出节点。
 * 检查点自带 attempt 高水位与在途 (task_id, attempt, 执行方) 信息(rec 内),满足跨机接管的前置预留。
 */
import type { QlongParams } from '@qlong/core';
import { LeadTaskMachine, type LeadRecord } from './machine.js';

export interface LeadCheckpoint {
  v: 1;
  task_id: string;
  kind: 'aid' | 'project';
  terminal: boolean;
  rec: LeadRecord;
}

export function checkpointLeadMachine(m: LeadTaskMachine): string {
  const cp: LeadCheckpoint = { v: 1, task_id: m.task_id, kind: m.rec.kind, terminal: m.terminal, rec: m.rec };
  return JSON.stringify(cp);
}

export interface RestoreOptions {
  params?: QlongParams;
  /** 验收判据是函数,不入检查点 —— 由新进程重新注入(01 §4.4) */
  validateAcceptance?: (b: Record<string, unknown>) => boolean;
}

export function restoreLeadMachine(blob: string, opts: RestoreOptions = {}): LeadTaskMachine {
  const cp = JSON.parse(blob) as LeadCheckpoint;
  if (cp.v !== 1) throw new Error(`checkpoint: 不支持的版本 ${cp.v}`);
  const m = new LeadTaskMachine({
    task_id: cp.task_id,
    kind: cp.kind,
    params: opts.params,
    validateAcceptance: opts.validateAcceptance,
  });
  m.rec = cp.rec;
  m.terminal = cp.terminal;
  return m;
}

/** 重挂定时器清单:恢复进程按 rec 重建调度(定时器本身不进检查点) */
export function pendingTimers(m: LeadTaskMachine): Array<{ timer: string; atMs: number }> {
  const r = m.rec;
  const out: Array<{ timer: string; atMs: number }> = [];
  if (r.state === 'offered' && r.offerTtlUntil !== undefined) out.push({ timer: 'offer_ttl', atMs: r.offerTtlUntil });
  if (r.state === 'running' && r.leaseDeadline !== undefined) out.push({ timer: 'lease', atMs: r.leaseDeadline });
  if (r.state === 'reclaiming' && !r.drainClosed && r.drainUntil !== undefined) {
    out.push({ timer: 'drain', atMs: r.drainUntil });
  }
  if (r.state === 'cancelling' && r.cancelWaitUntil !== undefined) {
    out.push({ timer: 'cancel_wait', atMs: r.cancelWaitUntil });
  }
  return out;
}