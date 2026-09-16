import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { defineMigration, SqliteStore, StorageError } from '../../storage/src/index.js';
import type { SqliteStoreOptions } from '../../storage/src/index.js';
import { AuthError, AuthService, SESSION_COOKIE } from '../src/auth.js';
import type { AuthOptions } from '../src/auth.js';
import { AUTH_SQL } from '../src/auth-store.js';
import { REGISTRY_SQL } from '../src/state-store.js';

const schema = {
  id: 'qlong.auth-sqlite-test',
  migrations: [defineMigration({ version: 1, name: 'center', sql: `${REGISTRY_SQL}\n${AUTH_SQL}` })],
};
const tempBase = realpathSync(tmpdir());
const roots = new Set<string>();
const stores = new Set<SqliteStore>();
const username = 'sqlite-test-owner';
// Synthetic, fixed test input constructed here; never read developer credentials.
const password = ['sqlite', 'fixture', 'password', 'only'].join('-');
const unavailableMessage = '认证存储不可用,拒绝认证与初始化';

function fixture(authOptions: Pick<AuthOptions, 'now' | 'sessionTtlMs'> = {}) {
  const root = mkdtempSync(join(tempBase, 'qlong-auth-sqlite-'));
  roots.add(root);
  const options: SqliteStoreOptions = {
    allowedBase: root, dataDir: join(root, 'data'), mode: 'create', schema,
    localFilesystemConfirmed: true, windowsAclConfirmed: true, busyTimeoutMs: 25,
  };
  const open = (mode: 'create' | 'open') => {
    const storage = SqliteStore.open({ ...options, mode });
    stores.add(storage);
    return storage;
  };
  let storage = open('create');
  const createAuth = () => new AuthService({ now: () => 1_000_000, ...authOptions, storage });
  let auth = createAuth();
  return {
    get storage() { return storage; },
    get auth() { return auth; },
    reopen() {
      storage.close();
      storage = open('open');
      auth = createAuth();
      return auth;
    },
  };
}

afterEach(() => {
  for (const storage of [...stores].reverse()) storage.close();
  stores.clear();
  for (const root of roots) {
    if (dirname(root) !== tempBase || !basename(root).startsWith('qlong-auth-sqlite-')) {
      throw new Error('Unsafe auth fixture cleanup target');
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  roots.clear();
});

/** Even failed assertions must not dump tokens, password hashes, cookies or SQL errors. */
function rejects(operation: () => unknown, status: number | 'recovery' = 503, message = unavailableMessage): void {
  let safeFailure = false;
  try { operation(); }
  catch (error) {
    safeFailure = (error instanceof AuthError && error.httpStatus === (status === 'recovery' ? 503 : status)
      && error.message === message && !Object.hasOwn(error, 'cause'))
      // SQLite quick_check can reject damaged CHECK constraints before AuthService is built.
      || (status === 'recovery' && error instanceof StorageError && error.code === 'DATABASE_CORRUPT');
  }
  expect(safeFailure).toBe(true);
}

function seed(auth: AuthService) {
  auth.register(username, password);
  return auth.login(username, password);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function injectFailure(storage: SqliteStore, phase: 'statement' | 'commit'): void {
  storage.transaction((db) => {
    if (phase === 'statement') {
      // AFTER the row writes and marker update, so the whole operation must roll back.
      db.exec(`CREATE TRIGGER auth_test_failure AFTER UPDATE ON auth_meta
        BEGIN SELECT RAISE(ABORT, 'injected auth write failure'); END`);
    } else {
      db.exec(`CREATE TABLE auth_test_commit_fault (
        username TEXT REFERENCES auth_users(username) DEFERRABLE INITIALLY DEFERRED
      ) STRICT;
      CREATE TRIGGER auth_test_failure AFTER UPDATE ON auth_meta
        BEGIN INSERT INTO auth_test_commit_fault VALUES ('missing-test-user'); END;`);
    }
  });
}

describe('AuthService shared SQLite durability', () => {
  it('commits bootstrap and login, reopens session/CSRF, and keeps logout revoked across reopen', () => {
    const f = fixture();
    expect(f.auth.needsInit).toBe(true);
    expect(f.auth.users.size).toBe(0);
    const login = seed(f.auth);
    expect(f.storage.database.isTransaction).toBe(false);
    expect(f.storage.database.prepare('SELECT initialized FROM auth_meta').get()?.initialized).toBe(1);
    expect(f.auth.users.get(username)?.role).toBe('global_owner');
    expect(existsSync(join(f.storage.dataDir, 'users.json'))).toBe(false);
    expect(existsSync(join(f.storage.dataDir, 'initialized'))).toBe(false);

    const restored = f.reopen();
    expect(restored.needsInit).toBe(false);
    const session = restored.sessionFromCookie(`${SESSION_COOKIE}=${login.sessionId}`);
    expect(session?.role).toBe('global_owner');
    expect(session?.csrf === login.csrf).toBe(true);
    expect(session?.expiresAt).toBe(1_000_000 + 7 * 24 * 3_600_000);
    rejects(() => restored.register('another-test-owner', password), 403, '已初始化:注册已关闭,请登录');
    rejects(() => restored.login(username, password + '-wrong'), 401, '用户名或密码错误');
    restored.logout(login.sessionId);
    expect(f.storage.database.prepare('SELECT count(*) AS count FROM auth_sessions').get()?.count).toBe(0);
    expect(f.storage.database.prepare('SELECT session_count FROM auth_meta').get()?.session_count).toBe(0);
    expect(f.reopen().session(login.sessionId) === undefined).toBe(true);
    f.auth.logout(login.sessionId); // Idempotent committed revocation.
    expect(f.auth.login(username, password).username === username).toBe(true);
    expect(f.storage.state).toBe('open'); // Auth never owns/closes the shared connection.
  });

  it('stores only the session digest, never the raw bearer/cookie or plaintext password', () => {
    const f = fixture();
    const login = seed(f.auth);
    const key = digest(login.sessionId);
    const row = f.storage.database.prepare('SELECT session_hash FROM auth_sessions').get();
    expect(row?.session_hash === key).toBe(true);
    expect(f.auth.sessions.has(login.sessionId)).toBe(false);
    expect(f.auth.sessions.has(key)).toBe(true);
    expect(f.auth.session(key) === undefined).toBe(true);
    const stored = JSON.stringify({
      users: f.storage.database.prepare('SELECT * FROM auth_users').all(),
      sessions: f.storage.database.prepare('SELECT * FROM auth_sessions').all(),
      meta: f.storage.database.prepare('SELECT * FROM auth_meta').all(),
    });
    for (const forbidden of [login.sessionId, `${SESSION_COOKIE}=${login.sessionId}`, password]) {
      expect(stored.includes(forbidden)).toBe(false);
    }
  });

  it('commits expiry deletion at the boundary and does not resurrect it if time moves back', () => {
    let now = 1_000_000;
    const f = fixture({ now: () => now, sessionTtlMs: 10 });
    const login = seed(f.auth);
    now += 9;
    expect(f.reopen().session(login.sessionId) !== undefined).toBe(true);
    now++;
    expect(f.auth.session(login.sessionId) === undefined).toBe(true);
    expect(f.storage.database.prepare('SELECT count(*) AS count FROM auth_sessions').get()?.count).toBe(0);
    now -= 10;
    expect(f.reopen().session(login.sessionId) === undefined).toBe(true);
  });

  it('uses current SQL roles and ignores mutated public Maps and returned records', () => {
    const f = fixture();
    const login = seed(f.auth);
    f.storage.transaction((db) => db.prepare('UPDATE auth_users SET role = ? WHERE username = ?').run('user', username));
    const users = f.auth.users;
    const sessions = f.auth.sessions;
    users.get(username)!.role = 'global_owner';
    users.get(username)!.hash = 'invalid';
    users.clear();
    sessions.get(digest(login.sessionId))!.expiresAt = 0;
    sessions.clear();
    const fakeSession = Buffer.alloc(32, 7).toString('hex');
    sessions.set(digest(fakeSession), { username, role: 'global_owner', csrf: login.csrf, expiresAt: 9_000_000 });
    expect(f.auth.session(fakeSession) === undefined).toBe(true);
    expect(f.auth.session(login.sessionId)?.role).toBe('user');
    const returned = f.auth.session(login.sessionId)!;
    returned.role = 'global_owner';
    returned.csrf = 'not-the-stored-csrf';
    expect(f.auth.session(login.sessionId)?.role).toBe('user');
    expect(f.auth.session(login.sessionId)?.csrf === login.csrf).toBe(true);
    expect(f.auth.login(username, password).username === username).toBe(true);
    expect(f.auth.needsInit).toBe(false);
    rejects(() => f.auth.register('another-test-owner', password), 403, '已初始化:注册已关闭,请登录');
    expect(f.reopen().session(login.sessionId)?.role).toBe('user');
  });

  it('two auth instances borrowing the same store observe one committed initialization', () => {
    const f = fixture();
    const second = new AuthService({ storage: f.storage });
    const detached = second.users;
    f.auth.register(username, password);
    expect(detached.size).toBe(0);
    expect(second.needsInit).toBe(false);
    expect(second.users.size).toBe(1);
    rejects(() => second.register('another-test-owner', password), 403, '已初始化:注册已关闭,请登录');
    expect(f.storage.database.prepare('SELECT user_count FROM auth_meta').get()?.user_count).toBe(1);
  });

  it('requires explicit file migration and neither imports nor overwrites legacy JSON', () => {
    const f = fixture();
    for (const persistDir of ['', f.storage.dataDir]) {
      rejects(() => new AuthService({ storage: f.storage, persistDir }), 503, '认证存储选项冲突,需要显式迁移');
    }
    const file = join(f.storage.dataDir, 'users.json');
    const marker = join(f.storage.dataDir, 'initialized');
    const contents = 'deliberately invalid legacy test data';
    writeFileSync(file, contents, { mode: 0o600 });
    writeFileSync(marker, contents, { mode: 0o600 });
    const auth = new AuthService({ storage: f.storage });
    expect(auth.needsInit).toBe(true);
    auth.register(username, password);
    expect(readFileSync(file, 'utf8') === contents).toBe(true);
    expect(readFileSync(marker, 'utf8') === contents).toBe(true);
  });

  it.each(['statement', 'commit'] as const)('publishes no user/init on failed register (%s)', (phase) => {
    const f = fixture();
    const beforeUsers = f.auth.users;
    const beforeSessions = f.auth.sessions;
    injectFailure(f.storage, phase);
    rejects(() => f.auth.register(username, password));
    expect(beforeUsers.size).toBe(0);
    expect(beforeSessions.size).toBe(0);
    expect(f.auth.needsInit).toBe(false);
    rejects(() => f.auth.register(username, password));
    rejects(() => f.auth.login(username, password));
    expect(f.storage.state).toBe(phase === 'commit' ? 'faulted' : 'open');
    const recovered = f.reopen();
    expect(recovered.users.size).toBe(0);
    expect(recovered.sessions.size).toBe(0);
    expect(recovered.needsInit).toBe(true); // Explicit false marker survived rollback, not rebuilt.
    expect(f.storage.database.prepare('SELECT initialized FROM auth_meta').get()?.initialized).toBe(0);
    f.storage.transaction((db) => db.exec('DROP TRIGGER auth_test_failure'));
    recovered.register(username, password);
    expect(recovered.needsInit).toBe(false);
  });

  it.each(['statement', 'commit'] as const)('returns no login/session on failed persistence (%s)', (phase) => {
    const f = fixture();
    f.auth.register(username, password);
    const before = f.auth.sessions;
    injectFailure(f.storage, phase);
    let returned = false;
    rejects(() => { f.auth.login(username, password); returned = true; });
    expect(returned).toBe(false);
    expect(before.size).toBe(0);
    expect(f.auth.needsInit).toBe(false);
    expect(f.reopen().sessions.size).toBe(0);
    expect(f.auth.users.size).toBe(1);
    expect(f.storage.database.prepare('SELECT session_count FROM auth_meta').get()?.session_count).toBe(0);
  });

  it.each([
    ['logout', 'statement'], ['logout', 'commit'], ['expiry', 'statement'], ['expiry', 'commit'],
  ] as const)('never acknowledges failed %s deletion (%s)', (operation, phase) => {
    let now = 1_000_000;
    const f = fixture({ now: () => now, sessionTtlMs: 10 });
    const login = seed(f.auth);
    injectFailure(f.storage, phase);
    if (operation === 'expiry') now += 10;
    rejects(() => operation === 'expiry' ? f.auth.session(login.sessionId) : f.auth.logout(login.sessionId));
    rejects(() => f.auth.session(login.sessionId));
    expect(f.auth.needsInit).toBe(false);
    now = 1_000_000;
    expect(f.reopen().session(login.sessionId) !== undefined).toBe(true); // Failed deletion rolled back.
    expect(f.storage.database.prepare('SELECT session_count FROM auth_meta').get()?.session_count).toBe(1);
    f.storage.transaction((db) => db.exec('DROP TRIGGER auth_test_failure'));
    f.auth.logout(login.sessionId);
    expect(f.reopen().session(login.sessionId) === undefined).toBe(true);
  });

  it.each(['closed', 'faulted'] as const)('fails closed on every auth surface with %s storage', (state) => {
    const f = fixture();
    const login = seed(f.auth);
    if (state === 'closed') f.storage.close();
    else {
      injectFailure(f.storage, 'commit');
      rejects(() => f.auth.logout(login.sessionId));
    }
    expect(f.storage.state).toBe(state);
    expect(f.auth.needsInit).toBe(false);
    for (const operation of [
      () => f.auth.users, () => f.auth.sessions, () => f.auth.register(username, password),
      () => f.auth.login(username, password), () => f.auth.logout(login.sessionId),
      () => f.auth.session(login.sessionId), () => f.auth.sessionFromCookie(undefined),
      () => new AuthService({ storage: f.storage }),
    ]) rejects(operation);
  });

  it('never recreates a missing marker, even on an empty migrated database', () => {
    const f = fixture();
    f.storage.transaction((db) => db.exec('DELETE FROM auth_meta'));
    expect(f.auth.needsInit).toBe(false);
    rejects(() => f.auth.register(username, password));
    rejects(() => new AuthService({ storage: f.storage }));
    rejects(() => f.reopen());
    expect(f.storage.database.prepare('SELECT count(*) AS count FROM auth_meta').get()?.count).toBe(0);
    expect(f.storage.database.prepare('SELECT count(*) AS count FROM auth_users').get()?.count).toBe(0);
  });

  it.each([
    'DELETE FROM auth_meta',
    'UPDATE auth_meta SET initialized = 0',
    'UPDATE auth_meta SET initialized = 2',
    'UPDATE auth_meta SET id = 2',
    'UPDATE auth_meta SET user_count = user_count + 1',
    'UPDATE auth_meta SET session_count = session_count + 1',
    'DELETE FROM auth_sessions',
    'DELETE FROM auth_sessions; DELETE FROM auth_users; UPDATE auth_meta SET user_count = 0, session_count = 0',
    "UPDATE auth_users SET salt = 'invalid'",
    "UPDATE auth_users SET hash = 'invalid'",
    "UPDATE auth_users SET created_at = 'invalid'",
    "UPDATE auth_users SET created_at = '2020-01-01'",
    "UPDATE auth_users SET role = 'unknown'",
    "UPDATE auth_sessions SET role = 'unknown'",
    "UPDATE auth_sessions SET csrf = 'invalid'",
    "UPDATE auth_sessions SET session_hash = 'invalid'",
    'UPDATE auth_sessions SET expires_at = -1',
    'UPDATE auth_sessions SET expires_at = 9007199254740992',
    'ALTER TABLE auth_users ADD COLUMN unexpected TEXT',
    'DROP TABLE auth_sessions',
    `ALTER TABLE auth_meta RENAME TO auth_meta_saved;
      CREATE TABLE auth_meta AS SELECT * FROM auth_meta_saved;
      INSERT INTO auth_meta SELECT * FROM auth_meta_saved; DROP TABLE auth_meta_saved`,
    `ALTER TABLE auth_sessions RENAME TO auth_sessions_saved;
      CREATE TABLE auth_sessions AS SELECT session_hash, 'missing-test-user' AS username, role, csrf, expires_at FROM auth_sessions_saved;
      DROP TABLE auth_sessions_saved`,
    `ALTER TABLE auth_sessions RENAME TO auth_sessions_saved;
      CREATE TABLE auth_sessions AS SELECT * FROM auth_sessions_saved;
      INSERT INTO auth_sessions SELECT * FROM auth_sessions_saved; DROP TABLE auth_sessions_saved;
      UPDATE auth_meta SET session_count = 2`,
    `ALTER TABLE auth_sessions RENAME TO auth_sessions_saved;
      CREATE TABLE auth_sessions AS SELECT session_hash, username, NULL AS role, csrf, expires_at FROM auth_sessions_saved;
      DROP TABLE auth_sessions_saved`,
  ])('rejects corrupt shapes, markers, counts and associations before bootstrap/auth (%#)', (sql) => {
    const f = fixture();
    const login = seed(f.auth);
    // Deliberate corruption confined to our temp fixture; restore constraint checks immediately.
    f.storage.transaction((db) => {
      db.exec('PRAGMA ignore_check_constraints = ON');
      try { db.exec(sql); } finally { db.exec('PRAGMA ignore_check_constraints = OFF'); }
    });
    expect(f.auth.needsInit).toBe(false);
    rejects(() => f.auth.session(login.sessionId));
    rejects(() => f.auth.register(username, password));
    rejects(() => new AuthService({ storage: f.storage }));
    rejects(() => f.reopen(), 'recovery');
  });
});