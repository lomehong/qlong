import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  envelopeDigest, jcs, MAX_TRANSPORT_BYTES, MAX_TRANSPORT_LIFETIME_MS, newId, newKeyPair, signEnvelope,
  type EnvelopeV1,
} from '@qlong/core';
import { defineMigration, SqliteStore, type SqliteStoreOptions } from '../../storage/src/index.js';
import { CUSTODY_SQL, SqliteCustodyStore } from '../src/custody-store.js';

const NOW = Date.parse('2026-09-15T12:00:00.000Z');
const FROM = newId(), TO = newId(), OTHER = newId();
// Ephemeral test credentials only. Assertions never include keys, signatures, or payload rows.
const signingKey = newKeyPair();
const stores = new Set<SqliteStore>();
const tempBase = realpathSync(tmpdir());
const roots = new Set<string>();
const schema = {
  id: 'qlong.custody-test',
  migrations: [defineMigration({ version: 1, name: 'custody', sql: CUSTODY_SQL })],
};
type Options = NonNullable<ConstructorParameters<typeof SqliteCustodyStore>[1]>;

function storageOptions(): SqliteStoreOptions {
  const root = mkdtempSync(join(tempBase, 'qlong-custody-'));
  roots.add(root);
  return {
    allowedBase: root, dataDir: join(root, 'data'), mode: 'create', schema,
    localFilesystemConfirmed: true, windowsAclConfirmed: true, busyTimeoutMs: 25,
  };
}

function open(options: SqliteStoreOptions): SqliteStore {
  const storage = SqliteStore.open(options);
  stores.add(storage);
  return storage;
}

function fixture(options: Options = {}) {
  const settings = storageOptions();
  let storage = open(settings);
  let custody = new SqliteCustodyStore(storage, options);
  return {
    get storage() { return storage; },
    get custody() { return custody; },
    reopen() {
      storage.close();
      storage = open({ ...settings, mode: 'open' });
      custody = new SqliteCustodyStore(storage, options);
      return custody;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const storage of [...stores].reverse()) storage.close();
  stores.clear();
  for (const root of roots) {
    if (dirname(root) !== tempBase || !basename(root).startsWith('qlong-custody-')) {
      throw new Error('Unsafe custody test cleanup target');
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  roots.clear();
});

function message(overrides: Partial<EnvelopeV1> = {}): EnvelopeV1 {
  return signEnvelope({
    v: 1, type: 'task.offer', msg_id: newId(), ts: new Date(NOW).toISOString(),
    exp: new Date(NOW + 1_000).toISOString(), from: { node_id: FROM, key_epoch: 1 }, to: { node_id: TO },
    trace: { trace_id: newId(), parent_span: null, origin_node: FROM }, hops: 0, task_id: newId(), attempt: 1,
    body: { kind: 'project', summary: 'synthetic custody fixture' }, ...overrides,
  }, signingKey.priv);
}

function receipt(custody: SqliteCustodyStore, env: EnvelopeV1, now = NOW): boolean {
  return custody.acknowledge(env.to.node_id, env.from.node_id, env.msg_id, envelopeDigest(env), now);
}

function status(custody: SqliteCustodyStore, env: EnvelopeV1) {
  return custody.outcome(env.from.node_id, env.msg_id)?.status;
}

function usage(storage: SqliteStore) {
  return storage.database.prepare(`SELECT count(*) AS entries, coalesce(sum(payload_bytes), 0) AS bytes,
    count(payload) AS payloads FROM gateway_custody`).get();
}

describe('SQLite custody migration and identity', () => {
  it('appends the schema once without altering existing application data', () => {
    const settings = storageOptions();
    const first = defineMigration({ version: 1, name: 'baseline', sql: 'CREATE TABLE baseline (id INTEGER PRIMARY KEY) STRICT; INSERT INTO baseline VALUES (7);' });
    const base = { id: 'qlong.custody-upgrade-test', migrations: [first] };
    open({ ...settings, schema: base }).close();
    const upgraded = { ...base, migrations: [first, defineMigration({ version: 2, name: 'custody', sql: CUSTODY_SQL })] };
    const storage = open({ ...settings, mode: 'open', schema: upgraded });
    const env = message();
    expect(new SqliteCustodyStore(storage).offer(env, NOW)).toBe('stored');
    expect(storage.version).toBe(2);
    expect(storage.database.prepare('SELECT id FROM baseline').get()?.id).toBe(7);
    storage.close();
    const restored = open({ ...settings, mode: 'open', schema: upgraded });
    expect(status(new SqliteCustodyStore(restored), env)).toBe('pending');
    expect(restored.database.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('enforces bounded metadata, payload accounting, and terminal row invariants in SQL', () => {
    const f = fixture(), env = message();
    expect(f.custody.offer(env, NOW)).toBe('stored');
    for (const sql of [
      'UPDATE gateway_custody SET payload = NULL',
      "UPDATE gateway_custody SET status = 'received'",
      'UPDATE gateway_custody SET payload_bytes = payload_bytes + 1',
      "UPDATE gateway_custody SET digest = 'bad'",
      "UPDATE gateway_custody SET msg_id = 'bad'",
      'UPDATE gateway_custody SET expires_at = stored_at',
      `UPDATE gateway_custody SET expires_at = stored_at + ${MAX_TRANSPORT_LIFETIME_MS + 1}`,
    ]) expect(() => f.storage.transaction((db) => db.exec(sql))).toThrow();
    expect(f.storage.state).toBe('open');
    expect(f.custody.offer(env, NOW)).toBe('stored');
    expect(status(f.reopen(), env)).toBe('pending');
  });

  it('stores before returning, reopens online/offline offers, and never shifts pending deliveries', () => {
    const f = fixture();
    const first = message(), second = message(), other = message({ to: { node_id: OTHER } });
    const observer = new SqliteCustodyStore(f.storage);
    for (const env of [first, second, other]) expect(f.custody.offer(env, NOW)).toBe('stored');
    expect(f.storage.database.isTransaction).toBe(false);
    expect(status(observer, first)).toBe('pending');
    for (const getCustody of [() => observer, () => f.reopen()]) {
      const custody = getCustody();
      expect(custody.pending(TO, NOW, 1).map((item) => item.digest)).toEqual([envelopeDigest(first)]);
      expect(custody.pending(TO, NOW, 10).map((item) => item.digest)).toEqual([envelopeDigest(first), envelopeDigest(second)]);
      expect(custody.pending(OTHER, NOW, 10).map((item) => item.digest)).toEqual([envelopeDigest(other)]);
    }
  });

  it('uses full signed JCS and (sender, msg_id), including signature and unknown fields', () => {
    const f = fixture();
    const env = message({ body: { z: 1, a: { y: 'yes', b: false } } });
    expect(f.custody.offer(env, NOW)).toBe('stored');
    const reordered = { ...env, body: { a: { b: false, y: 'yes' }, z: 1 } };
    expect(envelopeDigest(reordered) === envelopeDigest(env)).toBe(true);
    expect(f.custody.offer(reordered, NOW)).toBe('stored');
    const variants = [
      { ...env, body: { z: 2 } }, { ...env, to: { node_id: OTHER } },
      signEnvelope(env, newKeyPair().priv), { ...env, extension: { value: 1 } },
    ];
    for (const changed of variants) {
      expect(envelopeDigest(changed) === envelopeDigest(env)).toBe(false);
      expect(f.custody.offer(changed, NOW)).toBe('conflict');
    }
    const anotherSender = message({ msg_id: env.msg_id, from: { node_id: OTHER, key_epoch: 1 } });
    expect(f.custody.offer(anotherSender, NOW)).toBe('stored');
    expect(f.storage.state).toBe('open');
    expect(usage(f.storage)?.entries).toBe(2);
  });

  it('detaches input and read results instead of caching mutable envelopes', () => {
    const f = fixture();
    const env = message(), expected = envelopeDigest(env);
    expect(f.custody.offer(env, NOW)).toBe('stored');
    env.body.summary = 'mutated input';
    const loaded = f.custody.pending(TO, NOW, 1)[0]!;
    expect(envelopeDigest(loaded.envelope)).toBe(expected);
    loaded.envelope.body.summary = 'mutated output';
    loaded.envelope.to.node_id = OTHER;
    loaded.digest = '0'.repeat(64);
    expect(f.reopen().pending(TO, NOW, 1).map((item) => envelopeDigest(item.envelope))).toEqual([expected]);
  });
});

describe('custody receipts and absolute expiry', () => {
  it('requires the actual recipient plus full identity, preserves a received tombstone, and is idempotent', () => {
    const env = message(), f = fixture({ maxEntries: 1, perNodeEntries: 1 });
    const digest = envelopeDigest(env);
    expect(f.custody.offer(env, NOW)).toBe('stored');
    for (const args of [
      [OTHER, FROM, env.msg_id, digest], [TO, OTHER, env.msg_id, digest],
      [TO, FROM, newId(), digest], [TO, FROM, env.msg_id, '0'.repeat(64)],
    ]) expect(f.custody.acknowledge(args[0]!, args[1]!, args[2]!, args[3]!, NOW)).toBe(false);
    expect(status(f.custody, env)).toBe('pending');
    expect(receipt(f.custody, env)).toBe(true);
    expect(receipt(f.custody, env, NOW + 10_000)).toBe(true);
    expect(f.custody.pending(TO, NOW, 10)).toHaveLength(0);
    expect(usage(f.storage)).toEqual({ entries: 1, bytes: 0, payloads: 0 });
    const restored = f.reopen();
    expect(restored.outcome(FROM, env.msg_id)).toEqual({ status: 'received', digest, toNode: TO });
    expect(restored.offer(env, NOW + 10_000)).toBe('stored');
    expect(restored.offer({ ...env, body: { changed: true } }, NOW + 10_000)).toBe('conflict');
    expect(restored.offer(message(), NOW)).toBe('full');
    expect(restored.outcome(FROM, newId())).toBeUndefined();
  });

  it('expires exactly at exp, persists the tombstone even for limit zero, and never extends expiry on retry/reopen', () => {
    const f = fixture({ maxEntries: 1 }), env = message();
    expect(f.custody.offer(env, NOW)).toBe('stored');
    expect(f.custody.offer(env, NOW + 999)).toBe('stored');
    expect(f.reopen().pending(TO, NOW + 999, 1)).toHaveLength(1);
    expect(f.custody.pending(TO, NOW + 1_000, 0)).toHaveLength(0);
    expect(status(f.custody, env)).toBe('expired');
    expect(usage(f.storage)).toEqual({ entries: 1, bytes: 0, payloads: 0 });
    const restored = f.reopen();
    expect(status(restored, env)).toBe('expired');
    expect(restored.offer(env, NOW + MAX_TRANSPORT_LIFETIME_MS * 2)).toBe('stored');
    expect(restored.offer({ ...env, exp: new Date(NOW + 2_000).toISOString() }, NOW + 1_000)).toBe('conflict');
    expect(receipt(restored, env, NOW)).toBe(false); // A clock rollback cannot resurrect a tombstone.
    expect(restored.pending(TO, NOW, 1)).toHaveLength(0);
    expect(restored.offer(message(), NOW)).toBe('full');
  });

  it('rejects a matching late receipt and transactionally records expiry without a prior pending call', () => {
    const f = fixture(), env = message();
    expect(f.custody.offer(env, NOW)).toBe('stored');
    expect(receipt(f.custody, env, NOW + 1_000)).toBe(false);
    expect(status(f.reopen(), env)).toBe('expired');
  });

  it('requires exp for every family and bounds absolute remaining lifetime, not diagnostic ts', () => {
    const f = fixture();
    const boundary = message({ exp: new Date(NOW + MAX_TRANSPORT_LIFETIME_MS).toISOString(), ts: '2000-01-01T00:00:00Z' });
    expect(f.custody.offer(boundary, NOW)).toBe('stored');
    expect(f.custody.offer(boundary, NOW - 1)).toBe('stored'); // Duplicate check precedes freshness.
    expect(f.custody.offer(message({ exp: new Date(NOW + MAX_TRANSPORT_LIFETIME_MS + 1).toISOString() }), NOW)).toBe('invalid');
    expect(f.custody.offer(message({ exp: new Date(NOW).toISOString() }), NOW)).toBe('expired');
    expect(f.custody.offer(message({ exp: new Date(NOW - 1).toISOString() }), NOW)).toBe('expired');
    const offset = message({ exp: '2026-09-15T13:00:01+01:00' });
    expect(f.custody.offer(offset, NOW)).toBe('stored');
    for (const type of ['task.offer', 'rpc.request', 'extension.event']) {
      const missing = message({ type });
      delete missing.exp;
      expect(f.custody.offer(missing, NOW)).toBe('invalid');
    }
    for (const exp of ['tomorrow', '2026-09-15T12:00:01', '2026-02-30T12:00:01Z', '2026-09-15T24:00:00Z']) {
      expect(f.custody.offer(message({ exp }), NOW)).toBe('invalid');
    }
    expect(usage(f.storage)?.entries).toBe(2);
  });
});

describe('custody quotas and input admission', () => {
  it('counts pending per recipient but all terminal identities globally, with no eviction', () => {
    const f = fixture({ maxEntries: 3, perNodeEntries: 1 });
    const first = message(), next = message(), other = message({ to: { node_id: OTHER } });
    expect(f.custody.offer(first, NOW)).toBe('stored');
    expect(f.custody.offer(next, NOW)).toBe('full');
    expect(f.custody.offer(first, NOW)).toBe('stored');
    expect(f.custody.offer(other, NOW)).toBe('stored');
    expect(receipt(f.custody, first)).toBe(true);
    expect(f.custody.offer(next, NOW)).toBe('stored');
    expect(receipt(f.custody, next)).toBe(true);
    expect(f.reopen().offer(message(), NOW)).toBe('full');
    expect(usage(f.storage)?.entries).toBe(3);
    expect(f.storage.state).toBe('open');
  });

  it('keeps existing rows and idempotency when an operator tightens quotas', () => {
    const f = fixture(), first = message(), second = message();
    expect(f.custody.offer(first, NOW)).toBe('stored');
    expect(f.custody.offer(second, NOW)).toBe('stored');
    const smaller = new SqliteCustodyStore(f.storage, { maxEntries: 1, maxBytes: 1, perNodeEntries: 1 });
    expect(smaller.offer(first, NOW)).toBe('stored');
    expect(smaller.offer({ ...first, body: { changed: true } }, NOW)).toBe('conflict');
    expect(smaller.offer(message(), NOW)).toBe('full');
    expect(usage(f.storage)?.entries).toBe(2);
    expect(smaller.pending(TO, NOW, 10)).toHaveLength(2);
  });

  it('bounds exact UTF-8 payload bytes, releases bytes on receipt/expiry, and does not charge duplicates', () => {
    const first = message({ body: { text: '中文🙂' } });
    const bytes = Buffer.byteLength(jcs(first), 'utf8');
    const f = fixture({ maxEntries: 4, maxBytes: bytes, perNodeEntries: 1 });
    expect(f.custody.offer(first, NOW)).toBe('stored');
    expect(usage(f.storage)?.bytes).toBe(bytes);
    expect(f.custody.offer(first, NOW)).toBe('stored');
    const second = message({ body: first.body, to: { node_id: OTHER } });
    expect(f.custody.offer(second, NOW)).toBe('full');
    expect(receipt(f.custody, first)).toBe(true);
    expect(f.custody.offer(second, NOW)).toBe('stored');
    const third = message({ body: first.body, exp: new Date(NOW + 2_000).toISOString(), to: { node_id: OTHER } });
    expect(f.custody.offer(third, NOW + 1_000)).toBe('stored'); // Expiry releases bytes and recipient count.
    expect(status(f.custody, second)).toBe('expired');
    expect(usage(f.storage)).toEqual({ entries: 3, bytes, payloads: 1 });
    expect(f.reopen().offer(third, NOW + 1_000)).toBe('stored');
  });

  it('enforces the transport-size boundary independently from the storage-byte quota', () => {
    const base = message({ body: { text: '' } });
    const padding = MAX_TRANSPORT_BYTES - Buffer.byteLength(jcs(base), 'utf8');
    const exact = signEnvelope({ ...base, body: { text: 'x'.repeat(padding) } }, signingKey.priv);
    const f = fixture({ maxBytes: MAX_TRANSPORT_BYTES * 2 });
    expect(Buffer.byteLength(jcs(exact), 'utf8')).toBe(MAX_TRANSPORT_BYTES);
    expect(f.custody.offer(exact, NOW)).toBe('stored');
    const large = signEnvelope({ ...exact, msg_id: newId(), body: { text: 'x'.repeat(padding + 1) } }, signingKey.priv);
    expect(f.custody.offer(large, NOW)).toBe('invalid');
    expect(f.custody.pending(TO, NOW, 1).map((item) => item.digest)).toEqual([envelopeDigest(exact)]);
  });

  it('rejects invalid quota configurations before accessing SQL without poisoning the store', () => {
    const f = fixture();
    for (const key of ['maxEntries', 'maxBytes', 'perNodeEntries'] as const) {
      for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '1']) {
        expect(() => new SqliteCustodyStore(f.storage, { [key]: value } as Options)).toThrow(RangeError);
      }
    }
    expect(f.storage.state).toBe('open');
    expect(f.custody.offer(message(), NOW)).toBe('stored');
  });

  it('rejects malformed, lossy, cyclic, getter/proxy and oversized JSON without executing user code', () => {
    const f = fixture(), env = message();
    let invoked = false;
    const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { invoked = true; return 1; } });
    const proxy = new Proxy({}, { ownKeys() { invoked = true; return []; } });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const bodies = [
      { value: undefined }, { value: NaN }, { value: Infinity }, { value: 1.5 }, { value: 1n }, { value: () => 1 },
      { value: new Date(NOW) }, { value: new Array(1) }, { value: Symbol('test') },
      { toJSON() { invoked = true; return {}; } }, getter, proxy, cycle,
      { value: '中'.repeat(MAX_TRANSPORT_BYTES / 2) },
    ];
    for (const body of bodies) expect(f.custody.offer({ ...env, body }, NOW)).toBe('invalid');
    for (const invalid of [null, {}, { ...env, sig: undefined }, { ...env, sig: { alg: 'ed25519', value: 'x' } },
      { ...env, from: { node_id: 'bad', key_epoch: 1 } }, { ...env, v: 2 }, { ...env, body: [] }]) {
      expect(f.custody.offer(invalid as EnvelopeV1, NOW)).toBe('invalid');
    }
    expect(invoked).toBe(false);
    // Preserve EnvelopeV1's D23 integer-only numeric contract; transport does not change signed semantics.
    expect(f.custody.offer(env, NaN)).toBe('invalid');
    for (const limit of [-1, 1.5, NaN, Infinity]) expect(f.custody.pending(TO, NOW, limit)).toHaveLength(0);
    expect(f.custody.pending(TO, NaN, 1)).toHaveLength(0);
    expect(f.custody.pending("'); DROP TABLE gateway_custody; --", NOW, 1)).toHaveLength(0);
    expect(f.custody.acknowledge(TO, FROM, env.msg_id, 'bad', NOW)).toBe(false);
    expect(f.custody.outcome('bad', env.msg_id)).toBeUndefined();
    expect(usage(f.storage)?.entries).toBe(0);
    expect(f.storage.state).toBe('open');
  });
});

describe('custody rollback and fail-closed recovery', () => {
  it('rolls back failed inserts, receipts and multi-row expiry without publishing staged results', () => {
    const f = fixture(), first = message(), second = message();
    expect(f.custody.offer(first, NOW)).toBe('stored');
    expect(f.custody.offer(second, NOW)).toBe('stored');
    f.storage.transaction((db) => db.exec(`
      CREATE TRIGGER custody_reject_insert AFTER INSERT ON gateway_custody
        BEGIN SELECT RAISE(ABORT, 'injected custody write failure'); END;
      CREATE TRIGGER custody_reject_update AFTER UPDATE ON gateway_custody
        WHEN NEW.msg_id = (SELECT msg_id FROM gateway_custody ORDER BY rowid DESC LIMIT 1)
        BEGIN SELECT RAISE(ABORT, 'injected custody write failure'); END;
    `));
    const third = message();
    expect(() => f.custody.offer(third, NOW)).toThrow('injected custody write failure');
    expect(status(f.custody, third)).toBeUndefined();
    expect(() => receipt(f.custody, second)).toThrow('injected custody write failure');
    expect(() => f.custody.pending(TO, NOW + 1_000, 10)).toThrow('injected custody write failure');
    expect(status(f.custody, first)).toBe('pending');
    expect(status(f.custody, second)).toBe('pending');
    expect(usage(f.storage)?.payloads).toBe(2);
    expect(f.storage.state).toBe('open');
    expect(status(f.reopen(), first)).toBe('pending');
    f.storage.transaction((db) => db.exec('DROP TRIGGER custody_reject_insert; DROP TRIGGER custody_reject_update;'));
    expect(receipt(f.custody, second)).toBe(true);
    expect(f.custody.pending(TO, NOW + 1_000, 10)).toHaveLength(0);
    expect(status(f.custody, first)).toBe('expired');
  });

  it.each(['offer', 'receipt', 'expiry'] as const)('returns no result on an actual deferred COMMIT failure: %s', (operation) => {
    const f = fixture(), env = message();
    if (operation !== 'offer') expect(f.custody.offer(env, NOW)).toBe('stored');
    f.storage.transaction((db) => db.exec(`
      CREATE TABLE custody_test_parent (id INTEGER PRIMARY KEY) STRICT;
      CREATE TABLE custody_test_commit_fault (
        parent INTEGER REFERENCES custody_test_parent(id) DEFERRABLE INITIALLY DEFERRED
      ) STRICT;
      CREATE TRIGGER custody_commit_fault AFTER ${operation === 'offer' ? 'INSERT' : 'UPDATE'} ON gateway_custody
        BEGIN INSERT INTO custody_test_commit_fault VALUES (1); END;
    `));
    let published = false;
    expect(() => {
      if (operation === 'offer') f.custody.offer(env, NOW);
      else if (operation === 'receipt') receipt(f.custody, env);
      else f.custody.pending(TO, NOW + 1_000, 10);
      published = true;
    }).toThrow();
    expect(published).toBe(false);
    expect(f.storage.state).toBe('faulted');
    expect(() => f.custody.outcome(FROM, env.msg_id)).toThrow();
    expect(status(f.reopen(), env)).toBe(operation === 'offer' ? undefined : 'pending');
    expect(f.storage.database.prepare('SELECT count(*) AS count FROM custody_test_commit_fault').get()?.count).toBe(0);
  });

  it('reconciles an uncertain COMMIT that actually persisted, never returning stored before successful completion', () => {
    const f = fixture(), env = message();
    const db = f.storage.database, exec = db.exec.bind(db);
    const failure = Object.assign(new Error('injected post-commit I/O failure'), { errcode: 10 });
    const spy = vi.spyOn(db, 'exec').mockImplementation((sql) => {
      exec(sql);
      if (sql === 'COMMIT') throw failure;
    });
    let published = false;
    expect(() => { f.custody.offer(env, NOW); published = true; }).toThrow(failure);
    spy.mockRestore();
    expect(published).toBe(false);
    expect(f.storage.state).toBe('faulted');
    expect(status(f.reopen(), env)).toBe('pending');
    expect(f.custody.offer(env, NOW)).toBe('stored');
    expect(usage(f.storage)?.entries).toBe(1);
  });

  it.each([10, 13])('propagates SQLite I/O/FULL (%i) instead of translating it into a domain result', (errcode) => {
    const f = fixture(), env = message();
    const db = f.storage.database, exec = db.exec.bind(db);
    const failure = Object.assign(new Error('injected SQLite failure'), { errcode });
    const spy = vi.spyOn(db, 'exec').mockImplementation((sql) => {
      if (sql === 'BEGIN IMMEDIATE') throw failure;
      exec(sql);
    });
    expect(() => f.custody.offer(env, NOW)).toThrow(failure);
    spy.mockRestore();
    expect(f.storage.state).toBe('faulted');
    for (const call of [() => f.custody.offer(env, NOW), () => f.custody.pending(TO, NOW, 1),
      () => receipt(f.custody, env), () => f.custody.outcome(FROM, env.msg_id)]) expect(call).toThrow();
    expect(status(f.reopen(), env)).toBeUndefined();
    expect(f.custody.offer(env, NOW)).toBe('stored');
    f.storage.close();
    expect(() => f.custody.pending(TO, NOW, 1)).toThrow();
  });

  it.each(['digest', 'payload', 'schema', 'recipient', 'expiry', 'json'] as const)('rejects persisted corruption on load and does not forward it: %s', (kind) => {
    const f = fixture(), env = message();
    expect(f.custody.offer(env, NOW)).toBe('stored');
    f.storage.transaction((db) => {
      if (kind === 'digest') db.prepare('UPDATE gateway_custody SET digest = ?').run('0'.repeat(64));
      else if (kind === 'recipient') db.prepare('UPDATE gateway_custody SET to_node = ?').run(OTHER);
      else if (kind === 'expiry') db.prepare('UPDATE gateway_custody SET expires_at = expires_at + 1').run();
      else {
        const changed = kind === 'schema' ? { ...env, v: 2 } : { ...env, body: { changed: true } };
        const payload = kind === 'json' ? '{' : jcs(changed);
        db.prepare('UPDATE gateway_custody SET payload = ?, payload_bytes = ?, digest = ?')
          .run(payload, Buffer.byteLength(payload), kind === 'schema' ? envelopeDigest(changed) : envelopeDigest(env));
      }
    });
    expect(() => f.custody.pending(kind === 'recipient' ? OTHER : TO, NOW, 10))
      .toThrow(expect.objectContaining({ code: 'DATABASE_CORRUPT' }));
    expect(f.storage.state).toBe('faulted');
    expect(() => f.reopen()).toThrow(expect.objectContaining({ code: 'DATABASE_CORRUPT' }));
  });

  it.each(['expiry', 'duplicate', 'receipt', 'outcome'] as const)('does not conceal corrupt payloads through %s', (operation) => {
    const f = fixture(), env = message();
    expect(f.custody.offer(env, NOW)).toBe('stored');
    f.storage.transaction((db) => db.prepare('UPDATE gateway_custody SET digest = ?').run('0'.repeat(64)));
    expect(() => {
      if (operation === 'expiry') f.custody.pending(TO, NOW + 1_000, 0);
      else if (operation === 'duplicate') f.custody.offer(env, NOW);
      else if (operation === 'receipt') receipt(f.custody, env);
      else f.custody.outcome(FROM, env.msg_id);
    }).toThrow(expect.objectContaining({ code: 'DATABASE_CORRUPT' }));
    expect(() => f.reopen()).toThrow(expect.objectContaining({ code: 'DATABASE_CORRUPT' }));
  });

  it('validates terminal metadata on reopen even though terminal payloads are absent', () => {
    const f = fixture(), env = message();
    expect(f.custody.offer(env, NOW)).toBe('stored');
    expect(receipt(f.custody, env)).toBe(true);
    f.storage.transaction((db) => db.prepare('UPDATE gateway_custody SET to_node = ?').run('x'.repeat(36)));
    expect(() => f.reopen()).toThrow(expect.objectContaining({ code: 'DATABASE_CORRUPT' }));
  });
});