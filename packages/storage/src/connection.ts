import type { DatabaseSync } from 'node:sqlite';
import { StorageError } from './errors.js';

export function busyTimeout(value = 1_000): number {
  if (!Number.isInteger(value) || value < 0 || value > 5_000) {
    throw new StorageError('INVALID_OPTIONS', 'busyTimeoutMs must be an integer from 0 to 5000');
  }
  return value;
}

export function verifyPragmas(db: DatabaseSync, journal: 'wal' | 'delete'): void {
  if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== journal ||
      db.prepare('PRAGMA synchronous').get()?.synchronous !== 2 ||
      db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) {
    throw new StorageError('DURABILITY_UNAVAILABLE', 'Required SQLite journal/FULL/foreign_keys configuration unavailable');
  }
}

export function configureConnection(db: DatabaseSync, journal: 'wal' | 'delete'): void {
  db.enableLoadExtension(false);
  db.exec(journal === 'wal' ? 'PRAGMA journal_mode=WAL' : 'PRAGMA journal_mode=DELETE');
  db.exec('PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON');
  verifyPragmas(db, journal);
}

export function checkIntegrity(db: DatabaseSync): void {
  const rows = db.prepare('PRAGMA quick_check').all();
  if (rows.length !== 1 || rows[0]?.quick_check !== 'ok') {
    throw new StorageError('DATABASE_CORRUPT', 'SQLite integrity check failed');
  }
  if (db.prepare('PRAGMA foreign_key_check').all().length !== 0) {
    throw new StorageError('DATABASE_CORRUPT', 'Stored foreign key constraints are violated');
  }
}

export function rollback(db: DatabaseSync): void {
  // Some SQLite failures roll back automatically; do not mask them with a spurious ROLLBACK.
  if (db.isOpen && db.isTransaction) db.exec('ROLLBACK');
}