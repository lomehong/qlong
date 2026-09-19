import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId, newKeyPair, toBase64 } from '@qlong/core';
import { SqliteStore } from '../../storage/src/index.js';
import { CENTER_SCHEMA } from '../../registry/src/schema.js';
import { formatInventory, readMigrationSources, readTargetSnapshot } from '../src/migrate/read.js';
import { inspectMigration } from '../src/migrate/inspect.js';

/* slice1 IO 层 RED — qlong migrate inspect 的文件系统/只读库/格式化边界。
 * 覆盖 DATA-MIGRATION §5 slice1 IO 靶点:
 *  1) 不改源断言:readMigrationSources 后源文件 mtime/size/bytes 前后一致,且绝不写 initialized
 *     (区别于 legacy AuthService.loadUsers() 缺 marker 时的 writeExclusive 写源)。
 *  2) 只读目标库:readTargetSnapshot 用 raw DatabaseSync({readOnly:true}) 读真实 center.sqlite
 *     (绝不用 SqliteStore.open——它会 applyMigrations + 取独占锁,违反 dry-run 只读铁律)。
 *  3) 不输出凭据:formatInventory 文本绝不含 salt/hash 值。 */

const SALT = 'a'.repeat(32);
const HASH = 'b'.repeat(128);
const ISO = '2025-12-01T00:00:00.000Z';
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const EMPTY_TARGET = { path: '/absent/center.sqlite', schemaId: '', version: 0, initialized: false, users: [], custody: [], nodes: [] };

const trash: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trash.push(dir);
  return dir;
}
afterEach(() => {
  while (trash.length > 0) {
    const dir = trash.pop()!;
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* OS 回收 temp */ }
  }
});

const utf8 = (b: Uint8Array | undefined): string | undefined => (b === undefined ? undefined : Buffer.from(b).toString('utf8'));

/** 建真实 CENTER_SCHEMA v4 center.sqlite,填 auth/registry/custody 各一行,close 后只读复核。 */
function buildCenter(): { path: string; nodeId: string; teamId: string; fromNode: string; msgId: string; digest: string; pub1: string; pub2: string } {
  const root = tempDir('qlong-center-');
  const dataDir = join(root, 'center');
  const store = SqliteStore.open({
    allowedBase: root, dataDir, mode: 'create', filename: 'center.sqlite', schema: CENTER_SCHEMA,
    localFilesystemConfirmed: true, windowsAclConfirmed: true, busyTimeoutMs: 25,
  });
  const teamId = newId();
  const nodeId = newId();
  const pub1 = toBase64(newKeyPair().publicKey);
  const pub2 = toBase64(newKeyPair().publicKey);
  const fromNode = newId();
  const msgId = newId();
  const digest = 'c'.repeat(64);
  store.transaction((db) => {
    // AUTH_SQL 迁移已 seed auth_meta(id=1,initialized=0);导入语义是 UPDATE 而非 INSERT(slice2 同理)。
    db.prepare('UPDATE auth_meta SET initialized = 1, user_count = 1 WHERE id = 1').run();
    db.prepare('INSERT INTO auth_users (username, role, salt, hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('alice', 'global_owner', SALT, HASH, ISO);
    db.prepare('INSERT INTO registry_teams (id, record) VALUES (?, ?)').run(teamId, JSON.stringify({ team_id: teamId, name: 't' }));
    db.prepare('INSERT INTO registry_nodes (id, team_id, token_hash, record) VALUES (?, ?, ?, ?)').run(
      nodeId, teamId, 'd'.repeat(64),
      JSON.stringify({ node_id: nodeId, team_id: teamId, name: 'n', status: 'active', keys: [{ epoch: 1, pubkey: pub1 }, { epoch: 2, pubkey: pub2 }], tokenHash: 'd'.repeat(64) }),
    );
    const payload = JSON.stringify({ hello: 'world' });
    db.prepare(`INSERT INTO gateway_custody (from_node, msg_id, to_node, digest, status, stored_at, expires_at, payload, payload_bytes)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
      .run(fromNode, msgId, newId(), digest, NOW - 1_000, NOW + 60_000, payload, Buffer.byteLength(payload));
  });
  store.close();
  return { path: join(dataDir, 'center.sqlite'), nodeId, teamId, fromNode, msgId, digest, pub1, pub2 };
}

describe('readMigrationSources — dry-run 只读,不改源', () => {
  it('reads users.json/mailbox bytes without touching mtime/size or writing an initialized marker', () => {
    const authDir = tempDir('qlong-auth-');
    const usersPath = join(authDir, 'users.json');
    const usersBody = JSON.stringify([{ username: 'alice', role: 'global_owner', salt: SALT, hash: HASH, created_at: ISO }]);
    writeFileSync(usersPath, usersBody);
    const mailboxPath = join(authDir, 'mailbox.json');
    const mailboxBody = JSON.stringify({ v: 1, savedAt: NOW, boxes: [] });
    writeFileSync(mailboxPath, mailboxBody);
    const before = statSync(usersPath);
    const beforeBytes = readFileSync(usersPath);

    const sources = readMigrationSources({ authDir, mailboxFile: mailboxPath });

    const after = statSync(usersPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(readFileSync(usersPath).equals(beforeBytes)).toBe(true);
    // 铁律:绝不写 initialized(legacy loadUsers 缺 marker 时会 writeExclusive 写源)。
    expect(existsSync(join(authDir, 'initialized'))).toBe(false);
    expect(sources.usersJson?.path).toBe(usersPath);
    expect(utf8(sources.usersJson?.bytes)).toBe(usersBody);
    expect(sources.initializedMarker).toBeUndefined();
    expect(sources.mailbox?.path).toBe(mailboxPath);
    expect(utf8(sources.mailbox?.bytes)).toBe(mailboxBody);
  });

  it('reads the initialized marker when present and tolerates absent sources without throwing', () => {
    const authDir = tempDir('qlong-auth-');
    writeFileSync(join(authDir, 'users.json'), '[]');
    writeFileSync(join(authDir, 'initialized'), 'initialized-v1\n');

    const present = readMigrationSources({ authDir });
    expect(utf8(present.initializedMarker?.bytes)).toBe('initialized-v1\n');
    expect(present.mailbox).toBeUndefined();

    const absent = readMigrationSources({ authDir: join(authDir, 'nope'), mailboxFile: join(authDir, 'missing.json') });
    expect(absent.usersJson).toBeUndefined();
    expect(absent.initializedMarker).toBeUndefined();
    expect(absent.mailbox).toBeUndefined();
  });
});

describe('readTargetSnapshot — 只读真实 center.sqlite', () => {
  it('maps schema/version/auth/custody/registry rows from a real CENTER_SCHEMA v5 database', () => {
    const c = buildCenter();
    const snap = readTargetSnapshot(c.path);
    expect(snap.path).toBe(c.path);
    expect(snap.schemaId).toBe('qlong.center');
    expect(snap.version).toBe(5);
    expect(snap.initialized).toBe(true);
    expect(snap.users).toEqual([{ username: 'alice', role: 'global_owner', created_at: ISO, salt: SALT, hash: HASH }]);
    expect(snap.custody).toEqual([{ from_node: c.fromNode, msg_id: c.msgId, digest: c.digest }]);
    expect(snap.nodes).toEqual([{
      node_id: c.nodeId, team_id: c.teamId, status: 'active',
      keys: [{ epoch: 1, pubkey: c.pub1 }, { epoch: 2, pubkey: c.pub2 }],
    }]);
  });

  it('returns an empty snapshot for a missing target database (fresh import target)', () => {
    const snap = readTargetSnapshot(join(tempDir('qlong-mig-'), 'absent.sqlite'));
    expect(snap).toMatchObject({ schemaId: '', version: 0, initialized: false, users: [], custody: [], nodes: [] });
  });
});

describe('formatInventory — 不输出凭据', () => {
  it('renders counts, reasons and target path but never leaks salt or hash', async () => {
    const authDir = tempDir('qlong-auth-');
    writeFileSync(join(authDir, 'users.json'), JSON.stringify([{ username: 'alice', role: 'global_owner', salt: SALT, hash: HASH, created_at: ISO }]));
    const inv = await inspectMigration(readMigrationSources({ authDir }), EMPTY_TARGET, NOW);

    const text = formatInventory(inv);
    expect(text).not.toContain(SALT);
    expect(text).not.toContain(HASH);
    expect(text).toContain('alice');
    expect(text).toContain('migratable');
    expect(text).toContain('center.sqlite');
  });
});
