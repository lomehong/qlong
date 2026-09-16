import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { checkIntegrity, rollback, verifyPragmas } from './connection.js';
import { StorageError } from './errors.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  /** Trusted static SQL only. No transaction control, PRAGMAs, ATTACH, or external I/O. */
  readonly sql: string;
  readonly checksum: string;
}

export interface StorageSchema {
  /** Stable domain identity, e.g. qlong.registry. Cannot change in-place. */
  readonly id: string;
  /** Complete, immutable history, contiguous from version 1. */
  readonly migrations: readonly Migration[];
}

const APPLICATION_ID = 0x514c4e47;

export function migrationChecksum(migration: Omit<Migration, 'checksum'>): string {
  return createHash('sha256').update(JSON.stringify([migration.version, migration.name, migration.sql])).digest('hex');
}

export function defineMigration(migration: Omit<Migration, 'checksum'>): Migration {
  return Object.freeze({ ...migration, checksum: migrationChecksum(migration) });
}

export function validateSchema(schema: StorageSchema): void {
  if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(schema.id) || schema.migrations.length === 0) {
    throw new StorageError('INVALID_OPTIONS', 'A stable schema id and nonempty migration history are required');
  }
  schema.migrations.forEach((migration, index) => {
    if (migration.version !== index + 1 || !migration.name.trim() || !migration.sql.trim()) {
      throw new StorageError('INVALID_OPTIONS', 'Migrations must be named, nonempty and contiguous from version 1');
    }
    if (migration.checksum !== migrationChecksum(migration)) {
      throw new StorageError('MIGRATION_CHECKSUM', 'Migration source checksum does not match');
    }
  });
}

/** Inspect before writing PRAGMAs or migrating; an existing empty SQLite file is NOT new. */
export function schemaVersion(db: DatabaseSync, schema: StorageSchema, isNew: boolean): number {
  checkIntegrity(db);
  const application = db.prepare('PRAGMA application_id').get()?.application_id;
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  if (isNew) {
    if (application !== 0 || version !== 0 || db.prepare('SELECT name FROM sqlite_schema').all().length !== 0) {
      throw new StorageError('SCHEMA_UNSUPPORTED', 'New database is not empty');
    }
    return 0;
  }
  if (application !== APPLICATION_ID || typeof version !== 'number' || !Number.isInteger(version) ||
      version < 1 || version > schema.migrations.length) {
    throw new StorageError('SCHEMA_UNSUPPORTED', 'Uninitialized, foreign or unsupported database schema');
  }
  try {
    const metadata = db.prepare('SELECT id, format_version, schema_id FROM _qlong_storage').all();
    if (metadata.length !== 1 || metadata[0]?.id !== 1 || metadata[0]?.format_version !== 1 ||
        metadata[0]?.schema_id !== schema.id) {
      throw new StorageError('SCHEMA_UNSUPPORTED', 'Storage format or domain identity does not match');
    }
    const rows = db.prepare('SELECT version, name, checksum FROM _qlong_migrations ORDER BY version').all();
    if (rows.length !== version) throw new StorageError('SCHEMA_UNSUPPORTED', 'Migration ledger/version disagree');
    rows.forEach((row, index) => {
      const expected = schema.migrations[index]!;
      if (row.version !== expected.version) throw new StorageError('SCHEMA_UNSUPPORTED', 'Migration history has gaps');
      if (row.name !== expected.name || row.checksum !== expected.checksum) {
        throw new StorageError('MIGRATION_CHECKSUM', 'Applied migration history was changed');
      }
    });
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError('SCHEMA_UNSUPPORTED', 'Storage metadata is missing or unreadable', { cause: error });
  }
  return version;
}

export function applyMigrations(db: DatabaseSync, schema: StorageSchema, from: number): void {
  if (from === schema.migrations.length) return;
  try {
    db.exec('BEGIN IMMEDIATE');
    if (from === 0) {
      db.exec(`
        CREATE TABLE _qlong_storage (
          id INTEGER PRIMARY KEY CHECK (id = 1), format_version INTEGER NOT NULL,
          schema_id TEXT NOT NULL
        ) STRICT;
        CREATE TABLE _qlong_migrations (
          version INTEGER PRIMARY KEY CHECK (version > 0), name TEXT NOT NULL, checksum TEXT NOT NULL
        ) STRICT;
      `);
      db.prepare('INSERT INTO _qlong_storage VALUES (1, 1, ?)').run(schema.id);
      db.exec(`PRAGMA application_id=${APPLICATION_ID}`);
    }
    const insert = db.prepare('INSERT INTO _qlong_migrations(version, name, checksum) VALUES (?, ?, ?)');
    for (const migration of schema.migrations.slice(from)) {
      db.exec(migration.sql);
      if (!db.isTransaction) throw new StorageError('TRANSACTION_MISUSE', 'Migration ended its transaction');
      insert.run(migration.version, migration.name, migration.checksum);
      // SQLite PRAGMA values cannot be bound; this is a validated contiguous integer, not input SQL.
      db.exec(`PRAGMA user_version=${migration.version}`);
    }
    verifyPragmas(db, 'wal');
    checkIntegrity(db);
    schemaVersion(db, schema, false);
    db.exec('COMMIT');
  } catch (error) {
    rollback(db);
    throw new StorageError('MIGRATION_FAILED', 'Schema migration failed; no automatic reset or bootstrap', { cause: error });
  }
}