import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isMainThread } from 'node:worker_threads';
import { busyTimeout, checkIntegrity, configureConnection, rollback, verifyPragmas } from './connection.js';
import { isBusy, StorageError, storageFailure } from './errors.js';
import { checkDatabaseFiles, prepareDataDirectory, protectNewDatabase } from './paths.js';
import type { DataDirectoryOptions } from './paths.js';

export interface OwnershipOptions extends DataDirectoryOptions { busyTimeoutMs?: number }

// Share across duplicate imports in this isolate. Do not open a second lock-file handle first:
// closing an unrelated fd can drop POSIX advisory locks. Worker-thread owners are unsupported.
const key = Symbol.for('@qlong/storage/ownership');
const globals = globalThis as unknown as Record<symbol, Set<string> | undefined>;
const owners = globals[key] ??= new Set<string>();

/**
 * Cooperative local-file mutex, NOT a lease or a proof of daemon health/global identity.
 * Never delete/rename/replace the live directory or lock file, never fs.open/read/close
 * ownership.sqlite, and never mix SQLite implementations. No PID/time-based stealing.
 * New owners must reconcile old containers before enabling admission.
 */
export class DatabaseOwnership {
  readonly dataDir: string;
  readonly path: string;
  #db: DatabaseSync;
  #key: string;
  #closed = false;

  private constructor(dataDir: string, db: DatabaseSync, ownerKey: string) {
    this.dataDir = dataDir;
    this.path = join(dataDir, 'ownership.sqlite');
    this.#db = db;
    this.#key = ownerKey;
  }

  static acquire(options: OwnershipOptions): DatabaseOwnership {
    if (!isMainThread) throw new StorageError('INVALID_OPTIONS', 'Ownership must be held on the main thread');
    const timeout = busyTimeout(options.busyTimeoutMs);
    const dataDir = prepareDataDirectory(options);
    const ownerKey = process.platform === 'win32' ? dataDir.toLowerCase() : dataDir;
    if (owners.has(ownerKey)) throw new StorageError('OWNERSHIP_BUSY', 'This process already owns the data directory');
    owners.add(ownerKey);
    let db: DatabaseSync | undefined;
    try {
      const path = join(dataDir, 'ownership.sqlite');
      const existed = checkDatabaseFiles(path);
      db = new DatabaseSync(path, { timeout, allowExtension: false });
      if (!existed) protectNewDatabase(path);
      configureConnection(db, 'delete');
      db.exec('BEGIN EXCLUSIVE');
      checkIntegrity(db);
      // This database is only a mutex; domain tables/versions belong in the business DB.
      if (db.prepare('PRAGMA application_id').get()?.application_id !== 0 ||
          db.prepare('PRAGMA user_version').get()?.user_version !== 0 ||
          db.prepare('SELECT name FROM sqlite_schema').all().length !== 0) {
        throw new StorageError('SCHEMA_UNSUPPORTED', 'Unexpected ownership database schema');
      }
      verifyPragmas(db, 'delete');
      return new DatabaseOwnership(dataDir, db, ownerKey);
    } catch (error) {
      // Keep the in-process reservation if close fails: an uncertain lock is not reusable.
      if (db?.isOpen) db.close();
      owners.delete(ownerKey);
      if (isBusy(error)) throw new StorageError('OWNERSHIP_BUSY', 'Cannot exclusively own the data directory', { cause: error });
      throw storageFailure(error, 'Cannot acquire database ownership');
    }
  }

  assertHeld(): void {
    if (this.#closed || !this.#db.isOpen || !this.#db.isTransaction) {
      throw new StorageError('OWNERSHIP_LOST', 'Database ownership was released; stop admission and side effects');
    }
  }

  /** Caller must close ALL business connections and stop side effects before releasing. */
  close(): void {
    if (this.#closed) return;
    this.assertHeld();
    rollback(this.#db);
    this.#db.close();
    this.#closed = true;
    owners.delete(this.#key);
  }
}