import { isUuid, newId } from '@qlong/core';
import { StorageError, type SqliteStore } from '../../storage/src/index.js';

/**
 * SqliteCommandStore(E3a):owner 命令队列的中心侧持久存储(设计 docs/repair/OWNER-COMMAND.md §4.1)。
 *
 * 命令是 owner→中心→牵头节点的**耐久控制意图**(cancel/redispatch)。与 SqliteClaimStore/SqliteCustodyStore
 * 同为中心侧操作表(列式 + SQL CHECK,无 FK——队列是运维实体而非引用实体,且节点吊销/ prune 不得因悬空 FK 阻塞):
 *
 * - **耐久**(§1.1):pending 命令静置中心,节点离线/重启后经周期 PULL 续拉;**pending 永不删**(存储铁律 §1.5)。
 * - **防伪造**(§1.2):`pendingFor`/`ack` 皆按 `lead` 过滤——节点只能取/确认路由到自己的命令,他节点无法窃取或伪造。
 * - **at-least-once + 幂等**(§1.7):`ack` 以 `status='pending'` 为栅栏,重复 ack 返回 false;节点崩溃在 ack 前
 *   → 命令重拉重应用,由节点侧机器守卫保证幂等。
 * - **损坏 fail-closed**:构造时校验全表(结构 + 跨字段不变量 pending⟺无 acked_at),违反即抛
 *   StorageError('DATABASE_CORRUPT')进入 recovery,绝不静默重建(同 claim-store.ts:14/custody-store.ts:43)。
 * - **GC 只回收 acked 且过保留窗口的命令**,绝不触碰 pending;删除前先 load 校验,损坏不被 GC 掩盖(镜像 claim reapExpired)。
 *
 * 不拥有/关闭 storage(同 SqliteClaimStore/SqliteCustodyStore)。
 */

/** Schema fragment only. The center must append a migration (v4) before constructing the store. */
export const COMMAND_SQL = `
CREATE TABLE registry_commands (
  id TEXT NOT NULL CHECK (length(id) = 36),
  team_id TEXT NOT NULL CHECK (length(team_id) = 36),
  lead TEXT NOT NULL CHECK (length(lead) = 36),
  task_id TEXT NOT NULL CHECK (length(task_id) = 36),
  kind TEXT NOT NULL CHECK (kind IN ('cancel', 'redispatch')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'acked')),
  created_at TEXT NOT NULL,
  acked_at TEXT,
  PRIMARY KEY (id),
  CHECK ((status = 'pending' AND acked_at IS NULL) OR (status = 'acked' AND acked_at IS NOT NULL))
) STRICT;
-- 节点 PULL 热路径:按 (lead, status) 取 pending,FIFO 排序 (created_at, id)。
CREATE INDEX registry_commands_pending ON registry_commands(lead, status, created_at, id);
`;

export type CommandKind = 'cancel' | 'redispatch';
export type CommandStatus = 'pending' | 'acked';

/** owner 命令记录(由列投影;中心持久,节点 PULL/ack 的契约对象)。 */
export interface CommandRecord {
  id: string;
  team_id: string;
  /** 路由目标 = 牵头节点 node_id(命令必须抵达它由 lead 事务化执行,§1.4)。 */
  lead: string;
  task_id: string;
  kind: CommandKind;
  status: CommandStatus;
  /** ISO-8601 UTC;FIFO 排序键(字典序=时间序)。 */
  created_at: string;
  acked_at?: string;
}

/** enqueue 输入(owner 路由调用;id/created_at/status 由 store 生成)。 */
export interface CommandInput {
  team_id: string;
  lead: string;
  task_id: string;
  kind: CommandKind;
}

function requireValid(condition: unknown): asserts condition {
  // Never include persisted values in recovery errors.
  if (!condition) throw new StorageError('DATABASE_CORRUPT', 'Invalid command state; explicit recovery required');
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000;
}

function validKind(value: unknown): value is CommandKind {
  return value === 'cancel' || value === 'redispatch';
}

function validStatus(value: unknown): value is CommandStatus {
  return value === 'pending' || value === 'acked';
}

/** RFC3339/ISO-8601 UTC 时间戳,拒绝 Date.parse 的日历回滚与本地时区猜测(同 state-store timestamp 校验)。 */
function validIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** 校验持久命令行并投影为 CommandRecord;损坏即 fail-closed(绝不静默跳过或伪造)。 */
function load(raw: Record<string, unknown>): CommandRecord {
  const ackedAt = raw.acked_at;
  const noAck = ackedAt === null || ackedAt === undefined;
  requireValid(
    isUuid(raw.id) && isUuid(raw.team_id) && isUuid(raw.lead) && isUuid(raw.task_id) &&
    validKind(raw.kind) && validStatus(raw.status) && validIso(raw.created_at) &&
    (noAck || validIso(ackedAt)) &&
    // 跨字段不变量:pending ⟺ 无 acked_at;acked ⟺ 有 acked_at(与 SQL CHECK 同构,应用层复核)。
    ((raw.status === 'pending' && noAck) || (raw.status === 'acked' && typeof ackedAt === 'string')),
  );
  const rec: CommandRecord = {
    id: raw.id as string,
    team_id: raw.team_id as string,
    lead: raw.lead as string,
    task_id: raw.task_id as string,
    kind: raw.kind as CommandKind,
    status: raw.status as CommandStatus,
    created_at: raw.created_at as string,
  };
  if (typeof ackedAt === 'string') rec.acked_at = ackedAt;
  return rec;
}

export class SqliteCommandStore {
  constructor(private readonly store: SqliteStore) {
    // Fail-closed on any corrupt/inconsistent row before serving: recovery, never silent rebuild.
    store.transaction((db) => {
      for (const raw of db.prepare('SELECT * FROM registry_commands').iterate()) {
        load(raw as Record<string, unknown>);
      }
    });
  }

  /** owner 路由受理一条命令:生成 id/created_at,持久为 pending;返回完整记录供 202 响应。 */
  enqueue(input: CommandInput, now: number): CommandRecord {
    if (!isUuid(input.team_id) || !isUuid(input.lead) || !isUuid(input.task_id) || !validKind(input.kind)) {
      throw new TypeError('enqueue requires UUID team_id/lead/task_id and a known command kind');
    }
    if (!validTime(now)) throw new TypeError('enqueue requires a safe-integer now');
    const record: CommandRecord = {
      id: newId(),
      team_id: input.team_id,
      lead: input.lead,
      task_id: input.task_id,
      kind: input.kind,
      status: 'pending',
      created_at: new Date(now).toISOString(),
    };
    this.store.transaction((db) => {
      db.prepare(`INSERT INTO registry_commands
        (id, team_id, lead, task_id, kind, status, created_at, acked_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)`)
        .run(record.id, record.team_id, record.lead, record.task_id, record.kind, record.created_at);
    });
    return record;
  }

  /** 节点 PULL:取路由到 leadNodeId 的 pending 命令,FIFO (created_at, id),至多 limit 条。 */
  pendingFor(leadNodeId: string, limit: number): CommandRecord[] {
    if (!isUuid(leadNodeId)) return [];
    if (!Number.isSafeInteger(limit) || limit < 1) return [];
    return this.store.transaction<CommandRecord[]>((db) => {
      const rows = db.prepare(`SELECT * FROM registry_commands
        WHERE lead = ? AND status = 'pending' ORDER BY created_at, id LIMIT ?`).all(leadNodeId, limit);
      return rows.map((raw) => load(raw as Record<string, unknown>));
    });
  }

  /**
   * 节点确认命令已应用:以 (id, lead, status='pending') 为栅栏置 acked + acked_at。
   * 被 fence(他节点/已 ack/不存在)返回 false;幂等——重复 ack 不产生第二次副作用。
   */
  ack(commandId: string, leadNodeId: string, now: number): boolean {
    if (!isUuid(commandId) || !isUuid(leadNodeId) || !validTime(now)) return false;
    const ackedAt = new Date(now).toISOString();
    return this.store.transaction<boolean>((db) =>
      db.prepare(`UPDATE registry_commands SET status = 'acked', acked_at = ?
        WHERE id = ? AND lead = ? AND status = 'pending'`).run(ackedAt, commandId, leadNodeId).changes === 1);
  }

  /**
   * 回收已 ack 且过保留窗口的命令(acked_at < now-retentionMs);**pending 永不删**(存储铁律)。
   * 删除前先 load 校验,损坏不被 GC 掩盖(镜像 claim reapExpired / custody prune)。返回删除条数。
   */
  prune(now: number, retentionMs: number): number {
    if (!validTime(now) || !Number.isSafeInteger(retentionMs) || retentionMs < 0) return 0;
    const cutoff = new Date(now - retentionMs).toISOString();
    return this.store.transaction<number>((db) => {
      const rows = db.prepare(`SELECT * FROM registry_commands
        WHERE status = 'acked' AND acked_at < ? ORDER BY rowid`).all(cutoff);
      // Validate before delete: corruption must not be concealed by GC.
      for (const raw of rows) load(raw as Record<string, unknown>);
      return Number(db.prepare(`DELETE FROM registry_commands WHERE status = 'acked' AND acked_at < ?`).run(cutoff).changes);
    });
  }
}
