import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { newId } from '@qlong/core';
import { defineMigration, SqliteStore, StorageError, type SqliteStoreOptions } from '../../storage/src/index.js';
import { COMMAND_SQL, SqliteCommandStore } from '../src/command-store.js';

/**
 * E3a:SqliteCommandStore——owner 命令队列的中心侧持久存储(设计 docs/repair/OWNER-COMMAND.md §4.1)。
 * 命令是 owner→中心→牵头节点的耐久控制意图:pending 永不删(存储铁律),节点 PULL 后 ack,
 * 仅 acked 且过保留窗口才 prune;损坏 fail-closed(recovery 非静默重建);按 lead 过滤(防他节点窃取)。
 */
const NOW = Date.parse('2026-09-18T12:00:00.000Z');
const TEAM = newId();
const LEAD = newId();
const OTHER = newId();
const TASK = newId();
const stores = new Set<SqliteStore>();
const tempBase = realpathSync(tmpdir());
const roots = new Set<string>();
const schema = {
  id: 'qlong.command-test',
  migrations: [defineMigration({ version: 1, name: 'command', sql: COMMAND_SQL })],
};

function storageOptions(): SqliteStoreOptions {
  const root = mkdtempSync(join(tempBase, 'qlong-command-'));
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

function fixture() {
  const settings = storageOptions();
  let storage = open(settings);
  let commands = new SqliteCommandStore(storage);
  return {
    get storage() { return storage; },
    get commands() { return commands; },
    reopen() {
      storage.close();
      storage = open({ ...settings, mode: 'open' });
      commands = new SqliteCommandStore(storage);
      return commands;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const storage of [...stores].reverse()) storage.close();
  stores.clear();
  for (const root of roots) {
    if (dirname(root) !== tempBase || !basename(root).startsWith('qlong-command-')) {
      throw new Error('Unsafe command test cleanup target');
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  roots.clear();
});

describe('SqliteCommandStore (E3a: durable owner-command queue)', () => {
  it('enqueue persists a pending command; pendingFor returns it', () => {
    const f = fixture();
    const cmd = f.commands.enqueue({ team_id: TEAM, lead: LEAD, task_id: TASK, kind: 'cancel' }, NOW);
    expect(cmd).toMatchObject({ team_id: TEAM, lead: LEAD, task_id: TASK, kind: 'cancel', status: 'pending' });
    expect(cmd.id).toBeTruthy();
    expect(f.commands.pendingFor(LEAD, 10)).toEqual([cmd]);
  });

  it('pendingFor filters by lead: a node never sees another lead node\'s commands (防伪造)', () => {
    const f = fixture();
    f.commands.enqueue({ team_id: TEAM, lead: LEAD, task_id: TASK, kind: 'cancel' }, NOW);
    expect(f.commands.pendingFor(OTHER, 10)).toEqual([]);
    expect(f.commands.pendingFor(LEAD, 10)).toHaveLength(1);
  });

  it('pendingFor returns commands in FIFO order (created_at, id) and honours limit', () => {
    const f = fixture();
    const a = f.commands.enqueue({ team_id: TEAM, lead: LEAD, task_id: TASK, kind: 'cancel' }, NOW);
    const b = f.commands.enqueue({ team_id: TEAM, lead: LEAD, task_id: TASK, kind: 'redispatch' }, NOW + 1);
    const c = f.commands.enqueue({ team_id: TEAM, lead: LEAD, task_id: TASK, kind: 'cancel' }, NOW + 2);
    expect(f.commands.pendingFor(LEAD, 10).map((x) => x.id)).toEqual([a.id, b.id, c.id]);
    expect(f.commands.pendingFor(LEAD, 2).map((x) => x.id)).toEqual([a.id, b.id]);
  });

  it('ack marks the command acked with a timestamp and removes it from pending', () => {
    const f = fixture();
    const cmd = f.commands.enqueue({ team_id: TEAM, lead: LEAD, task_id: TASK, kind: 'cancel' }, NOW);
    expect(f.commands.ack(cmd.id, LEAD, NOW + 5)).toBe(true);
    expect(f.commands.pendingFor(LEAD, 10)).toEqual([]);
  });

  it('ack is idempotent: re-acking an already-acked command returns false', () => {
    const f = fixture();
    const cmd = f.commands.enqueue({ team_id: TEAM, lead: LEAD, task_id: TASK, kind: 'cancel' }, NOW);
    expect(f.commands.ack(cmd.id, LEAD, NOW + 5)).toBe(true);
    expect(f.commands.ack(cmd.id, LEAD, NOW + 6)).toBe(false);
  });

  it('ack is fenced by lead: a node cannot ack another lead node\'s command', () => {
    const f = fixture();
    const cmd = f.commands.enqueue({ team_id: TEAM, lead: LEAD, task_id: TASK, kind: 'cancel' }, NOW);
    expect(f.commands.ack(cmd.id, OTHER, NOW + 5)).toBe(false);
    expect(f.commands.pendingFor(LEAD, 10).map((x) => x.id)).toEqual([cmd.id]); // 仍 pending
  });

  it('ack of an unknown command id returns false', () => {
    const f = fixture();
    expect(f.commands.ack(newId(), LEAD, NOW)).toBe(false);
  });

  it('prune deletes only acked commands past the retention window; pending are NEVER deleted (存储铁律)', () => {
    const f = fixture();
    const acked = f.commands.enqueue({ team_id: TEAM, lead: LEAD, task_id: TASK, kind: 'cancel' }, NOW);
    const pending = f.commands.enqueue({ team_id: TEAM, lead: LEAD, task_id: TASK, kind: 'redispatch' }, NOW);
    f.commands.ack(acked.id, LEAD, NOW); // acked_at = NOW
    // 保留窗口 1000ms:在 NOW+1500 prune,acked(NOW) 已过窗口 → 删;pending 永不删。
    expect(f.commands.prune(NOW + 1_500, 1_000)).toBe(1);
    const remaining = f.commands.pendingFor(LEAD, 10);
    expect(remaining.map((x) => x.id)).toEqual([pending.id]);
  });

  it('prune keeps acked commands still within the retention window', () => {
    const f = fixture();
    const cmd = f.commands.enqueue({ team_id: TEAM, lead: LEAD, task_id: TASK, kind: 'cancel' }, NOW);
    f.commands.ack(cmd.id, LEAD, NOW + 100); // acked_at = NOW+100
    expect(f.commands.prune(NOW + 500, 1_000)).toBe(0); // 窗口内不删
  });

  it('survives restart: pending commands persist across reopen (durability, §1.1)', () => {
    const f = fixture();
    const cmd = f.commands.enqueue({ team_id: TEAM, lead: LEAD, task_id: TASK, kind: 'cancel' }, NOW);
    const reopened = f.reopen();
    expect(reopened.pendingFor(LEAD, 10).map((x) => x.id)).toEqual([cmd.id]);
  });

  it('rejects enqueue with a non-UUID task_id/lead or an unknown kind', () => {
    const f = fixture();
    expect(() => f.commands.enqueue({ team_id: TEAM, lead: 'nope', task_id: TASK, kind: 'cancel' }, NOW))
      .toThrow(TypeError);
    expect(() => f.commands.enqueue({ team_id: TEAM, lead: LEAD, task_id: 'nope', kind: 'cancel' }, NOW))
      .toThrow(TypeError);
    expect(() => f.commands.enqueue({ team_id: TEAM, lead: LEAD, task_id: TASK, kind: 'destroy' as 'cancel' }, NOW))
      .toThrow(TypeError);
  });

  it('faults (recovery, not silent rebuild) on a corrupt command row at construction', () => {
    const f = fixture();
    f.commands.enqueue({ team_id: TEAM, lead: LEAD, task_id: TASK, kind: 'cancel' }, NOW);
    // 损坏:created_at 取非 ISO 值(kind/status 有 SQL CHECK 护住,created_at 仅 TEXT NOT NULL)→
    // 绕过 SQL 层但违反应用层 ISO 不变量,构造校验必须 fail-closed(recovery 非静默重建)。
    f.storage.database.prepare('UPDATE registry_commands SET created_at = ?').run('bogus');
    expect(() => new SqliteCommandStore(f.storage)).toThrow(StorageError);
  });
});
