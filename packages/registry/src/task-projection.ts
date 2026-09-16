import { jcs, sha256Hex } from '@qlong/core';
import { ApiError } from './errors.js';

/** Read-only projection of the lead machine, not a scheduling command or state machine. */
export interface TaskProjection {
  task_id: string;
  type: string;
  team_id: string;
  lead: string;
  exec: string | null;
  attempt: number;
  status: string;
  /** Lead-owned revision across attempts; never resets on reassignment. */
  task_seq: number;
}

// Mirrors LeadState in node/lead/machine.ts without importing node runtime code.
export const TASK_STATUSES = [
  'drafting', 'offered', 'running', 'reclaiming', 'cancelling',
  'done', 'failed', 'escalated', 'closed',
] as const;
const fields = new Set(['task_id', 'type', 'kind', 'team_id', 'lead', 'exec', 'attempt', 'status', 'task_seq']);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Wire contract: exactly one of console-compatible `type` or its alias `kind`. */
export function parseTaskProjection(input: unknown): TaskProjection {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError('bad_request', '任务投影必须为对象');
  }
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some((key) => !fields.has(key))) {
    throw new ApiError('bad_request', '任务投影包含未知字段');
  }
  if (Object.hasOwn(body, 'type') === Object.hasOwn(body, 'kind')) {
    throw new ApiError('bad_request', '必须且只能提供 type 或 kind');
  }
  const type = Object.hasOwn(body, 'type') ? body.type : body.kind;
  if (type !== 'aid' && type !== 'project') throw new ApiError('bad_request', 'type/kind 必须为 aid 或 project');
  if (!nonempty(body.task_id) || !nonempty(body.team_id) || !nonempty(body.lead)) {
    throw new ApiError('bad_request', 'task_id、team_id、lead 必填');
  }
  if (body.exec !== undefined && body.exec !== null && !nonempty(body.exec)) {
    throw new ApiError('bad_request', 'exec 必须为节点 ID 或 null');
  }
  if (!Number.isSafeInteger(body.task_seq) || (body.task_seq as number) < 0) {
    throw new ApiError('bad_request', 'task_seq 必须为非负安全整数');
  }
  if (!Number.isSafeInteger(body.attempt) || (body.attempt as number) < 1) {
    throw new ApiError('bad_request', 'attempt 必须为正安全整数');
  }
  if (!TASK_STATUSES.some((status) => status === body.status)) {
    throw new ApiError('bad_request', 'status 必须为已知牵头方状态');
  }
  return {
    task_id: body.task_id, type, team_id: body.team_id, lead: body.lead,
    exec: (body.exec as string | null | undefined) ?? null,
    attempt: body.attempt as number, status: body.status as string, task_seq: body.task_seq as number,
  };
}

/** Hash only normalized report content; server timestamps and hash metadata are excluded. */
export function taskProjectionHash(task: TaskProjection): string {
  return sha256Hex(jcs({
    task_id: task.task_id, type: task.type, team_id: task.team_id, lead: task.lead,
    exec: task.exec, attempt: task.attempt, status: task.status, task_seq: task.task_seq,
  }));
}