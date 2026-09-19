import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  envelopeDigest, newId, newKeyPair, signEnvelope, toBase64, type EnvelopeV1,
} from '@qlong/core';
import { SqliteStore, type SqliteStoreOptions } from '../../storage/src/index.js';
import { CENTER_SCHEMA } from '../../registry/src/schema.js';
import { inspectSql, failCommit } from './server-custody-helpers.js';
import { importMigration, type ImportTarget } from '../src/migrate/import.js';
import type { MigrationSources } from '../src/migrate/inspect.js';

/**
 * F1/P2 slice2 (s2c):qlong migrate import——事务化导入(DATA-MIGRATION.md §5 slice2)。
 * 铁律核验:单事务(users+auth_meta+mailbox custody+ledger)、幂等(同来源摘要重跑无副作用)、
 * 冲突拒绝回滚(同 PK 异体 → 抛出且目标库零变更)、fail-closed(COMMIT 失败 → 回滚不破坏原库)、
 * mailbox 四不(不延 exp:expires_at === 原 exp;缺 pubkey → blocked 不导入)。
 * 目标库真实 SqliteStore.open(CENTER_SCHEMA);COMMIT 失败用 server-custody-helpers.failCommit 触发。
 */
const NOW = Date.parse('2026-09-19T12:00:00.000Z');
const ISO = new Date(NOW).toISOString();
const SALT = 'a'.repeat(32);
const HASH = 'b'.repeat(128);
const tempBase = realpathSync(tmpdir());
const roots = new Set<string>();
const stores = new Set<SqliteStore>();

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tempBase, prefix));
  roots.add(root);
  return root;
}

function openTarget(options: SqliteStoreOptions): SqliteStore {
  const store = SqliteStore.open(options);
  stores.add(store);
  return store;
}

interface Center { target: ImportTarget; path: string; nodeId: string; teamId: string; priv: ReturnType<typeof newKeyPair>['priv'] }

/** Build a real center.sqlite (CENTER_SCHEMA v5) with one active enrolled node for mailbox verification. */
function buildCenter(mode: 'create' | 'open' = 'create'): Center {
  const root = tempRoot('qlong-import-');
  const dataDir = join(root, 'center');
  const filename = 'center.sqlite';
  const path = join(dataDir, filename);
  const target: ImportTarget = {
    allowedBase: root, dataDir, filename, mode: 'open',
    localFilesystemConfirmed: true, windowsAclConfirmed: true, busyTimeoutMs: 25,
  };
  const pair = newKeyPair();
  const nodeId = newId();
  const teamId = newId();
  const pubkey = toBase64(pair.publicKey);
  const store = openTarget({
    allowedBase: root, dataDir, filename, mode, schema: CENTER_SCHEMA,
    localFilesystemConfirmed: true, windowsAclConfirmed: true, busyTimeoutMs: 25,
  });
  store.transaction((db) => {
    db.prepare('INSERT INTO registry_teams (id, record) VALUES (?, ?)')
      .run(teamId, JSON.stringify({ team_id: teamId, name: 'legacy-team', owner_user_id: 'alice' }));
    db.prepare('INSERT INTO registry_nodes (id, team_id, token_hash, record) VALUES (?, ?, ?, ?)')
      .run(nodeId, teamId, 'h'.repeat(64), JSON.stringify({
        node_id: nodeId, team_id: teamId, status: 'active', keys: [{ epoch: 1, pubkey }],
      }));
  });
  store.close();
  stores.delete(store);
  return { target, path, nodeId, teamId, priv: pair.priv };
}

function offerFrom(center: Center, overrides: Partial<EnvelopeV1> = {}, exp = NOW + 60_000): EnvelopeV1 {
  return signEnvelope({
    v: 1, type: 'task.offer', msg_id: newId(), task_id: newId(), attempt: 1, hops: 0,
    ts: ISO, exp: new Date(exp).toISOString(),
    from: { node_id: center.nodeId, key_epoch: 1 }, to: { node_id: center.nodeId },
    trace: { trace_id: newId(), parent_span: null, origin_node: center.nodeId },
    body: { kind: 'project', summary: 'legacy mailbox offer' }, ...overrides,
  }, center.priv);
}

function mailboxFile(path: string, entries: Array<{ env: EnvelopeV1; box: string }>): void {
  const boxes = new Map<string, unknown[]>();
  for (const { env, box } of entries) {
    const list = boxes.get(box) ?? [];
    list.push({ msgId: env.msg_id, envelope: env, enqueuedAt: NOW });
    boxes.set(box, list);
  }
  writeFileSync(path, JSON.stringify({
    v: 1, savedAt: NOW, boxes: [...boxes].map(([nodeId, e]) => ({ nodeId, entries: e })),
  }));
}

function usersFile(path: string, users: unknown[]): void {
  writeFileSync(path, JSON.stringify(users));
}

function readState(path: string) {
  return inspectSql(path, (db) => ({
    users: db.prepare('SELECT username, role, created_at FROM auth_users ORDER BY username').all()
      .map((r) => ({ username: String(r.username), role: String(r.role), created_at: String(r.created_at) })),
    meta: db.prepare('SELECT initialized, user_count FROM auth_meta WHERE id = 1').get() as { initialized: number; user_count: number },
    custody: db.prepare('SELECT from_node, msg_id, status, stored_at, expires_at, digest FROM gateway_custody ORDER BY rowid').all()
      .map((r) => ({ status: String(r.status), stored_at: Number(r.stored_at), expires_at: Number(r.expires_at), digest: String(r.digest) })),
    ledger: db.prepare('SELECT kind, source_sha256, migratable, blocked, non_migratable, invalid FROM import_ledger ORDER BY kind').all()
      .map((r) => ({ kind: String(r.kind), migratable: Number(r.migratable), blocked: Number(r.blocked) })),
  }));
}

function sources(center: Center, opts: { users?: unknown[]; mailbox?: Array<{ env: EnvelopeV1; box: string }>; marker?: boolean }): MigrationSources {
  const authDir = tempRoot('qlong-auth-');
  const out: MigrationSources = {};
  if (opts.users) {
    const p = join(authDir, 'users.json');
    usersFile(p, opts.users);
    out.usersJson = { path: p, bytes: new Uint8Array(readFileSync(p)) };
  }
  if (opts.marker) {
    const p = join(authDir, 'initialized');
    writeFileSync(p, 'initialized-v1\n');
    out.initializedMarker = { path: p, bytes: new Uint8Array(readFileSync(p)) };
  }
  if (opts.mailbox) {
    const p = join(authDir, 'mailbox.json');
    mailboxFile(p, opts.mailbox);
    out.mailbox = { path: p, bytes: new Uint8Array(readFileSync(p)) };
  }
  return out;
}

afterEach(() => {
  for (const store of [...stores].reverse()) store.close();
  stores.clear();
  for (const root of roots) {
    if (dirname(root) !== tempBase || !(basename(root).startsWith('qlong-import-') || basename(root).startsWith('qlong-auth-'))) {
      throw new Error('Unsafe import test cleanup target');
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  roots.clear();
});

describe('importMigration (F1/P2 slice2: transactional import)', () => {
  it('imports users + mailbox in ONE transaction, never extending expiry, and records the ledger', async () => {
    const c = buildCenter();
    const env = offerFrom(c);
    const src = sources(c, {
      users: [{ username: 'alice', role: 'global_owner', salt: SALT, hash: HASH, created_at: ISO }],
      marker: true,
      mailbox: [{ env, box: c.nodeId }],
    });
    const report = await importMigration(src, { now: NOW, target: c.target });
    expect(report.idempotent).toBe(false);
    const state = readState(c.path);
    expect(state.users).toEqual([{ username: 'alice', role: 'global_owner', created_at: ISO }]);
    expect(state.meta).toEqual({ initialized: 1, user_count: 1 });
    expect(state.custody).toHaveLength(1);
    // mailbox 四不:stored_at = import now;expires_at === 原 exp(NOW+60s),绝不延长。
    expect(state.custody[0]).toMatchObject({ status: 'pending', stored_at: NOW, expires_at: NOW + 60_000, digest: envelopeDigest(env) });
    // ledger 记录 users + mailbox 两来源(各 migratable=1)。
    expect(state.ledger).toContainEqual({ kind: 'users', migratable: 1, blocked: 0 });
    expect(state.ledger).toContainEqual({ kind: 'mailbox', migratable: 1, blocked: 0 });
  });

  it('is idempotent: re-running with the same sources makes no change (ledger short-circuit)', async () => {
    const c = buildCenter();
    const env = offerFrom(c);
    const src = sources(c, {
      users: [{ username: 'alice', role: 'global_owner', salt: SALT, hash: HASH, created_at: ISO }],
      mailbox: [{ env, box: c.nodeId }],
    });
    await importMigration(src, { now: NOW, target: c.target });
    const first = readState(c.path);
    const again = await importMigration(src, { now: NOW, target: c.target });
    expect(again.idempotent).toBe(true);
    const second = readState(c.path);
    expect(second).toEqual(first); // no duplicate users/custody/ledger rows
    expect(second.ledger).toHaveLength(first.ledger.length);
  });

  it('rejects a content conflict (same username, different credentials) and rolls back with zero changes', async () => {
    const c = buildCenter();
    // Seed the target with alice under DIFFERENT credentials → source alice is a conflict.
    const seed = openTarget({ ...c.target, schema: CENTER_SCHEMA, mode: 'open' });
    seed.transaction((db) => {
      db.prepare('INSERT INTO auth_users (username, role, salt, hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('alice', 'global_owner', 'c'.repeat(32), 'd'.repeat(128), ISO);
      db.prepare('UPDATE auth_meta SET initialized = 1, user_count = 1 WHERE id = 1').run();
    });
    seed.close();
    stores.delete(seed);
    const before = readState(c.path);
    const src = sources(c, { users: [{ username: 'alice', role: 'global_owner', salt: SALT, hash: HASH, created_at: ISO }] });
    await expect(importMigration(src, { now: NOW, target: c.target })).rejects.toThrow(/conflict/i);
    expect(readState(c.path)).toEqual(before); // nothing written, no ledger row
  });

  it('fails closed on COMMIT failure: the whole transaction rolls back (no users, custody, or ledger)', async () => {
    const c = buildCenter();
    const env = offerFrom(c);
    // Install a commit-time FK violation on gateway_custody; the trigger is committed, then the store closes.
    const saboteur = openTarget({ ...c.target, schema: CENTER_SCHEMA, mode: 'open' });
    failCommit(saboteur, 'gateway_custody');
    saboteur.close();
    stores.delete(saboteur);
    const before = readState(c.path);
    const src = sources(c, {
      users: [{ username: 'alice', role: 'global_owner', salt: SALT, hash: HASH, created_at: ISO }],
      mailbox: [{ env, box: c.nodeId }],
    });
    await expect(importMigration(src, { now: NOW, target: c.target })).rejects.toThrow();
    const after = readState(c.path);
    expect(after.users).toEqual([]);          // users rolled back too — single transaction
    expect(after.custody).toEqual([]);
    expect(after.ledger).toEqual([]);
    expect(after.meta).toEqual(before.meta);  // auth_meta untouched
  });

  it('does not import a mailbox entry whose signer pubkey is unknown (blocked, honest ledger count)', async () => {
    const c = buildCenter();
    const stranger = newKeyPair();
    const unknownNode = newId();
    const env = signEnvelope({
      v: 1, type: 'task.offer', msg_id: newId(), task_id: newId(), attempt: 1, hops: 0,
      ts: ISO, exp: new Date(NOW + 60_000).toISOString(),
      from: { node_id: unknownNode, key_epoch: 1 }, to: { node_id: c.nodeId },
      trace: { trace_id: newId(), parent_span: null, origin_node: unknownNode },
      body: { kind: 'project', summary: 'unknown signer' },
    }, stranger.priv);
    const src = sources(c, { mailbox: [{ env, box: c.nodeId }] });
    await importMigration(src, { now: NOW, target: c.target });
    const state = readState(c.path);
    expect(state.custody).toEqual([]);        // blocked → not imported
    expect(state.ledger).toContainEqual({ kind: 'mailbox', migratable: 0, blocked: 1 });
  });
});
