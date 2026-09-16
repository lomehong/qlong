import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { StorageError } from '../../storage/src/index.js';
import type { SqliteStore } from '../../storage/src/index.js';
import type { EnrollRecord, GrantRecord, NodeRecord, TeamRecord } from './directory.js';
import { TASK_STATUSES, taskProjectionHash, type TaskProjection } from './task-projection.js';

/** Schema fragment only: the center owns the combined registry/auth migration. */
export const REGISTRY_SQL = `
CREATE TABLE registry_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  audit_offset INTEGER NOT NULL CHECK (audit_offset >= 0)
) STRICT;
INSERT INTO registry_meta (id, epoch, audit_offset) VALUES (1, 0, 0);
CREATE TABLE registry_teams (id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
CREATE TABLE registry_nodes (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES registry_teams(id) DEFERRABLE INITIALLY DEFERRED,
  token_hash TEXT NOT NULL UNIQUE, record TEXT NOT NULL
) STRICT;
CREATE TABLE registry_enroll_tokens (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES registry_teams(id) DEFERRABLE INITIALLY DEFERRED,
  used_by TEXT REFERENCES registry_nodes(id) DEFERRABLE INITIALLY DEFERRED,
  record TEXT NOT NULL
) STRICT;
CREATE TABLE registry_grants (
  id TEXT PRIMARY KEY,
  from_team TEXT NOT NULL REFERENCES registry_teams(id) DEFERRABLE INITIALLY DEFERRED,
  to_team TEXT NOT NULL REFERENCES registry_teams(id) DEFERRABLE INITIALLY DEFERRED,
  record TEXT NOT NULL
) STRICT;
CREATE TABLE registry_tasks (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES registry_teams(id) DEFERRABLE INITIALLY DEFERRED,
  lead TEXT NOT NULL REFERENCES registry_nodes(id) DEFERRABLE INITIALLY DEFERRED,
  exec TEXT REFERENCES registry_nodes(id) DEFERRABLE INITIALLY DEFERRED,
  record TEXT NOT NULL
) STRICT;
-- Audit subjects can be unknown (e.g. failed authentication) or already GC'd.
CREATE TABLE registry_audit (id INTEGER PRIMARY KEY, record TEXT NOT NULL) STRICT;
`;

export interface TaskRecord extends TaskProjection {
  updated_at: string;
  content_hash: string;
}

export interface AuditRecord {
  ts: string; event: string; node: string; team: string; reason: string; trace_id?: string;
}

export interface RegistryState {
  teams: Map<string, TeamRecord>;
  nodes: Map<string, NodeRecord>;
  enrollTokens: Map<string, EnrollRecord>;
  nodeByTokenHash: Map<string, string>;
  grants: Map<string, GrantRecord>;
  taskIndex: Map<string, TaskRecord>;
  auditLog: AuditRecord[];
  auditOffset: number;
  directoryEpoch: number;
}

export function emptyRegistryState(): RegistryState {
  return {
    teams: new Map(), nodes: new Map(), enrollTokens: new Map(), nodeByTokenHash: new Map(),
    grants: new Map(), taskIndex: new Map(), auditLog: [], auditOffset: 0, directoryEpoch: 0,
  };
}

type Check = (value: unknown) => boolean;
const text: Check = (v) => typeof v === 'string';
const nonempty: Check = (v) => typeof v === 'string' && v.length > 0;
const integer: Check = (v) => Number.isSafeInteger(v) && (v as number) >= 0;
const positive: Check = (v) => integer(v) && (v as number) > 0;
const finite: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const hash: Check = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const timestamp: Check = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const optional = (check: Check): Check => (v) => v === undefined || check(v);
const nullable = (check: Check): Check => (v) => v === null || check(v);
const oneOf = (...values: string[]): Check => (v) => typeof v === 'string' && values.includes(v);
const array = (check: Check): Check => (v) => Array.isArray(v) && Array.from(v).every(check);

function object(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
}

function shape(fields: Record<string, Check>): Check {
  return (v) => object(v) && Object.keys(v).every((k) => Object.hasOwn(fields, k)) &&
    Object.entries(fields).every(([key, check]) => check(v[key]));
}

/** Reject non-JSON values instead of silently changing them while serializing. */
function json(v: unknown): boolean {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return Array.from(v).every(json);
  return object(v) && Object.values(v).every(json);
}

const teamShape = shape({
  team_id: nonempty, name: text, owner_user_id: optional(nullable(text)),
  state: oneOf('active', 'self-owned', 'orphan'), created_at: timestamp,
});
const nodeShape = shape({
  node_id: nonempty, team_id: nonempty, name: nonempty,
  status: oneOf('active', 'suspended', 'revoked'), tokenHash: hash,
  keys: array(shape({ epoch: positive, pubkey: nonempty })),
  platform: optional(text), qlong_version: optional(text), caps: array(nonempty), caps_rev: positive,
  load: optional(nullable((v) => object(v) && json(v))), last_seen: optional(timestamp), joined_at: timestamp,
});
const enrollShape = shape({
  tokenHash: hash, team_id: nonempty, created_by: optional(text), expiresAt: finite,
  used_by: optional(nonempty), consumed_at: optional(timestamp),
});
const grantShape = shape({
  grant_id: nonempty, from_team: nonempty, to_team: nonempty, caps_visible: array(nonempty),
  expires_at: optional(finite), created_by: optional(text), created_at: timestamp,
});
const taskShape = shape({
  task_id: nonempty, type: oneOf('aid', 'project'), team_id: nonempty, lead: nonempty, exec: nullable(nonempty),
  attempt: positive, status: oneOf(...TASK_STATUSES), task_seq: integer, content_hash: hash, updated_at: timestamp,
});
const auditShape = shape({
  ts: timestamp, event: nonempty, node: text, team: text, reason: text, trace_id: optional(text),
});

function requireValid(condition: unknown): asserts condition {
  // Never include row contents, token hashes or SQL values in recovery errors.
  if (!condition) throw new StorageError('DATABASE_CORRUPT', 'Invalid registry state; explicit recovery required');
}

export function validateRegistryState(state: RegistryState): void {
  requireValid(integer(state.directoryEpoch) && integer(state.auditOffset) &&
    integer(state.auditOffset + state.auditLog.length) && state.auditLog.length <= 10_000);
  requireValid(state.directoryEpoch >= state.nodes.size + state.grants.size);
  for (const [id, team] of state.teams) requireValid(teamShape(team) && team.team_id === id);
  const tokens = new Map<string, string>();
  for (const [id, node] of state.nodes) {
    requireValid(nodeShape(node) && node.node_id === id && state.teams.has(node.team_id));
    requireValid(node.keys.length > 0 && node.keys.every((key, i) => i === 0 || key.epoch > node.keys[i - 1]!.epoch));
    requireValid(node.keys[node.keys.length - 1]!.epoch <= state.directoryEpoch);
    requireValid(!tokens.has(node.tokenHash));
    tokens.set(node.tokenHash, id);
  }
  requireValid(tokens.size === state.nodeByTokenHash.size);
  for (const [token, id] of tokens) requireValid(state.nodeByTokenHash.get(token) === id);
  for (const [id, rec] of state.enrollTokens) {
    requireValid(enrollShape(rec) && rec.tokenHash === id && state.teams.has(rec.team_id));
    requireValid((rec.used_by === undefined) === (rec.consumed_at === undefined));
    if (rec.used_by !== undefined) requireValid(state.nodes.has(rec.used_by));
  }
  for (const [id, grant] of state.grants) {
    requireValid(grantShape(grant) && grant.grant_id === id && grant.from_team !== grant.to_team &&
      state.teams.has(grant.from_team) && state.teams.has(grant.to_team));
  }
  for (const [id, task] of state.taskIndex) {
    requireValid(taskShape(task) && task.task_id === id && state.teams.has(task.team_id) &&
      state.nodes.has(task.lead) && (task.exec === null || state.nodes.has(task.exec)));
    requireValid(task.content_hash === taskProjectionHash(task));
  }
  for (const event of state.auditLog) requireValid(auditShape(event));
}

interface Table<T> {
  name: string;
  columns: string[];
  values: (record: T) => SQLInputValue[];
  records: (state: RegistryState) => Map<string | number, T>;
  check: Check;
}

// Names/columns are trusted constants. All record data is bound, never SQL-interpolated.
function table<T>(name: string, columns: string[], values: Table<T>['values'], records: Table<T>['records'], check: Check): Table<T> {
  return { name, columns, values, records, check };
}
const teams = table<TeamRecord>('registry_teams', ['id'], (r) => [r.team_id], (s) => new Map(s.teams), teamShape);
const nodes = table<NodeRecord>('registry_nodes', ['id', 'team_id', 'token_hash'],
  (r) => [r.node_id, r.team_id, r.tokenHash], (s) => new Map(s.nodes), nodeShape);
const enrolls = table<EnrollRecord>('registry_enroll_tokens', ['id', 'team_id', 'used_by'],
  (r) => [r.tokenHash, r.team_id, r.used_by ?? null], (s) => new Map(s.enrollTokens), enrollShape);
const grants = table<GrantRecord>('registry_grants', ['id', 'from_team', 'to_team'],
  (r) => [r.grant_id, r.from_team, r.to_team], (s) => new Map(s.grants), grantShape);
const tasks = table<TaskRecord>('registry_tasks', ['id', 'team_id', 'lead', 'exec'],
  (r) => [r.task_id, r.team_id, r.lead, r.exec], (s) => new Map(s.taskIndex), taskShape);
const audit = table<AuditRecord>('registry_audit', ['id'], () => [],
  (s) => new Map(s.auditLog.map((record, i) => [s.auditOffset + i, record])), auditShape);

function recover<T>(db: DatabaseSync, spec: Table<T>): Map<string | number, T> {
  const records = new Map<string | number, T>();
  // Text primary keys retain insertion order via rowid; updates must not reorder task lists.
  for (const row of db.prepare(`SELECT ${spec.columns.join(', ')}, record FROM ${spec.name} ORDER BY rowid`).all()) {
    requireValid(typeof row.record === 'string');
    let record: unknown;
    try { record = JSON.parse(row.record); } catch { requireValid(false); }
    requireValid(spec.check(record));
    const values = spec.values(record as T);
    requireValid(values.every((value, i) => row[spec.columns[i]!] === value));
    requireValid(typeof row.id === 'string' || typeof row.id === 'number');
    if (spec.name === 'registry_audit') requireValid(integer(row.id));
    else requireValid(nonempty(row.id));
    requireValid(!records.has(row.id));
    records.set(row.id, record as T);
  }
  return records;
}

export function loadRegistryState(storage: SqliteStore): RegistryState {
  const db = storage.database;
  const meta = db.prepare('SELECT id, epoch, audit_offset FROM registry_meta').all();
  requireValid(meta.length === 1 && meta[0]!.id === 1 && integer(meta[0]!.epoch) && integer(meta[0]!.audit_offset));
  const state = emptyRegistryState();
  state.directoryEpoch = meta[0]!.epoch as number;
  state.auditOffset = meta[0]!.audit_offset as number;
  state.teams = recover(db, teams) as Map<string, TeamRecord>;
  state.nodes = recover(db, nodes) as Map<string, NodeRecord>;
  state.enrollTokens = recover(db, enrolls) as Map<string, EnrollRecord>;
  state.grants = recover(db, grants) as Map<string, GrantRecord>;
  state.taskIndex = recover(db, tasks) as Map<string, TaskRecord>;
  const events = recover(db, audit);
  for (const [id, record] of events) {
    requireValid(id === state.auditOffset + state.auditLog.length);
    state.auditLog.push(record);
  }
  // Revoked mappings intentionally survive, so authentication still reports node_revoked.
  for (const node of state.nodes.values()) state.nodeByTokenHash.set(node.tokenHash, node.node_id);
  validateRegistryState(state);
  return state;
}

function writeDiff<T>(db: DatabaseSync, spec: Table<T>, before: RegistryState, after: RegistryState): void {
  const old = spec.records(before);
  const next = spec.records(after);
  const remove = db.prepare(`DELETE FROM ${spec.name} WHERE id = ?`);
  const columns = [...spec.columns, 'record'];
  const upsert = db.prepare(`INSERT INTO ${spec.name} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
    ON CONFLICT(id) DO UPDATE SET ${columns.slice(1).map((col) => `${col} = excluded.${col}`).join(', ')}`);
  for (const id of old.keys()) if (!next.has(id)) remove.run(id);
  for (const [id, record] of next) {
    const encoded = JSON.stringify(record);
    if (old.has(id) && JSON.stringify(old.get(id)) === encoded) continue;
    const values = spec.values(record);
    upsert.run(...(spec.name === 'registry_audit' ? [id] : values), encoded);
  }
}

/** Caller publishes its detached draft only after this function returns. Never owns/closes storage. */
export function commitRegistryState(storage: SqliteStore, before: RegistryState, after: RegistryState): void {
  validateRegistryState(after);
  storage.transaction((db) => {
    // Deferred FKs permit a complete cross-table diff (join/consume/GC) in one transaction.
    writeDiff(db, teams, before, after);
    writeDiff(db, nodes, before, after);
    writeDiff(db, enrolls, before, after);
    writeDiff(db, grants, before, after);
    writeDiff(db, tasks, before, after);
    writeDiff(db, audit, before, after);
    const result = db.prepare('UPDATE registry_meta SET epoch = ?, audit_offset = ? WHERE id = 1')
      .run(after.directoryEpoch, after.auditOffset);
    requireValid(result.changes === 1);
  });
}