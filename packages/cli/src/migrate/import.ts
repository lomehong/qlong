/**
 * F1/P2 slice2 (s2c) — `qlong migrate import` 的事务化导入器(DATA-MIGRATION.md §5 slice2 / §6)。
 *
 * 铁律落地:
 * - **独占准入 + 单事务**:SqliteStore.open(CENTER_SCHEMA) 取本地互斥锁;users/auth_meta/mailbox custody/
 *   import_ledger 的全部副作用落在**一个同步事务**内(SqliteStore.transaction 禁嵌套/禁 async),
 *   COMMIT 失败即整事务回滚(fail-closed,绝不部分发布)。
 * - **验签在事务外**:verifyEnvelopeSig 是 async,不能进事务;故先在事务外独立解析 + 验签 + 分类,
 *   事务内只做同步 db 级写(INSERT/UPDATE/offerInTransaction/insertImportLedger)。
 * - **mailbox 四不**:不延 exp(offerInTransaction 存 stored_at=import now、expires_at=原 exp)、不重签、
 *   不伪造身份、不确认状态(只落 pending)。缺身份/公钥 → blocked,不导入(诚实记入账本)。
 * - **幂等 / 冲突拒绝**:来源摘要 (kind, sha256) 已在账本 → 无副作用返回;同 PK 异体 → conflict 抛出、零写入。
 * - **inspect 为分类权威**:分类/计数复用 inspectMigration(单一真相,与 dry-run 报告一致);此处仅**重解析源字节**
 *   取回 Inventory 不携带的凭据/信封,并按身份匹配到 inspect 判定为 migratable/ok 的子集;任何不一致 → 抛出。
 * - **绝不输出凭据**:错误信息只含计数/分类,绝不含 salt/hash/私钥。
 */
import { envelopeDigest, fromBase64, validateEnvelope, verifyEnvelopeSig, type EnvelopeV1 } from '@qlong/core';
import { parseUserRecord } from '../../../registry/src/auth-store.js';
import type { UserRecord } from '../../../registry/src/auth.js';
import { insertImportLedger, type ImportKind, type ImportLedgerEntry } from '../../../registry/src/import-ledger.js';
import { CENTER_SCHEMA } from '../../../registry/src/schema.js';
import { encodeCustody, offerInTransaction, type CustodyLimits } from '../../../gateway/src/custody-store.js';
import { SqliteStore, type SqliteStoreOptions } from '../../../storage/src/index.js';
import {
  inspectMigration, lookupNodeKey,
  type Counts, type Inventory, type MigrationSources, type TargetNode,
} from './inspect.js';
import { readTargetSnapshot } from './read.js';

/** 目标库开启参数(= SqliteStoreOptions 去掉 schema;导入器固定用 CENTER_SCHEMA)。 */
export type ImportTarget = Omit<SqliteStoreOptions, 'schema'>;

export interface ImportOptions {
  /** 导入时刻(import now):custody stored_at 与账本 imported_at 的时间基准;绝不用于延长 exp。 */
  now: number;
  target: ImportTarget;
  /** custody 配额(默认镜像 SqliteCustodyStore:1 万条 / 64 MiB / 每收件人 1 千条)。 */
  limits?: CustodyLimits;
}

export interface ImportReport {
  targetPath: string;
  /** 全部来源摘要均已在账本 → 无副作用重跑。 */
  idempotent: boolean;
  usersInserted: number;
  mailboxStored: number;
  /** 本次事务新写入的账本行(幂等重跑为空)。 */
  ledger: ImportLedgerEntry[];
}

/** 账本只记四类计数(conflict>0 时导入器已抛出,永不落 conflict 行)。 */
type LedgerCounts = Pick<Counts, 'migratable' | 'blocked' | 'non_migratable' | 'invalid'>;

const DEFAULT_LIMITS: CustodyLimits = { maxEntries: 10_000, maxBytes: 64 * 1024 * 1024, perNodeEntries: 1_000 };
const MAX_TIME = 8_640_000_000_000_000;
const utf8 = (b: Uint8Array): string => Buffer.from(b).toString('utf8');
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const pick = (c: Counts): LedgerCounts =>
  ({ migratable: c.migratable, blocked: c.blocked, non_migratable: c.non_migratable, invalid: c.invalid });

function ledgerCounts(kind: ImportKind, inventory: Inventory): LedgerCounts {
  if (kind === 'users') return pick(inventory.users.counts);
  if (kind === 'mailbox') return pick(inventory.mailbox.counts);
  // initialized 标记本身不是数据行:valid → 认可 1;bad_marker → 非法 1(仅审计,不驱动 initialized 写)。
  return inventory.initialized.valid
    ? { migratable: 1, blocked: 0, non_migratable: 0, invalid: 0 }
    : { migratable: 0, blocked: 0, non_migratable: 0, invalid: 1 };
}

/**
 * 重解析 users.json,取回 inspect 判定为 migratable/ok 的用户(带 salt/hash)。
 * already_present(已在目标且同凭据)不重插;invalid/conflict 由 inspect 计数,conflict 已在上游抛出。
 * 恢复集与 inspect 判定不一致 → 抛出(绝不部分导入)。
 */
function extractUsers(sources: MigrationSources, inventory: Inventory): UserRecord[] {
  if (!sources.usersJson) return [];
  const toInsert = new Set<string>();
  for (const f of inventory.users.records) {
    if (f.class === 'migratable' && f.reason === 'ok' && f.username !== undefined) toInsert.add(f.username);
  }
  if (toInsert.size === 0) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(utf8(sources.usersJson.bytes)); } catch {
    throw new Error('migration source users.json became unreadable during import');
  }
  if (!Array.isArray(parsed)) throw new Error('migration source users.json is not an array during import');
  const out: UserRecord[] = [];
  for (const raw of parsed) {
    const rec = parseUserRecord(raw, true);
    if (!rec || !toInsert.has(rec.username)) continue;
    if (new Date(rec.created_at).toISOString() !== rec.created_at) continue; // 防御:非规范 ISO 不入目标库
    out.push(rec);
    toInsert.delete(rec.username);
  }
  if (toInsert.size !== 0) throw new Error('user import extraction mismatch; refusing partial import');
  return out;
}

/**
 * 重解析 mailbox,取回 inspect 判定为 migratable/ok 的信封,并**独立验签**(custody 信任调用方)。
 * dup/blocked/expired/lifetime_exceeded/invalid/already_present 均不在 toStore,自然跳过;
 * 任何身份/摘要/验签不一致 → 抛出(绝不部分导入、绝不落未验签信封)。
 */
async function extractEnvelopes(sources: MigrationSources, inventory: Inventory, nodes: TargetNode[]): Promise<EnvelopeV1[]> {
  if (!sources.mailbox) return [];
  const toStore = new Map<string, string>(); // `${from}\u0000${msg}` -> digest
  for (const e of inventory.mailbox.entries) {
    if (e.class === 'migratable' && e.reason === 'ok' &&
        e.from_node !== undefined && e.msg_id !== undefined && e.digest !== undefined) {
      toStore.set(`${e.from_node}\u0000${e.msg_id}`, e.digest);
    }
  }
  if (toStore.size === 0) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(utf8(sources.mailbox.bytes)); } catch {
    throw new Error('migration source mailbox became unreadable during import');
  }
  const file = asRecord(parsed);
  const boxes = Array.isArray(file.boxes) ? file.boxes : [];
  const out: EnvelopeV1[] = [];
  for (const rawBox of boxes) {
    const entries = Array.isArray(asRecord(rawBox).entries) ? (asRecord(rawBox).entries as unknown[]) : [];
    for (const rawEntry of entries) {
      const checked = validateEnvelope(asRecord(rawEntry).envelope);
      if (!checked.ok) continue;
      const env = checked.value;
      const key = `${env.from.node_id}\u0000${env.msg_id}`;
      const expected = toStore.get(key);
      if (expected === undefined) continue;
      if (envelopeDigest(env) !== expected) throw new Error('mailbox import digest mismatch; refusing partial import');
      const lookup = lookupNodeKey(nodes, env.from.node_id, env.from.key_epoch);
      if (lookup.status !== 'current' && lookup.status !== 'historical') {
        throw new Error('mailbox import signer key unavailable; refusing partial import');
      }
      const verified = await verifyEnvelopeSig(env, () => fromBase64(lookup.pubkey))
        .catch(() => ({ ok: false as const, reason: 'bad_sig' as const }));
      if (!verified.ok) throw new Error('mailbox import signature verification failed; refusing partial import');
      out.push(env);
      toStore.delete(key);
    }
  }
  if (toStore.size !== 0) throw new Error('mailbox import extraction mismatch; refusing partial import');
  return out;
}

/**
 * 事务化导入:打开专用目标库(独占准入)→ 事务外盘点 + 验签 + 恢复载荷 → 单事务落全部副作用。
 * 任一步失败(冲突/不一致/COMMIT 失败)→ 零写入或整事务回滚(fail-closed)。
 */
export async function importMigration(sources: MigrationSources, options: ImportOptions): Promise<ImportReport> {
  const { now, target } = options;
  if (!Number.isSafeInteger(now) || Math.abs(now) > MAX_TIME) {
    throw new RangeError('import clock must be a finite safe time');
  }
  const limits = options.limits ?? DEFAULT_LIMITS;
  const importedAt = new Date(now).toISOString(); // 规范 ISO(账本 validIso 不变量)
  const store = SqliteStore.open({ ...target, schema: CENTER_SCHEMA }); // 独占准入锁
  try {
    const targetPath = store.path;
    // WAL 并发只读:store 持锁期间用 raw readOnly 连接读快照(镜像 read.ts/server-custody-helpers.inspectSql)。
    const snapshot = readTargetSnapshot(targetPath);
    const inventory = await inspectMigration(sources, snapshot, now);
    // 冲突拒绝:任何同 PK 异体 → 抛出、零写入(在事务之前)。
    const conflicts = inventory.users.counts.conflict + inventory.mailbox.counts.conflict;
    if (conflicts > 0) {
      throw new Error(`migration conflict: ${conflicts} source record(s) collide with different target content; refusing to import`);
    }
    const users = extractUsers(sources, inventory);
    const envelopes = await extractEnvelopes(sources, inventory, snapshot.nodes);
    const result = store.transaction<{ idempotent: boolean; usersInserted: number; mailboxStored: number; ledger: ImportLedgerEntry[] }>((db) => {
      // 幂等短路:全部来源摘要已在账本 → 无副作用返回(单事务只 COMMIT 空写)。
      const existing = new Set<string>();
      for (const row of db.prepare('SELECT kind, source_sha256 FROM import_ledger').iterate()) {
        const r = row as { kind: string; source_sha256: string };
        existing.add(`${r.kind}\u0000${r.source_sha256}`);
      }
      const pending = inventory.sources.filter((ref) => !existing.has(`${ref.kind}\u0000${ref.sha256}`));
      if (pending.length === 0) return { idempotent: true, usersInserted: 0, mailboxStored: 0, ledger: [] };
      // users:插入 migratable/ok 子集(already_present 不重插)。
      for (const rec of users) {
        db.prepare('INSERT INTO auth_users (username, role, salt, hash, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(rec.username, rec.role, rec.salt, rec.hash, rec.created_at);
      }
      // auth_meta 不变量:user_count 必等于 auth_users 行数;initialized=1 要求 ≥1 用户(仅在有插入时置位)。
      if (users.length > 0) {
        db.prepare('UPDATE auth_meta SET user_count = user_count + ?, initialized = 1 WHERE id = 1').run(users.length);
      }
      // mailbox:offerInTransaction 存 stored_at=now、expires_at=原 exp(绝不延长);非 'stored' 即回滚。
      let mailboxStored = 0;
      for (const env of envelopes) {
        const encoded = encodeCustody(env);
        if (!encoded) throw new Error('mailbox envelope unencodable during import; refusing partial import');
        const offered = offerInTransaction(db, encoded, now, limits);
        if (offered !== 'stored') throw new Error(`mailbox custody offer rejected (${offered}) during import; refusing partial import`);
        mailboxStored += 1;
      }
      // 账本:仅对未入账来源追加(幂等键 kind+sha256;重复插入会触发 PK 违反 → 回滚)。
      const ledger: ImportLedgerEntry[] = [];
      for (const ref of pending) {
        const entry: ImportLedgerEntry = {
          source_sha256: ref.sha256, kind: ref.kind, imported_at: importedAt, ...ledgerCounts(ref.kind, inventory),
        };
        insertImportLedger(db, entry);
        ledger.push(entry);
      }
      return { idempotent: false, usersInserted: users.length, mailboxStored, ledger };
    });
    return { targetPath, ...result };
  } finally {
    store.close(); // COMMIT 失败已 poison;close() 仍释放 ownership 且不抛,原错误如实上抛。
  }
}
