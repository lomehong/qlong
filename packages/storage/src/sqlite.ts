import { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import { busyTimeout, configureConnection, rollback, verifyPragmas } from './connection.js';
import { isBusy, sqliteCode, StorageError, storageFailure } from './errors.js';
import { DatabaseOwnership } from './lock.js';
import type { OwnershipOptions } from './lock.js';
import { applyMigrations, schemaVersion, validateSchema } from './migrations.js';
import type { StorageSchema } from './migrations.js';
import { checkDatabaseFiles, databasePath, protectNewDatabase } from './paths.js';

export interface SqliteStoreOptions extends OwnershipOptions {
  schema: StorageSchema;
  /** Explicit bootstrap vs reopen. No open-or-create: a lost database must not re-bootstrap. */
  mode: 'create' | 'open';
  filename?: string;
}

export type StoreState = 'open' | 'faulted' | 'closed';

/**
 * One local daemon / one business DB. Callbacks and schema SQL are trusted application
 * code, not a sandbox: no network, await, Git, container work, manual transactions,
 * ATTACH, raw connection close/reopen or durability PRAGMAs. Bind ALL runtime values.
 * Publish staged caches/ACKs/effects only AFTER transaction() returns successfully.
 * On fault stop admission; close after stopping effects. Never delete DB/WAL/lock to recover.
 * WAL auto-checkpoint uses SQLite's default 1000 pages. Bound readers/queues and monitor
 * WAL size/latency at the daemon layer. Process-kill recovery does not prove power-loss safety.
 */
export class SqliteStore {
  readonly path: string;
  readonly dataDir: string;
  readonly version: number;
  #db: DatabaseSync;
  #ownership: DatabaseOwnership;
  #state: StoreState = 'open';
  #fault: StorageError | undefined;
  #transaction = false;
  #misuse: StorageError | undefined;

  private constructor(db: DatabaseSync, ownership: DatabaseOwnership, path: string, version: number) {
    this.#db = db;
    this.#ownership = ownership;
    this.path = path;
    this.dataDir = ownership.dataDir;
    this.version = version;
  }

  static open(options: SqliteStoreOptions): SqliteStore {
    validateSchema(options.schema);
    const timeout = busyTimeout(options.busyTimeoutMs);
    if (options.mode !== 'create' && options.mode !== 'open') {
      throw new StorageError('INVALID_OPTIONS', 'Explicit create/open mode is required');
    }
    databasePath(options.dataDir, options.filename ?? 'state.sqlite');
    const ownership = DatabaseOwnership.acquire(options);
    let db: DatabaseSync | undefined;
    try {
      const path = databasePath(ownership.dataDir, options.filename ?? 'state.sqlite');
      const exists = checkDatabaseFiles(path);
      if (exists && options.mode === 'create') throw new StorageError('DATABASE_EXISTS', 'Refusing to recreate an existing database');
      if (!exists && options.mode === 'open') throw new StorageError('DATABASE_MISSING', 'Database missing; explicit initialization/recovery required');
      db = new DatabaseSync(path, {
        timeout, allowExtension: false, enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false,
      });
      if (!exists) protectNewDatabase(path);
      const from = schemaVersion(db, options.schema, !exists);
      configureConnection(db, 'wal');
      applyMigrations(db, options.schema, from);
      checkDatabaseFiles(path);
      ownership.assertHeld();
      return new SqliteStore(db, ownership, path, options.schema.migrations.length);
    } catch (error) {
      // Never release ownership if closing the business connection fails.
      if (db?.isOpen) db.close();
      ownership.close();
      throw storageFailure(error, 'Cannot open SQLite store; explicit recovery required');
    }
  }

  get state(): StoreState { return this.#state; }
  get fault(): StorageError | undefined { return this.#fault; }

  /** Trusted domain schema/read/prepared-statement access. Writes belong in transaction(). */
  get database(): DatabaseSync {
    this.#assertOpen();
    return this.#db;
  }

  #poison(error: unknown): void {
    this.#state = 'faulted';
    this.#fault = storageFailure(error, 'Storage fault; stop admission and reconcile committed operation IDs');
    // Close retained references to prevent deferred SQL, but keep ownership until close().
    try { if (this.#db.isOpen) this.#db.close(); } catch { /* close() retries; ownership remains held */ }
  }

  #assertOpen(): void {
    if (this.#state === 'closed') throw new StorageError('STORE_CLOSED', 'Store is closed');
    if (this.#state === 'faulted') throw new StorageError('STORE_FAULTED', 'Store is faulted; stop admission', { cause: this.#fault });
    try {
      this.#ownership.assertHeld();
      if (!this.#db.isOpen || (this.#db.isTransaction && !this.#transaction)) {
        throw new StorageError('TRANSACTION_MISUSE', 'Connection closed or unmanaged transaction detected');
      }
      verifyPragmas(this.#db, 'wal');
    } catch (error) {
      this.#poison(error);
      throw error;
    }
  }

  /** Synchronous BEGIN IMMEDIATE; only returns the staged result AFTER successful COMMIT. */
  transaction<T>(callback: ((database: DatabaseSync) => T) & (T extends PromiseLike<unknown> ? never : unknown)): T {
    this.#assertOpen();
    if (this.#transaction) {
      this.#misuse = new StorageError('TRANSACTION_MISUSE', 'Nested transactions are forbidden');
      throw this.#misuse;
    }
    if (types.isAsyncFunction(callback)) {
      throw new StorageError('TRANSACTION_MISUSE', 'Async transaction callbacks are forbidden');
    }
    this.#transaction = true;
    this.#misuse = undefined;
    let phase: 'begin' | 'callback' | 'commit' = 'begin';
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      phase = 'callback';
      const result = callback(this.#db);
      if (result !== null && (typeof result === 'object' || typeof result === 'function') &&
          typeof (result as { then?: unknown }).then === 'function') {
        if (types.isPromise(result)) void result.catch(() => {});
        this.#misuse = new StorageError('TRANSACTION_MISUSE', 'Promise/thenable transaction results are forbidden');
      }
      if (this.#misuse) throw this.#misuse;
      this.#ownership.assertHeld();
      if (!this.#db.isOpen || !this.#db.isTransaction) {
        throw new StorageError('TRANSACTION_MISUSE', 'Callback ended the managed transaction');
      }
      verifyPragmas(this.#db, 'wal');
      phase = 'commit';
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try { rollback(this.#db); } catch (rollbackError) {
        this.#poison(rollbackError);
        throw this.#fault;
      }
      const sqlite = sqliteCode(error);
      if (phase === 'commit' || error instanceof StorageError ||
          (sqlite !== undefined && sqlite !== 19 && !isBusy(error))) this.#poison(error);
      // Constraint/BUSY/domain rejection can retry after rollback. I/O/FULL/uncertain
      // COMMIT must stop success ACKs and require stable operation-ID reconciliation.
      throw error;
    } finally {
      this.#transaction = false;
      this.#misuse = undefined;
    }
  }

  /** Stop admission/side effects first. Business close precedes ownership release. Idempotent. */
  close(): void {
    if (this.#state === 'closed') return;
    if (this.#transaction) {
      this.#misuse = new StorageError('TRANSACTION_MISUSE', 'Cannot close inside a transaction');
      throw this.#misuse;
    }
    try {
      if (this.#db.isOpen) this.#db.close();
      this.#ownership.close();
      this.#state = 'closed';
    } catch (error) {
      this.#poison(error);
      throw this.#fault;
    }
  }
}