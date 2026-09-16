import type { DatabaseSync } from 'node:sqlite';
import type { SqliteStore } from '../../storage/src/index.js';
import type { SessionRecord, UserRecord, UserRole } from './auth.js';

/** Compose with REGISTRY_SQL in the center migration, never execute during auth reads. */
export const AUTH_SQL = `
CREATE TABLE auth_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  initialized INTEGER NOT NULL CHECK (initialized IN (0, 1)),
  user_count INTEGER NOT NULL CHECK (user_count >= 0),
  session_count INTEGER NOT NULL CHECK (session_count >= 0)
) STRICT;
CREATE TABLE auth_users (
  username TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('global_owner', 'user')),
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE auth_sessions (
  session_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL REFERENCES auth_users(username),
  role TEXT NOT NULL CHECK (role IN ('global_owner', 'user')),
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0)
) STRICT;
INSERT INTO auth_meta (id, initialized, user_count, session_count) VALUES (1, 0, 0, 0);
`;

export function isUserRole(value: unknown): value is UserRole {
  return value === 'global_owner' || value === 'user';
}

/** Legacy files alone may infer the role of a single pre-role administrator. */
export function parseUserRecord(value: unknown, allowLegacyOwner: boolean): UserRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const u = value as Record<string, unknown>;
  if (typeof u.username !== 'string' || u.username.length < 3
    || typeof u.salt !== 'string' || !/^[a-f0-9]{32}$/i.test(u.salt)
    || typeof u.hash !== 'string' || !/^[a-f0-9]{128}$/i.test(u.hash)
    || typeof u.created_at !== 'string' || !Number.isFinite(Date.parse(u.created_at))) return undefined;
  const role = allowLegacyOwner && !Object.prototype.hasOwnProperty.call(u, 'role') ? 'global_owner' : u.role;
  if (!isUserRole(role)) return undefined;
  return { username: u.username, role, salt: u.salt, hash: u.hash, created_at: u.created_at };
}

interface AuthSnapshot {
  initialized: boolean;
  users: Map<string, UserRecord>;
  sessions: Map<string, SessionRecord>;
}

const columns = {
  auth_meta: ['id', 'initialized', 'user_count', 'session_count'],
  auth_users: ['username', 'role', 'salt', 'hash', 'created_at'],
  auth_sessions: ['session_hash', 'username', 'role', 'csrf', 'expires_at'],
} as const;

function invalid(): never {
  throw new Error('Invalid or unavailable auth storage');
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hex(value: unknown, length: number): value is string {
  return typeof value === 'string' && value.length === length && /^[a-f0-9]+$/.test(value);
}

/** No joins that could hide orphan rows, permissive partial loads, or read-time repair. */
function rows(db: DatabaseSync, table: keyof typeof columns): Record<string, unknown>[] {
  const expected: readonly string[] = columns[table];
  // Validate even empty tables; SELECT * below also exposes unexpected stored columns.
  const actual = db.prepare(`PRAGMA table_info(${table})`).all();
  if (actual.length !== expected.length || actual.some((column, i) => column.name !== expected[i])) invalid();
  const result = db.prepare(`SELECT * FROM ${table}`).all();
  for (const row of result) {
    if (Object.keys(row).length !== expected.length || expected.some((key) => !Object.hasOwn(row, key))) invalid();
  }
  return result;
}

function readSnapshot(db: DatabaseSync): AuthSnapshot {
  const markers = rows(db, 'auth_meta');
  const marker = markers[0];
  if (markers.length !== 1 || !marker || marker.id !== 1
    || (marker.initialized !== 0 && marker.initialized !== 1)
    || !count(marker.user_count) || !count(marker.session_count)) invalid();
  const userRows = rows(db, 'auth_users');
  const sessionRows = rows(db, 'auth_sessions');
  if (userRows.length !== marker.user_count || sessionRows.length !== marker.session_count
    || (marker.initialized === 0 && (userRows.length !== 0 || sessionRows.length !== 0))
    || (marker.initialized === 1 && userRows.length === 0)) invalid();
  const users = new Map<string, UserRecord>();
  for (const row of userRows) {
    const user = parseUserRecord(row, false);
    if (!user || users.has(user.username)
      || new Date(user.created_at).toISOString() !== user.created_at) invalid();
    users.set(user.username, user);
  }
  const sessions = new Map<string, SessionRecord>();
  for (const row of sessionRows) {
    if (!hex(row.session_hash, 64) || sessions.has(row.session_hash)
      || typeof row.username !== 'string' || !users.has(row.username)
      || !isUserRole(row.role) || !hex(row.csrf, 48) || !count(row.expires_at)) invalid();
    sessions.set(row.session_hash, {
      username: row.username, role: row.role, csrf: row.csrf, expiresAt: row.expires_at,
    });
  }
  return { initialized: marker.initialized === 1, users, sessions };
}

/** Borrowed connection only: the server owns open/migrate/close for its entire lifecycle. */
export class AuthStore {
  constructor(private readonly storage: SqliteStore) {}

  private access<T>(operation: () => T): T {
    try {
      return operation();
    } catch {
      // SQLite errors (including trigger messages) must not escape with credential values.
      return invalid();
    }
  }

  /** Fresh detached objects; no public Map or returned record is an authority/cache. */
  snapshot(): AuthSnapshot {
    return this.access(() => readSnapshot(this.storage.database));
  }

  /** False means another caller already initialized; all other failures are fail-closed. */
  register(user: UserRecord): boolean {
    return this.access(() => this.storage.transaction((db) => {
      if (readSnapshot(db).initialized) return false;
      if (user.role !== 'global_owner') invalid();
      db.prepare('INSERT INTO auth_users (username, role, salt, hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(user.username, user.role, user.salt, user.hash, user.created_at);
      const result = db.prepare('UPDATE auth_meta SET initialized = 1, user_count = 1 WHERE id = 1 AND initialized = 0').run();
      if (result.changes !== 1) invalid();
      const staged = readSnapshot(db);
      if (!staged.initialized || !staged.users.has(user.username)) invalid();
      return true;
    }));
  }

  /** Only the session digest reaches SQL. CSRF is metadata, never a standalone bearer. */
  saveSession(sessionHash: string, session: SessionRecord): void {
    this.access(() => this.storage.transaction((db) => {
      const state = readSnapshot(db);
      if (!state.initialized || state.users.get(session.username)?.role !== session.role) invalid();
      db.prepare('INSERT INTO auth_sessions (session_hash, username, role, csrf, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(sessionHash, session.username, session.role, session.csrf, session.expiresAt);
      if (db.prepare('UPDATE auth_meta SET session_count = session_count + 1 WHERE id = 1').run().changes !== 1) invalid();
      readSnapshot(db);
    }));
  }

  deleteSession(sessionHash: string): void {
    this.access(() => this.storage.transaction((db) => {
      const state = readSnapshot(db);
      if (!state.sessions.has(sessionHash)) return;
      if (db.prepare('DELETE FROM auth_sessions WHERE session_hash = ?').run(sessionHash).changes !== 1) invalid();
      if (db.prepare('UPDATE auth_meta SET session_count = session_count - 1 WHERE id = 1').run().changes !== 1) invalid();
      readSnapshot(db);
    }));
  }
}