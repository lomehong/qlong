/**
 * F1/P2 slice1 — `qlong migrate inspect` 的纯盘点逻辑(DATA-MIGRATION.md §4/§5)。
 * dry-run 只读:接收**已读入的源字节** + **目标库只读快照** + 时钟,输出可迁/冲突/阻断/不可迁/非法
 * 五类分类与摘要;绝不写任何文件/库,绝不输出凭据(salt/hash/私钥)。
 * 独立解析(不复用 legacy loader):AuthService.loadUsers()/InboxStore.load() 会吞损坏、且前者缺 marker 时写源。
 */
import { createHash } from 'node:crypto';
import {
  envelopeDigest, fromBase64, jcs, MAX_TRANSPORT_LIFETIME_MS, validateEnvelope, verifyEnvelopeSig,
} from '@qlong/core';
import { isUserRole, parseUserRecord } from '../../../registry/src/auth-store.js';
import type { UserRole } from '../../../registry/src/auth.js';
import type { NodeStatus } from '../../../registry/src/directory.js';

export type MigrationClass = 'migratable' | 'conflict' | 'blocked' | 'non_migratable' | 'invalid';

/** 已读入的源文件(原始字节;inspect 从中计算 sha256 来源摘要并独立解析)。 */
export interface FileSource { path: string; bytes: Uint8Array }
export interface MigrationSources {
  usersJson?: FileSource;        // QLONG_AUTH_DIR/users.json
  initializedMarker?: FileSource; // QLONG_AUTH_DIR/initialized
  mailbox?: FileSource;          // QLONG_MAILBOX_FILE
}

/** 目标中心库只读快照(由 IO 层读取,纯函数不触库)。 */
export interface TargetUser { username: string; role: UserRole; created_at: string; salt: string; hash: string }
export interface TargetCustody { from_node: string; msg_id: string; digest: string }
export interface TargetNodeKey { epoch: number; pubkey: string }
export interface TargetNode { node_id: string; team_id: string; status: NodeStatus; keys: TargetNodeKey[] }
export interface TargetSnapshot {
  path: string; schemaId: string; version: number; initialized: boolean;
  users: TargetUser[]; custody: TargetCustody[]; nodes: TargetNode[];
}

export interface Finding { class: MigrationClass; reason: string }
export interface UserFinding extends Finding { username?: string; role?: UserRole; created_at?: string; digest?: string }
export interface MailboxFinding extends Finding { box: string; msg_id?: string; from_node?: string; to_node?: string; digest?: string }
export interface SourceRef { path: string; kind: 'users' | 'initialized' | 'mailbox'; sha256: string }
export type Counts = Record<MigrationClass, number>;
export interface Inventory {
  sources: SourceRef[];
  users: { counts: Counts; records: UserFinding[]; fileError?: Finding };
  mailbox: { counts: Counts; entries: MailboxFinding[]; fileError?: Finding };
  initialized: { present: boolean; valid: boolean; reason?: string };
  target: { path: string; schema_id: string; version: number; initialized: boolean; existing_users: number; existing_custody: number };
}

const emptyCounts = (): Counts => ({ migratable: 0, conflict: 0, blocked: 0, non_migratable: 0, invalid: 0 });
function bump(counts: Counts, cls: MigrationClass): Counts { counts[cls] += 1; return counts; }
const sha256Bytes = (b: Uint8Array): string => createHash('sha256').update(Buffer.from(b)).digest('hex');
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
/** 摘要只覆盖非凭据字段(§4):排除 salt/hash,永不外泄 scrypt 凭据。 */
const userDigest = (u: { username: string; role: UserRole; created_at: string }): string =>
  createHash('sha256').update(jcs({ username: u.username, role: u.role, created_at: u.created_at }), 'utf8').digest('hex');
const utf8 = (b: Uint8Array): string => Buffer.from(b).toString('utf8');
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/**
 * parseUserRecord 是准入权威;此诊断仅在其拒绝后**标注**具体原因(不参与接受/拒绝判定,
 * 因此即便与权威规则漂移也只影响标签、不影响正确性)。校验顺序镜像 parseUserRecord。
 */
function diagnoseUser(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'bad_record';
  const u = raw as Record<string, unknown>;
  if (typeof u.username !== 'string' || u.username.length < 3) return 'bad_username';
  if (typeof u.salt !== 'string' || !/^[a-f0-9]{32}$/i.test(u.salt)) return 'bad_salt';
  if (typeof u.hash !== 'string' || !/^[a-f0-9]{128}$/i.test(u.hash)) return 'bad_hash';
  if (typeof u.created_at !== 'string' || !Number.isFinite(Date.parse(u.created_at))) return 'bad_created_at';
  if (Object.prototype.hasOwnProperty.call(u, 'role') && !isUserRole(u.role)) return 'bad_role';
  return 'bad_record';
}

/** 离线复刻 Registry.lookupPubkey(directory.ts:384):仅 active 节点、current|historical 纪元可解析。 */
export function lookupNodeKey(nodes: TargetNode[], nodeId: string, epoch: number):
  { status: 'current' | 'historical'; pubkey: string } | { status: 'node_unknown' | 'node_inactive' | 'unknown_epoch' } {
  const node = nodes.find((n) => n.node_id === nodeId);
  if (!node) return { status: 'node_unknown' };
  if (node.status !== 'active') return { status: 'node_inactive' };
  const current = node.keys[node.keys.length - 1];
  if (current && epoch === current.epoch) return { status: 'current', pubkey: current.pubkey };
  const hit = node.keys.find((k) => k.epoch === epoch);
  return hit ? { status: 'historical', pubkey: hit.pubkey } : { status: 'unknown_epoch' };
}

function classifyUsers(src: FileSource | undefined, target: TargetSnapshot): Inventory['users'] {
  const counts = emptyCounts();
  const records: UserFinding[] = [];
  if (!src) return { counts, records };
  let parsed: unknown;
  try { parsed = JSON.parse(utf8(src.bytes)); } catch {
    return { counts: bump(counts, 'invalid'), records, fileError: { class: 'invalid', reason: 'malformed_json' } };
  }
  if (!Array.isArray(parsed)) {
    return { counts: bump(counts, 'invalid'), records, fileError: { class: 'invalid', reason: 'not_an_array' } };
  }
  const seen = new Set<string>();
  const targetUsers = new Map(target.users.map((u) => [u.username, u]));
  for (const raw of parsed) {
    const rec = parseUserRecord(raw, true); // 旧文件可推断单管理员缺省 role=global_owner(§1)
    if (!rec) {
      records.push({ class: 'invalid', reason: diagnoseUser(raw), username: str(asRecord(raw).username) });
      bump(counts, 'invalid');
      continue;
    }
    const base = { username: rec.username, role: rec.role, created_at: rec.created_at, digest: userDigest(rec) };
    // 目标 readSnapshot 不变量:created_at 必须是规范 ISO(否则导入后目标库不可读)。
    if (new Date(rec.created_at).toISOString() !== rec.created_at) {
      records.push({ ...base, class: 'invalid', reason: 'non_canonical_created_at' }); bump(counts, 'invalid'); continue;
    }
    if (seen.has(rec.username)) {
      records.push({ ...base, class: 'invalid', reason: 'duplicate_username' }); bump(counts, 'invalid'); continue;
    }
    seen.add(rec.username);
    const existing = targetUsers.get(rec.username);
    if (existing) {
      const same = existing.role === rec.role && existing.created_at === rec.created_at
        && existing.salt === rec.salt && existing.hash === rec.hash;
      records.push(same ? { ...base, class: 'migratable', reason: 'already_present' } : { ...base, class: 'conflict', reason: 'target_conflict' });
      bump(counts, same ? 'migratable' : 'conflict');
      continue;
    }
    records.push({ ...base, class: 'migratable', reason: 'ok' }); bump(counts, 'migratable');
  }
  return { counts, records };
}

async function classifyMailbox(src: FileSource | undefined, target: TargetSnapshot, now: number): Promise<Inventory['mailbox']> {
  const counts = emptyCounts();
  const entries: MailboxFinding[] = [];
  if (!src) return { counts, entries };
  let parsed: unknown;
  try { parsed = JSON.parse(utf8(src.bytes)); } catch {
    return { counts: bump(counts, 'invalid'), entries, fileError: { class: 'invalid', reason: 'malformed_json' } };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { counts: bump(counts, 'invalid'), entries, fileError: { class: 'invalid', reason: 'malformed_json' } };
  }
  const file = parsed as Record<string, unknown>;
  if (file.v !== 1) return { counts: bump(counts, 'invalid'), entries, fileError: { class: 'invalid', reason: 'bad_version' } };
  if (!Array.isArray(file.boxes)) {
    return { counts: bump(counts, 'invalid'), entries, fileError: { class: 'invalid', reason: 'malformed_json' } };
  }
  const seen = new Set<string>();
  const targetCustody = new Map(target.custody.map((c) => [`${c.from_node}\u0000${c.msg_id}`, c.digest]));
  for (const rawBox of file.boxes) {
    const box = asRecord(rawBox);
    const boxId = str(box.nodeId) ?? '(unknown)';
    const boxEntries = Array.isArray(box.entries) ? box.entries : [];
    for (const rawEntry of boxEntries) {
      const entry = asRecord(rawEntry);
      const checked = validateEnvelope(entry.envelope);
      if (!checked.ok) {
        entries.push({ box: boxId, msg_id: str(entry.msgId), class: 'invalid', reason: 'invalid_envelope' });
        bump(counts, 'invalid'); continue;
      }
      const env = checked.value;
      const key = `${env.from.node_id}\u0000${env.msg_id}`;
      const digest = envelopeDigest(env);
      const base = { box: boxId, msg_id: env.msg_id, from_node: env.from.node_id, to_node: env.to.node_id, digest };
      if (seen.has(key)) { entries.push({ ...base, class: 'invalid', reason: 'duplicate_msg' }); bump(counts, 'invalid'); continue; }
      seen.add(key);
      // 稳定身份优先于时间与验签(镜像 custody.offer:existing 先于 expired/quota)。
      const existingDigest = targetCustody.get(key);
      if (existingDigest !== undefined) {
        const same = existingDigest === digest;
        entries.push(same ? { ...base, class: 'migratable', reason: 'already_present' } : { ...base, class: 'conflict', reason: 'target_conflict' });
        bump(counts, same ? 'migratable' : 'conflict'); continue;
      }
      const lookup = lookupNodeKey(target.nodes, env.from.node_id, env.from.key_epoch);
      if (lookup.status !== 'current' && lookup.status !== 'historical') {
        entries.push({ ...base, class: 'blocked', reason: lookup.status }); bump(counts, 'blocked'); continue;
      }
      const verified = await verifyEnvelopeSig(env, () => fromBase64(lookup.pubkey))
        .catch(() => ({ ok: false as const, reason: 'bad_sig' as const }));
      if (!verified.ok) { entries.push({ ...base, class: 'invalid', reason: verified.reason }); bump(counts, 'invalid'); continue; }
      const expMs = typeof env.exp === 'string' ? Date.parse(env.exp) : NaN;
      if (!Number.isFinite(expMs)) { entries.push({ ...base, class: 'invalid', reason: 'bad_exp' }); bump(counts, 'invalid'); continue; }
      // 不延 exp:用信封原 exp 判定(镜像 custody.offer:now≥exp→expired;exp-now>24h→不可迁)。
      if (now >= expMs) { entries.push({ ...base, class: 'non_migratable', reason: 'expired' }); bump(counts, 'non_migratable'); continue; }
      if (expMs - now > MAX_TRANSPORT_LIFETIME_MS) { entries.push({ ...base, class: 'non_migratable', reason: 'lifetime_exceeded' }); bump(counts, 'non_migratable'); continue; }
      entries.push({ ...base, class: 'migratable', reason: 'ok' }); bump(counts, 'migratable');
    }
  }
  return { counts, entries };
}

function classifyMarker(src: FileSource | undefined): Inventory['initialized'] {
  if (!src) return { present: false, valid: false, reason: 'absent' };
  const valid = utf8(src.bytes) === 'initialized-v1\n';
  return { present: true, valid, reason: valid ? undefined : 'bad_marker' };
}

function buildSources(sources: MigrationSources): SourceRef[] {
  const out: SourceRef[] = [];
  if (sources.usersJson) out.push({ path: sources.usersJson.path, kind: 'users', sha256: sha256Bytes(sources.usersJson.bytes) });
  if (sources.initializedMarker) out.push({ path: sources.initializedMarker.path, kind: 'initialized', sha256: sha256Bytes(sources.initializedMarker.bytes) });
  if (sources.mailbox) out.push({ path: sources.mailbox.path, kind: 'mailbox', sha256: sha256Bytes(sources.mailbox.bytes) });
  return out;
}

/** 纯盘点:不触文件系统/数据库,可对内存夹具确定性重放。 */
export async function inspectMigration(sources: MigrationSources, target: TargetSnapshot, now: number): Promise<Inventory> {
  return {
    sources: buildSources(sources),
    users: classifyUsers(sources.usersJson, target),
    mailbox: await classifyMailbox(sources.mailbox, target, now),
    initialized: classifyMarker(sources.initializedMarker),
    target: {
      path: target.path, schema_id: target.schemaId, version: target.version,
      initialized: target.initialized, existing_users: target.users.length, existing_custody: target.custody.length,
    },
  };
}
