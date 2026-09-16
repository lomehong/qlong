import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defineMigration, migrationChecksum, SqliteStore } from '../src/index.js';
import { fixture, open, schema } from './helpers.js';

describe('SqliteStore transactions', () => {
  it('verifies WAL/FULL/foreign_keys, disables extensions, binds hostile values and returns after commit', () => {
    const options = fixture();
    const store = open(options);
    const db = store.database;
    expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA synchronous').get()).toMatchObject({ synchronous: 2 });
    expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
    expect(() => db.enableLoadExtension(true)).toThrow();
    const value = "'); DROP TABLE records; --";
    const result = store.transaction((tx) => {
      expect(tx.isTransaction).toBe(true);
      tx.prepare('INSERT INTO records VALUES (?, ?)').run('bound', value);
      return { id: 'bound', value };
    });
    expect(db.isTransaction).toBe(false);
    expect(result).toEqual({ id: 'bound', value });
    store.close();
    expect(open({ ...options, mode: 'open' }).database.prepare('SELECT * FROM records').get()).toEqual(result);
  });

  it('rolls back domain exceptions without publishing staged state; connection remains usable', () => {
    const store = open(fixture());
    let cache = 'old';
    expect(() => {
      cache = store.transaction<string>((db) => {
        db.prepare('INSERT INTO records VALUES (?, ?)').run('rolled-back', 'x');
        throw new Error('domain rejection');
      });
    }).toThrow('domain rejection');
    expect(cache).toBe('old');
    expect(store.database.prepare('SELECT * FROM records').all()).toEqual([]);
    expect(store.transaction(() => 'committed')).toBe('committed');
  });

  it('rolls back unique, NOT NULL and foreign key constraint failures atomically', () => {
    const store = open(fixture());
    for (const sql of [
      "INSERT INTO records VALUES ('one', 'duplicate')",
      "INSERT INTO records VALUES ('two', NULL)",
      "INSERT INTO children VALUES ('child', 'missing')",
    ]) {
      expect(() => store.transaction((db) => {
        db.prepare('INSERT INTO records VALUES (?, ?)').run('one', 'staged');
        db.exec(sql);
      })).toThrow();
      expect(store.state).toBe('open');
      expect(store.database.prepare('SELECT * FROM records').all()).toEqual([]);
    }
  });

  it('does not return/cache a result when COMMIT fails on a deferred constraint', () => {
    const options = fixture();
    const store = open(options);
    let cache = 'before';
    expect(() => {
      cache = store.transaction((db) => {
        db.prepare('INSERT INTO deferred_children VALUES (?, ?)').run('child', 'missing');
        return 'after';
      });
    }).toThrow();
    expect(cache).toBe('before');
    expect(store.state).toBe('faulted');
    expect(() => store.transaction(() => 1)).toThrow(expect.objectContaining({ code: 'STORE_FAULTED' }));
    expect(() => SqliteStore.open({ ...options, mode: 'open' })).toThrow(expect.objectContaining({ code: 'OWNERSHIP_BUSY' }));
    store.close();
    expect(open({ ...options, mode: 'open' }).database.prepare('SELECT * FROM deferred_children').all()).toEqual([]);
  });

  it('rejects native async callbacks before invocation', () => {
    const store = open(fixture());
    let invoked = false;
    const callback = async () => { invoked = true; };
    // @ts-expect-error async callbacks are also forbidden by the public type
    expect(() => store.transaction(callback)).toThrow(expect.objectContaining({ code: 'TRANSACTION_MISUSE' }));
    expect(invoked).toBe(false);
  });

  it('rejects returned Promises, rolls back and closes retained DB references', async () => {
    const options = fixture();
    const store = open(options);
    const db = store.database;
    const callback = () => {
      db.prepare('INSERT INTO records VALUES (?, ?)').run('async', 'staged');
      return Promise.resolve('not-committed');
    };
    // @ts-expect-error a Promise result is not a synchronous transaction result
    expect(() => store.transaction(callback)).toThrow(expect.objectContaining({ code: 'TRANSACTION_MISUSE' }));
    await Promise.resolve();
    expect(db.isOpen).toBe(false);
    expect(store.state).toBe('faulted');
    store.close();
    expect(open({ ...options, mode: 'open' }).database.prepare('SELECT * FROM records').all()).toEqual([]);
  });

  it('rejects custom thenables without invoking then', () => {
    const store = open(fixture());
    let invoked = false;
    const callback = (): unknown => ({ then: () => { invoked = true; } });
    expect(() => store.transaction(callback)).toThrow(expect.objectContaining({ code: 'TRANSACTION_MISUSE' }));
    expect(invoked).toBe(false);
    expect(store.state).toBe('faulted');
  });

  it('rejects nested transactions even if the callback swallows the rejection', () => {
    const options = fixture();
    const store = open(options);
    expect(() => store.transaction((db) => {
      db.prepare('INSERT INTO records VALUES (?, ?)').run('nested', 'staged');
      try { store.transaction(() => 1); } catch { /* deliberate swallowed misuse */ }
      return 'must not commit';
    })).toThrow(expect.objectContaining({ code: 'TRANSACTION_MISUSE' }));
    store.close();
    expect(open({ ...options, mode: 'open' }).database.prepare('SELECT * FROM records').all()).toEqual([]);
  });

  it('rejects unmanaged transactions, durability changes and calls after close', () => {
    for (const sql of ['BEGIN', 'PRAGMA synchronous=OFF', 'PRAGMA foreign_keys=OFF']) {
      const store = open(fixture());
      store.database.exec(sql);
      expect(() => store.transaction(() => 1)).toThrow();
      expect(store.state).toBe('faulted');
      store.close();
      store.close();
      expect(() => store.database).toThrow(expect.objectContaining({ code: 'STORE_CLOSED' }));
    }
  });

  it.each([10, 13])('fails closed on injected SQLite I/O/FULL error %i and rolls back SQL', (errcode) => {
    const options = fixture();
    const store = open(options);
    expect(() => store.transaction<void>((db) => {
      db.prepare('INSERT INTO records VALUES (?, ?)').run('failure', 'staged');
      throw Object.assign(new Error('injected storage failure'), { errcode });
    })).toThrow();
    expect(store.state).toBe('faulted');
    store.close();
    expect(open({ ...options, mode: 'open' }).database.prepare('SELECT * FROM records').all()).toEqual([]);
  });
});

describe('versioned, checksummed migrations and explicit initialization', () => {
  it('requires explicit create/open; never replaces existing or silently recreates missing state', () => {
    const options = fixture();
    expect(() => SqliteStore.open({ ...options, mode: 'open' })).toThrow(expect.objectContaining({ code: 'DATABASE_MISSING' }));
    expect(existsSync(join(options.dataDir, 'state.sqlite'))).toBe(false);
    open(options).close();
    expect(() => SqliteStore.open(options)).toThrow(expect.objectContaining({ code: 'DATABASE_EXISTS' }));
  });

  it('applies an append-only migration once and preserves existing rows', () => {
    const options = fixture();
    const first = open(options);
    first.transaction((db) => db.prepare('INSERT INTO records VALUES (?, ?)').run('kept', 'original'));
    first.close();
    const next = defineMigration({ version: 2, name: 'index', sql: 'CREATE INDEX records_value ON records(value)' });
    expect(next.checksum).toBe(migrationChecksum(next));
    const upgraded = { ...options, mode: 'open' as const, schema: { ...schema, migrations: [...schema.migrations, next] } };
    const second = open(upgraded);
    expect(second.version).toBe(2);
    expect(second.database.prepare('SELECT value FROM records WHERE id = ?').get('kept')?.value).toBe('original');
    second.close();
    expect(open(upgraded).version).toBe(2);
  });

  it.each(['newer', 'domain', 'format', 'ledger'] as const)('rejects unknown/mismatched schema: %s', (variant) => {
    const options = fixture();
    const store = open(options);
    const sql = {
      newer: 'PRAGMA user_version=999',
      domain: "UPDATE _qlong_storage SET schema_id='foreign.domain'",
      format: 'UPDATE _qlong_storage SET format_version=999',
      ledger: 'DELETE FROM _qlong_migrations',
    }[variant];
    store.database.exec(sql);
    store.close();
    expect(() => SqliteStore.open({ ...options, mode: 'open' })).toThrow(expect.objectContaining({ code: 'SCHEMA_UNSUPPORTED' }));
  });

  it('rejects modified migration history on disk or in source without resetting', () => {
    const options = fixture();
    const store = open(options);
    store.database.prepare('UPDATE _qlong_migrations SET checksum = ?').run('changed');
    store.close();
    expect(() => SqliteStore.open({ ...options, mode: 'open' })).toThrow(expect.objectContaining({ code: 'MIGRATION_CHECKSUM' }));
    const changed = { ...schema.migrations[0]!, sql: 'CREATE TABLE changed (id INTEGER)' };
    expect(() => SqliteStore.open({ ...options, mode: 'open', schema: { ...schema, migrations: [changed] } }))
      .toThrow(expect.objectContaining({ code: 'MIGRATION_CHECKSUM' }));
  });

  it('rolls back a failed upgrade including DDL and version/ledger changes', () => {
    const options = fixture();
    open(options).close();
    const bad = defineMigration({ version: 2, name: 'broken', sql: 'CREATE TABLE staged (id INTEGER); INVALID SQL;' });
    expect(() => SqliteStore.open({ ...options, mode: 'open', schema: { ...schema, migrations: [...schema.migrations, bad] } }))
      .toThrow(expect.objectContaining({ code: 'MIGRATION_FAILED' }));
    const recovered = open({ ...options, mode: 'open' });
    expect(recovered.version).toBe(1);
    expect(recovered.database.prepare('SELECT name FROM sqlite_schema WHERE name = ?').get('staged')).toBeUndefined();
  });

  it('rejects a re-checksummed edit to already applied migration source', () => {
    const options = fixture();
    open(options).close();
    const edited = defineMigration({ ...schema.migrations[0]!, sql: 'CREATE TABLE different (id INTEGER)' });
    expect(() => SqliteStore.open({ ...options, mode: 'open', schema: { ...schema, migrations: [edited] } }))
      .toThrow(expect.objectContaining({ code: 'MIGRATION_CHECKSUM' }));
  });

  it('does not silently retry bootstrap after failed initial migrations', () => {
    const options = fixture();
    const bad = defineMigration({ version: 1, name: 'broken', sql: 'CREATE TABLE staged (id INTEGER); INVALID SQL;' });
    expect(() => SqliteStore.open({ ...options, schema: { ...schema, migrations: [bad] } }))
      .toThrow(expect.objectContaining({ code: 'MIGRATION_FAILED' }));
    expect(() => SqliteStore.open(options)).toThrow(expect.objectContaining({ code: 'DATABASE_EXISTS' }));
    expect(() => SqliteStore.open({ ...options, mode: 'open' })).toThrow(expect.objectContaining({ code: 'SCHEMA_UNSUPPORTED' }));
  });

  it.each(['empty', 'foreign', 'corrupt'])('rejects preexisting %s databases without bootstrapping', (kind) => {
    const options = fixture();
    mkdirSync(options.dataDir, { mode: 0o700 });
    const path = join(options.dataDir, 'state.sqlite');
    writeFileSync(path, kind === 'corrupt' ? Buffer.alloc(512, 0x78) : '', { mode: 0o600 });
    if (kind === 'foreign') {
      const db = new DatabaseSync(path);
      db.exec('CREATE TABLE foreign_data (id INTEGER)');
      db.close();
    }
    const before = statSync(path).size;
    expect(() => SqliteStore.open({ ...options, mode: 'open' })).toThrow(expect.objectContaining({
      code: kind === 'corrupt' ? 'DATABASE_CORRUPT' : 'SCHEMA_UNSUPPORTED',
    }));
    expect(statSync(path).size).toBe(before);
  });
});

describe('local filesystem/path admission', () => {
  it('requires local filesystem confirmation and a strict allowed-base boundary', () => {
    const options = fixture();
    expect(() => SqliteStore.open({ ...options, localFilesystemConfirmed: false as unknown as true }))
      .toThrow(expect.objectContaining({ code: 'UNSAFE_PATH' }));
    expect(() => SqliteStore.open({ ...options, dataDir: options.allowedBase }))
      .toThrow(expect.objectContaining({ code: 'UNSAFE_PATH' }));
    expect(() => SqliteStore.open({ ...options, dataDir: join(options.allowedBase, '..', 'outside') }))
      .toThrow(expect.objectContaining({ code: 'UNSAFE_PATH' }));
    expect(() => SqliteStore.open({ ...options, filename: '../outside.sqlite' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
    expect(() => SqliteStore.open({ ...options, filename: 'ownership.sqlite' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
  });

  it.skipIf(process.platform === 'win32')('rejects world-readable data directories and symlink database files', () => {
    const options = fixture();
    mkdirSync(options.dataDir, { mode: 0o700 });
    chmodSync(options.dataDir, 0o755);
    expect(() => SqliteStore.open(options)).toThrow(expect.objectContaining({ code: 'UNSAFE_PATH' }));
    chmodSync(options.dataDir, 0o700);
    const other = join(options.allowedBase, 'other.sqlite');
    writeFileSync(other, '', { mode: 0o600 });
    symlinkSync(other, join(options.dataDir, 'state.sqlite'));
    expect(() => SqliteStore.open({ ...options, mode: 'open' })).toThrow(expect.objectContaining({ code: 'UNSAFE_PATH' }));
  });

  it.skipIf(process.platform !== 'win32')('requires explicit Windows ACL admission', () => {
    expect(() => SqliteStore.open({ ...fixture(), windowsAclConfirmed: undefined }))
      .toThrow(expect.objectContaining({ code: 'UNSAFE_PATH' }));
  });
});