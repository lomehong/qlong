import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect } from 'vitest';
import { newId, type EnvelopeV1 } from '@qlong/core';
import { SqliteStore, StorageError, type SqliteStoreOptions } from '../../storage/src/index.js';
import { NODE_SCHEMA } from '../src/runtime/schema.js';
import { NodeRuntimeStore, type ConsumeRequest, type RuntimeTransition } from '../src/runtime/store.js';

export const LOCAL = '10000000-0000-4000-8000-000000000001';
export const SENDER = '10000000-0000-4000-8000-000000000002';
export const OTHER = '10000000-0000-4000-8000-000000000003';
const tempBase = realpathSync(tmpdir());
const roots = new Set<string>();
const stores = new Set<SqliteStore>();

export function open(options: SqliteStoreOptions): SqliteStore {
  const store = SqliteStore.open(options);
  stores.add(store);
  return store;
}

export function fixture(limits: { maxEntries?: number; maxBytes?: number; retentionMs?: number; now?: () => number } = {}) {
  const root = mkdtempSync(join(tempBase, 'qlong-runtime-'));
  roots.add(root);
  const options: SqliteStoreOptions = {
    allowedBase: root, dataDir: join(root, 'data'), mode: 'create', schema: NODE_SCHEMA,
    localFilesystemConfirmed: true, windowsAclConfirmed: true, busyTimeoutMs: 25,
  };
  const store = open(options);
  return { options, store, runtime: new NodeRuntimeStore(store, LOCAL, limits) };
}

/** Deliberately format-valid but not cryptographically verified: verification belongs to the client. */
export function env(overrides: Partial<EnvelopeV1> = {}): EnvelopeV1 {
  return {
    v: 1, type: 'task.offer', msg_id: newId(), task_id: newId(), attempt: 1, hops: 0,
    ts: '2026-09-15T00:00:00Z', exp: '2026-09-16T00:00:00Z',
    from: { node_id: SENDER, key_epoch: 1 }, to: { node_id: LOCAL },
    trace: { trace_id: newId(), parent_span: null, origin_node: SENDER },
    sig: { alg: 'ed25519', value: Buffer.alloc(64).toString('base64') },
    body: { kind: 'project', description: 'work' }, ...overrides,
  };
}

export function request(envelope: EnvelopeV1, expectedRevision = 0): ConsumeRequest {
  return { fromNode: envelope.from.node_id, msgId: envelope.msg_id, stateKey: 'task', expectedRevision };
}

export function transition(): RuntimeTransition {
  return {
    state: { count: 1 },
    outbox: [env({ from: { node_id: LOCAL, key_epoch: 1 }, to: { node_id: SENDER } })],
    effects: [{ id: newId(), kind: 'execute', payload: { command: 'work' } }],
  };
}

/** Test-only damage/inspection connection. Never weaken the managed connection's PRAGMAs. */
export function rawDatabase<T>(store: SqliteStore, action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(store.path, { enableForeignKeyConstraints: false });
  try {
    db.exec('PRAGMA ignore_check_constraints = ON');
    return action(db);
  } finally { db.close(); }
}

export function expectCorrupt(store: SqliteStore, operation: () => unknown): void {
  let published = false;
  expect(() => { operation(); published = true; }).toThrow(expect.objectContaining({ code: 'DATABASE_CORRUPT' }));
  expect(published).toBe(false);
  expect(store.state).toBe('faulted');
  expect(store.fault).toBeInstanceOf(StorageError);
  expect(store.fault?.code).toBe('DATABASE_CORRUPT');
  expect(() => store.database).toThrow(expect.objectContaining({ code: 'STORE_FAULTED' }));
}

/** Deferred FK failure is raised by actual SQLite COMMIT, not a mocked return value. */
export function failCommit(store: SqliteStore, event: 'consume' | 'receive' | 'stored'): void {
  const trigger = {
    consume: "AFTER UPDATE OF decision ON node_inbox WHEN NEW.decision = 'applied'",
    receive: 'AFTER INSERT ON node_inbox',
    stored: 'AFTER DELETE ON node_outbox',
  }[event];
  store.transaction((db) => db.exec(`
    CREATE TABLE runtime_test_parent (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE runtime_test_child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL
      REFERENCES runtime_test_parent(id) DEFERRABLE INITIALLY DEFERRED) STRICT;
    CREATE TRIGGER runtime_test_commit_failure ${trigger} BEGIN
      INSERT INTO runtime_test_child VALUES ('failure', 'missing');
    END;
  `));
}

afterEach(() => {
  for (const store of [...stores].reverse()) store.close();
  stores.clear();
  for (const root of roots) {
    if (dirname(root) !== tempBase || !basename(root).startsWith('qlong-runtime-')) {
      throw new Error('Unsafe runtime test cleanup target');
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  roots.clear();
});