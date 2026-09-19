/**
 * F1/P2 slice1 — `qlong migrate inspect` 的 IO 层(DATA-MIGRATION.md §5/§7)。
 * readMigrationSources: FS 只读读源文件字节;缺失即视为不存在,**绝不创建/修改/删除**任何源文件
 *   (尤其绝不写 `initialized`——区别于 legacy AuthService.loadUsers() 缺 marker 时的 writeExclusive 写源)。
 * readTargetSnapshot: raw `DatabaseSync({readOnly:true})` 只读目标 center.sqlite;**绝不用 SqliteStore.open**——
 *   它总会 applyMigrations + 取独占 ownership 锁,违反 dry-run 只读铁律(镜像 server-custody-helpers.inspectSql)。
 * formatInventory: 人类可读文本(各类计数 + 逐条 reason);**绝不含 salt/hash/私钥**——Inventory 结构本就无凭据字段。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  Counts, FileSource, Inventory, MigrationClass, MigrationSources, TargetCustody, TargetNode, TargetSnapshot, TargetUser,
} from './inspect.js';
import type { UserRole } from '../../../registry/src/auth.js';
import type { NodeStatus } from '../../../registry/src/directory.js';

export interface SourcePaths { authDir?: string; mailboxFile?: string }

/** storage/migrations.ts: PRAGMA application_id 固定为 'QLNG';不符即非 qlong 库。 */
const QLONG_APPLICATION_ID = 0x514c4e47;

/** 只读读一个源文件;缺失(ENOENT)→ undefined(不抛、不创建),其他 IO 错误上抛。 */
function readSource(path: string): FileSource | undefined {
  try {
    return { path, bytes: readFileSync(path) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** dry-run 只读盘点三类旧源;缺任一源即视为不存在(不抛),绝不修改源目录。 */
export function readMigrationSources(paths: SourcePaths): MigrationSources {
  const sources: MigrationSources = {};
  if (paths.authDir !== undefined) {
    const users = readSource(join(paths.authDir, 'users.json'));
    if (users !== undefined) sources.usersJson = users;
    const marker = readSource(join(paths.authDir, 'initialized'));
    if (marker !== undefined) sources.initializedMarker = marker;
  }
  if (paths.mailboxFile !== undefined) {
    const mailbox = readSource(paths.mailboxFile);
    if (mailbox !== undefined) sources.mailbox = mailbox;
  }
  return sources;
}

/**
 * 只读目标库快照。缺失 → 空快照(全新导入目标);存在但非 qlong 中心库 → 抛出可解释错误
 * (诚实:绝不把误指的库当空库,以免 slice2 误判为可安全导入)。
 */
export function readTargetSnapshot(path: string): TargetSnapshot {
  if (!existsSync(path)) {
    return { path, schemaId: '', version: 0, initialized: false, users: [], custody: [], nodes: [] };
  }
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 25 });
  try {
    const applicationId = Number(db.prepare('PRAGMA application_id').get()?.application_id ?? 0);
    if (applicationId !== QLONG_APPLICATION_ID) {
      throw new Error(`目标库不是 qlong 中心数据库(application_id=${applicationId}): ${path}`);
    }
    const storage = db.prepare('SELECT schema_id FROM _qlong_storage WHERE id = 1').get() as { schema_id?: unknown } | undefined;
    const schemaId = typeof storage?.schema_id === 'string' ? storage.schema_id : '';
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    const meta = db.prepare('SELECT initialized FROM auth_meta WHERE id = 1').get() as { initialized?: unknown } | undefined;
    const initialized = meta?.initialized === 1;
    const users = db.prepare('SELECT username, role, salt, hash, created_at FROM auth_users ORDER BY rowid').all()
      .map((row): TargetUser => ({
        username: String(row.username), role: String(row.role) as UserRole, created_at: String(row.created_at),
        salt: String(row.salt), hash: String(row.hash),
      }));
    const custody = db.prepare('SELECT from_node, msg_id, digest FROM gateway_custody ORDER BY rowid').all()
      .map((row): TargetCustody => ({ from_node: String(row.from_node), msg_id: String(row.msg_id), digest: String(row.digest) }));
    const nodes: TargetNode[] = [];
    for (const row of db.prepare('SELECT record FROM registry_nodes ORDER BY rowid').all()) {
      const rec = JSON.parse(String(row.record)) as { node_id?: unknown; team_id?: unknown; status?: unknown; keys?: unknown };
      if (typeof rec.node_id !== 'string') continue;
      const keys = Array.isArray(rec.keys)
        ? rec.keys.flatMap((entry) => {
          const k = entry as { epoch?: unknown; pubkey?: unknown };
          return typeof k.epoch === 'number' && typeof k.pubkey === 'string' ? [{ epoch: k.epoch, pubkey: k.pubkey }] : [];
        })
        : [];
      nodes.push({
        node_id: rec.node_id, team_id: typeof rec.team_id === 'string' ? rec.team_id : '',
        status: (typeof rec.status === 'string' ? rec.status : 'active') as NodeStatus, keys,
      });
    }
    return { path, schemaId, version, initialized, users, custody, nodes };
  } finally {
    db.close();
  }
}

const CLASS_LABEL: Record<MigrationClass, string> = {
  migratable: '可迁', conflict: '冲突', blocked: '阻断', non_migratable: '不可迁', invalid: '非法',
};
const CLASS_ORDER = Object.keys(CLASS_LABEL) as MigrationClass[];
const countsLine = (counts: Counts): string => CLASS_ORDER.map((c) => `${CLASS_LABEL[c]}=${counts[c]}`).join('  ');

/** 人类可读盘点(dry-run);Inventory 无凭据字段,故输出天然不含 salt/hash/私钥。 */
export function formatInventory(inv: Inventory): string {
  const t = inv.target;
  const lines: string[] = [];
  lines.push('迁移盘点 (dry-run 只读)');
  lines.push(`目标: ${t.path}  schema=${t.schema_id || '(缺失)'} v${t.version}  initialized=${t.initialized}  现有 users=${t.existing_users} custody=${t.existing_custody}`);
  if (inv.sources.length > 0) {
    lines.push('', '源文件:');
    for (const s of inv.sources) lines.push(`  [${s.kind}] ${s.path}  sha256=${s.sha256}`);
  }
  lines.push('', `初始化标记: present=${inv.initialized.present} valid=${inv.initialized.valid}${inv.initialized.reason !== undefined ? ` reason=${inv.initialized.reason}` : ''}`);
  lines.push('', `用户 (users.json):  ${countsLine(inv.users.counts)}`);
  if (inv.users.fileError !== undefined) lines.push(`  文件错误: ${inv.users.fileError.reason}`);
  for (const r of inv.users.records) {
    lines.push(`  - ${r.username ?? '(无用户名)'}  ${r.role ?? '?'}  ${r.created_at ?? '?'}  ${r.class}/${r.reason}${r.digest !== undefined ? `  digest=${r.digest}` : ''}`);
  }
  lines.push('', `邮箱 (mailbox):  ${countsLine(inv.mailbox.counts)}`);
  if (inv.mailbox.fileError !== undefined) lines.push(`  文件错误: ${inv.mailbox.fileError.reason}`);
  for (const e of inv.mailbox.entries) {
    lines.push(`  - box=${e.box} from=${e.from_node ?? '?'} msg=${e.msg_id ?? '?'}  ${e.class}/${e.reason}${e.digest !== undefined ? `  digest=${e.digest}` : ''}`);
  }
  return lines.join('\n');
}
