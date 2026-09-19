import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { defineMigration, SqliteStore, StorageError, type SqliteStoreOptions } from '../../storage/src/index.js';
import {
  IMPORT_LEDGER_SQL, SqliteImportLedger, findImportLedger, insertImportLedger, type ImportLedgerEntry,
} from '../src/import-ledger.js';

/**
 * F1/P2 slice2 (s2a):import_ledger——旧数据迁移的审计 + 幂等账本(设计 docs/repair/DATA-MIGRATION.md §5 slice2)。
 * 每次事务化导入按来源摘要(source_sha256)+kind 追加一行,记录各分类计数;相同来源摘要重跑据此判幂等。
 * db 级 insert/find 供导入器在**单事务**内组合(镜像 state-store.writeDiff(db,…));store 类供只读复核。
 * 损坏 fail-closed(recovery 非静默重建),同 SqliteCommandStore/SqliteCustodyStore。
 */
const NOW = Date.parse('2026-09-19T12:00:00.000Z');
const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);
const stores = new Set<SqliteStore>();
const tempBase = realpathSync(tmpdir());
const roots = new Set<string>();
const schema = {
  id: 'qlong.import-ledger-test',
  migrations: [defineMigration({ version: 1, name: 'import-ledger', sql: IMPORT_LEDGER_SQL })],
};

function storageOptions(): SqliteStoreOptions {
  const root = mkdtempSync(join(tempBase, 'qlong-ledger-'));
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
  let ledger = new SqliteImportLedger(storage);
  return {
    get storage() { return storage; },
    get ledger() { return ledger; },
    reopen() {
      storage.close();
      storage = open({ ...settings, mode: 'open' });
      ledger = new SqliteImportLedger(storage);
      return ledger;
    },
  };
}

function entry(o: Partial<ImportLedgerEntry> = {}): ImportLedgerEntry {
  return {
    source_sha256: SHA, kind: 'users', imported_at: new Date(NOW).toISOString(),
    migratable: 3, blocked: 1, non_migratable: 0, invalid: 2, ...o,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const storage of [...stores].reverse()) storage.close();
  stores.clear();
  for (const root of roots) {
    if (dirname(root) !== tempBase || !basename(root).startsWith('qlong-ledger-')) {
      throw new Error('Unsafe ledger test cleanup target');
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  roots.clear();
});

describe('import_ledger (F1/P2 slice2: migration audit + idempotency ledger)', () => {
  it('insertImportLedger + findImportLedger round-trip a entry by (kind, source_sha256)', () => {
    const f = fixture();
    f.storage.transaction((db) => insertImportLedger(db, entry()));
    expect(f.storage.transaction((db) => findImportLedger(db, 'users', SHA))).toEqual(entry());
  });

  it('composes multiple inserts in a SINGLE transaction (in-tx helper for the importer)', () => {
    const f = fixture();
    f.storage.transaction((db) => {
      insertImportLedger(db, entry({ kind: 'users', source_sha256: SHA }));
      insertImportLedger(db, entry({ kind: 'mailbox', source_sha256: SHA2, migratable: 5 }));
    });
    expect(f.ledger.history()).toHaveLength(2);
  });

  it('findImportLedger returns undefined for an unknown (kind, source_sha256)', () => {
    const f = fixture();
    expect(f.storage.transaction((db) => findImportLedger(db, 'users', SHA))).toBeUndefined();
    f.storage.transaction((db) => insertImportLedger(db, entry({ kind: 'users', source_sha256: SHA })));
    // Same sha under a different kind is a distinct row (PK is (kind, source_sha256)).
    expect(f.storage.transaction((db) => findImportLedger(db, 'mailbox', SHA))).toBeUndefined();
  });

  it('duplicate (kind, source_sha256) violates the PK — the idempotency guard is enforced by schema', () => {
    const f = fixture();
    f.storage.transaction((db) => insertImportLedger(db, entry()));
    expect(() => f.storage.transaction((db) => insertImportLedger(db, entry({ migratable: 9 })))).toThrow();
  });

  it('SqliteImportLedger.has reflects inserted entries and is false for unknown', () => {
    const f = fixture();
    expect(f.ledger.has('users', SHA)).toBe(false);
    f.storage.transaction((db) => insertImportLedger(db, entry()));
    expect(f.ledger.has('users', SHA)).toBe(true);
    expect(f.ledger.has('mailbox', SHA)).toBe(false);
  });

  it('survives restart: history persists across reopen (durability)', () => {
    const f = fixture();
    f.storage.transaction((db) => insertImportLedger(db, entry()));
    const reopened = f.reopen();
    expect(reopened.history()).toEqual([entry()]);
  });

  it('schema CHECK rejects a bad kind, a negative count, and a non-hex sha (raw INSERT)', () => {
    const f = fixture();
    const raw = (cols: string, vals: (string | number)[]): void => {
      f.storage.transaction((db) => db.prepare(
        `INSERT INTO import_ledger (${cols}) VALUES (${vals.map(() => '?').join(', ')})`).run(...vals));
    };
    const iso = new Date(NOW).toISOString();
    expect(() => raw('source_sha256, kind, imported_at, migratable, blocked, non_migratable, invalid',
      [SHA, 'bogus', iso, 0, 0, 0, 0])).toThrow();
    expect(() => raw('source_sha256, kind, imported_at, migratable, blocked, non_migratable, invalid',
      [SHA, 'users', iso, -1, 0, 0, 0])).toThrow();
    expect(() => raw('source_sha256, kind, imported_at, migratable, blocked, non_migratable, invalid',
      ['z'.repeat(64), 'users', iso, 0, 0, 0, 0])).toThrow();
  });

  it('faults (recovery, not silent rebuild) on a corrupt imported_at at construction', () => {
    const f = fixture();
    f.storage.transaction((db) => insertImportLedger(db, entry()));
    // imported_at is TEXT NOT NULL without a SQL CHECK; 'bogus' passes SQL but violates the app-level
    // ISO invariant, so the constructor must fail-closed (recovery, never silent rebuild).
    f.storage.database.prepare('UPDATE import_ledger SET imported_at = ?').run('bogus');
    expect(() => new SqliteImportLedger(f.storage)).toThrow(StorageError);
  });
});
