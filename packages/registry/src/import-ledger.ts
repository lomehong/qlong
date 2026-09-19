import type { DatabaseSync } from 'node:sqlite';
import { StorageError, type SqliteStore } from '../../storage/src/index.js';

/**
 * import_ledger(F1/P2 slice2, s2a):旧数据显式迁移的审计 + 幂等账本(设计 docs/repair/DATA-MIGRATION.md §5 slice2)。
 *
 * 每次事务化导入按 (kind, source_sha256) 追加一行,记录该来源各分类计数(migratable/blocked/non_migratable/invalid)
 * 与导入时刻。它是导入器的**幂等键**:相同来源摘要重跑据此判定"已导入且内容一致 → 无副作用返回";
 * 同 PK 异体则由 SQL PRIMARY KEY 拒绝(冲突 → 整事务回滚)。
 *
 * 与 SqliteCommandStore/SqliteCustodyStore/SqliteClaimStore 同为中心侧操作表(列式 + SQL CHECK,无 FK——
 * 账本是审计实体而非引用实体):
 * - **db 级 insert/find**:供导入器在**单事务**内与 users/mailbox/auth_meta 写组合(镜像 state-store.writeDiff(db,…)),
 *   因为 SqliteStore.transaction 禁嵌套/禁 async,导入器必须在一个同步事务里落全部副作用。
 * - **损坏 fail-closed**:SqliteImportLedger 构造时校验全表(结构 + 应用层不变量),违反即抛
 *   StorageError('DATABASE_CORRUPT')进入 recovery,绝不静默重建(同 command-store.ts:112)。
 * - **只追加,永不删/GC**:账本是迁移审计的耐久证据(存储铁律),历史不可回收。
 *
 * 不拥有/关闭 storage(同其它中心侧 store)。
 */

/** Schema fragment only. The center must append a migration (v5) before constructing the store. */
export const IMPORT_LEDGER_SQL = `
CREATE TABLE import_ledger (
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
  kind TEXT NOT NULL CHECK (kind IN ('users', 'initialized', 'mailbox')),
  imported_at TEXT NOT NULL,
  migratable INTEGER NOT NULL CHECK (migratable >= 0),
  blocked INTEGER NOT NULL CHECK (blocked >= 0),
  non_migratable INTEGER NOT NULL CHECK (non_migratable >= 0),
  invalid INTEGER NOT NULL CHECK (invalid >= 0),
  PRIMARY KEY (kind, source_sha256)
) STRICT;
`;

/** 迁移来源分类(与 inspectMigration 的三类源一一对应)。 */
export type ImportKind = 'users' | 'initialized' | 'mailbox';

/** 一次导入在某来源上的分类计数账目(由列投影;导入器落库 + 复核读取的契约对象)。 */
export interface ImportLedgerEntry {
  /** 来源内容摘要(hex64,小写);与 kind 共同构成幂等键。 */
  source_sha256: string;
  kind: ImportKind;
  /** ISO-8601 UTC 导入时刻(字典序=时间序)。 */
  imported_at: string;
  /** 可迁移并已导入的条数。 */
  migratable: number;
  /** 因缺身份/公钥等被阻断、未导入的条数。 */
  blocked: number;
  /** 结构有效但语义不可迁移(如过期 mailbox)的条数。 */
  non_migratable: number;
  /** 解析/校验失败(损坏)的条数。 */
  invalid: number;
}

function requireValid(condition: unknown): asserts condition {
  // Never include persisted values in recovery errors.
  if (!condition) throw new StorageError('DATABASE_CORRUPT', 'Invalid import ledger state; explicit recovery required');
}

function validSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function validKind(value: unknown): value is ImportKind {
  return value === 'users' || value === 'initialized' || value === 'mailbox';
}

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** RFC3339/ISO-8601 UTC 时间戳,拒绝 Date.parse 的日历回滚与本地时区猜测(同 command-store validIso)。 */
function validIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** 校验持久账目行并投影为 ImportLedgerEntry;损坏即 fail-closed(绝不静默跳过或伪造)。 */
function load(raw: Record<string, unknown>): ImportLedgerEntry {
  requireValid(
    validSha(raw.source_sha256) && validKind(raw.kind) && validIso(raw.imported_at) &&
    validCount(raw.migratable) && validCount(raw.blocked) &&
    validCount(raw.non_migratable) && validCount(raw.invalid),
  );
  return {
    source_sha256: raw.source_sha256 as string,
    kind: raw.kind as ImportKind,
    imported_at: raw.imported_at as string,
    migratable: raw.migratable as number,
    blocked: raw.blocked as number,
    non_migratable: raw.non_migratable as number,
    invalid: raw.invalid as number,
  };
}

/**
 * db 级写入:在调用方已开启的**单事务**内追加一行账目(in-tx helper,镜像 state-store.writeDiff)。
 * 违反 PK(同 kind+sha 已存在)或 CHECK 即由 SQLite 抛错,令整事务回滚(冲突拒绝语义)。
 */
export function insertImportLedger(db: DatabaseSync, entry: ImportLedgerEntry): void {
  db.prepare(`INSERT INTO import_ledger
    (source_sha256, kind, imported_at, migratable, blocked, non_migratable, invalid)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(entry.source_sha256, entry.kind, entry.imported_at,
      entry.migratable, entry.blocked, entry.non_migratable, entry.invalid);
}

/** db 级读取:按 (kind, source_sha256) 取一行账目;不存在返回 undefined(幂等判定的只读侧)。 */
export function findImportLedger(db: DatabaseSync, kind: ImportKind, sourceSha256: string): ImportLedgerEntry | undefined {
  const raw = db.prepare('SELECT * FROM import_ledger WHERE kind = ? AND source_sha256 = ?').get(kind, sourceSha256);
  if (raw === undefined) return undefined;
  return load(raw as Record<string, unknown>);
}

export class SqliteImportLedger {
  constructor(private readonly store: SqliteStore) {
    // Fail-closed on any corrupt row before serving: recovery, never silent rebuild.
    store.transaction((db) => {
      for (const raw of db.prepare('SELECT * FROM import_ledger').iterate()) {
        load(raw as Record<string, unknown>);
      }
    });
  }

  /** 该来源摘要在此 kind 下是否已入账(导入器幂等短路 + 复核用)。 */
  has(kind: ImportKind, sourceSha256: string): boolean {
    return this.store.transaction<boolean>((db) =>
      db.prepare('SELECT 1 FROM import_ledger WHERE kind = ? AND source_sha256 = ?').get(kind, sourceSha256) !== undefined);
  }

  /** 全部账目,按 (imported_at, kind, source_sha256) 稳定排序(审计复核)。 */
  history(): ImportLedgerEntry[] {
    return this.store.transaction<ImportLedgerEntry[]>((db) =>
      db.prepare('SELECT * FROM import_ledger ORDER BY imported_at, kind, source_sha256')
        .all().map((raw) => load(raw as Record<string, unknown>)));
  }
}
