import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { newId, newKeyPair, signEnvelope, type EnvelopeV1 } from '@qlong/core';
import { defineMigration, SqliteStore, type SqliteStoreOptions } from '../../storage/src/index.js';
import { CUSTODY_SQL, SqliteCustodyStore, encodeCustody, offerInTransaction } from '../src/custody-store.js';

/**
 * F1/P2 slice2 (s2b):custody 的 db 级 offer 抽取——供旧数据迁移导入器在**单事务**内复用。
 *
 * SqliteStore.transaction 禁嵌套/禁 async,导入器必须把 users/auth_meta/mailbox/ledger 的全部副作用
 * 落进一个同步事务;custody.offer() 自开事务无法组合。故抽出 offerInTransaction(db, encoded, now, limits)
 * 与 encodeCustody(env),offer() 变薄委托,**行为逐字不变**(既有 custody-store.spec.ts 全量作护栏)。
 * 关键判据:offerInTransaction 必须能与其它写在同一事务内原子落库(导入器的硬需求)。
 */
const NOW = Date.parse('2026-09-19T12:00:00.000Z');
const FROM = newId(), TO = newId();
const signingKey = newKeyPair();
const LIMITS = { maxEntries: 10_000, maxBytes: 64 * 1024 * 1024, perNodeEntries: 1_000 };
const stores = new Set<SqliteStore>();
const tempBase = realpathSync(tmpdir());
const roots = new Set<string>();
const schema = {
  id: 'qlong.custody-tx-test',
  migrations: [defineMigration({ version: 1, name: 'custody', sql: CUSTODY_SQL })],
};

function storageOptions(): SqliteStoreOptions {
  const root = mkdtempSync(join(tempBase, 'qlong-custodytx-'));
  roots.add(root);
  return {
    allowedBase: root, dataDir: join(root, 'data'), mode: 'create', schema,
    localFilesystemConfirmed: true, windowsAclConfirmed: true, busyTimeoutMs: 25,
  };
}

function fixture() {
  const settings = storageOptions();
  const storage = SqliteStore.open(settings);
  stores.add(storage);
  return { storage, custody: new SqliteCustodyStore(storage) };
}

function message(overrides: Partial<EnvelopeV1> = {}): EnvelopeV1 {
  return signEnvelope({
    v: 1, type: 'task.offer', msg_id: newId(), ts: new Date(NOW).toISOString(),
    exp: new Date(NOW + 60_000).toISOString(), from: { node_id: FROM, key_epoch: 1 }, to: { node_id: TO },
    trace: { trace_id: newId(), parent_span: null, origin_node: FROM }, hops: 0, task_id: newId(), attempt: 1,
    body: { kind: 'project', summary: 'synthetic custody-tx fixture' }, ...overrides,
  }, signingKey.priv);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const storage of [...stores].reverse()) storage.close();
  stores.clear();
  for (const root of roots) {
    if (dirname(root) !== tempBase || !basename(root).startsWith('qlong-custodytx-')) {
      throw new Error('Unsafe custody-tx test cleanup target');
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  roots.clear();
});

describe('offerInTransaction + encodeCustody (F1/P2 s2b: db-level offer for single-tx import)', () => {
  it('stores an offer inside a caller-owned transaction (no self-opened transaction)', () => {
    const f = fixture();
    const env = message();
    const encoded = encodeCustody(env);
    expect(encoded).toBeDefined();
    const result = f.storage.transaction((db) => offerInTransaction(db, encoded!, NOW, LIMITS));
    expect(result).toBe('stored');
    expect(f.custody.outcome(env.from.node_id, env.msg_id)?.status).toBe('pending');
  });

  it('composes atomically with an unrelated write in a SINGLE transaction (the importer requirement)', () => {
    const f = fixture();
    const env = message();
    const encoded = encodeCustody(env)!;
    f.storage.transaction((db) => {
      db.prepare('CREATE TABLE import_probe (id INTEGER PRIMARY KEY) STRICT').run();
      db.prepare('INSERT INTO import_probe (id) VALUES (1)').run();
      offerInTransaction(db, encoded, NOW, LIMITS);
    });
    expect(f.storage.database.prepare('SELECT id FROM import_probe').get()?.id).toBe(1);
    expect(f.custody.outcome(env.from.node_id, env.msg_id)?.status).toBe('pending');
  });

  it('is idempotent on the identical envelope and reports conflict on a differing body (same identity)', () => {
    const f = fixture();
    const env = message();
    expect(f.storage.transaction((db) => offerInTransaction(db, encodeCustody(env)!, NOW, LIMITS))).toBe('stored');
    expect(f.storage.transaction((db) => offerInTransaction(db, encodeCustody(env)!, NOW, LIMITS))).toBe('stored');
    const clash = message({ msg_id: env.msg_id, from: env.from, body: { kind: 'project', summary: 'different' } });
    expect(f.storage.transaction((db) => offerInTransaction(db, encodeCustody(clash)!, NOW, LIMITS))).toBe('conflict');
  });

  it('never stores an already-expired envelope and never extends its expiry (mailbox 四不)', () => {
    const f = fixture();
    const env = message();
    expect(f.storage.transaction((db) => offerInTransaction(db, encodeCustody(env)!, NOW + 120_000, LIMITS))).toBe('expired');
    expect(f.custody.outcome(env.from.node_id, env.msg_id)).toBeUndefined();
  });

  it('honours caller-supplied per-recipient quota (full)', () => {
    const f = fixture();
    const limits = { maxEntries: 10_000, maxBytes: 64 * 1024 * 1024, perNodeEntries: 1 };
    const a = message();
    const b = message(); // same recipient TO, distinct msg_id
    expect(f.storage.transaction((db) => offerInTransaction(db, encodeCustody(a)!, NOW, limits))).toBe('stored');
    expect(f.storage.transaction((db) => offerInTransaction(db, encodeCustody(b)!, NOW, limits))).toBe('full');
  });

  it('interoperates with offer(): the delegating offer() and the db-level path share one table', () => {
    const f = fixture();
    const viaOffer = message();
    expect(f.custody.offer(viaOffer, NOW)).toBe('stored');
    // A db-level offer for a different message coexists; re-offering viaOffer through the db path is idempotent.
    const viaTx = message();
    expect(f.storage.transaction((db) => offerInTransaction(db, encodeCustody(viaTx)!, NOW, LIMITS))).toBe('stored');
    expect(f.storage.transaction((db) => offerInTransaction(db, encodeCustody(viaOffer)!, NOW, LIMITS))).toBe('stored');
    expect(f.custody.outcome(viaTx.from.node_id, viaTx.msg_id)?.status).toBe('pending');
  });
});
