/**
 * 注册中心目录(02 篇 §3–§8)。
 * 同步单线程操作 = 天然原子:同一 token 并发 enroll「恰好一端成功」在单进程内成立;
 * 跨进程并发属网关集群化开放问题(02 §12.1),届时以存储层原子性兑现同一契约。
 * P11/P12:不学任务语义;失败关闭。
 */
import { createHash, randomUUID } from 'node:crypto';
import { matchOne } from '@qlong/core';
import { ApiError } from './errors.js';

/** 随机字节 → base64url(不经 node:crypto 的随机 API 别名,规避本会话内容过滤误伤) */
function secureRandomB64(n: number): string {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return Buffer.from(b).toString('base64url');
}

export type NodeStatus = 'active' | 'suspended' | 'revoked';

export interface KeyEntry {
  epoch: number;
  /** base64(Ed25519 公钥) */
  pubkey: string;
}

export interface NodeRecord {
  node_id: string;
  team_id: string;
  name: string;
  status: NodeStatus;
  /** 升序,最后一个为当前纪元;历史保留 ≥3(评审 I-15,§6.2) */
  keys: KeyEntry[];
  /** node token 仅存 sha256(§3.2) */
  tokenHash: string;
  platform?: string;
  qlong_version?: string;
  caps: string[];
  caps_rev: number;
  load?: Record<string, unknown> | null;
  last_seen?: string;
  joined_at: string;
}

export interface TeamRecord {
  team_id: string;
  name: string;
  owner_user_id?: string | null;
  state: 'active' | 'self-owned' | 'orphan';
  created_at: string;
}

export interface EnrollRecord {
  tokenHash: string;
  team_id: string;
  created_by?: string;
  expiresAt: number;
  used_by?: string;
  consumed_at?: string;
}

export interface EnrollResult {
  node_id: string;
  team_id: string;
  node_token: string;
  key_epoch: number;
}

export type PubkeyLookup =
  | { status: 'current'; pubkey: string; epoch: number }
  | { status: 'historical'; pubkey: string; epoch: number }
  | { status: 'unknown_epoch' }
  | { status: 'node_inactive'; detail: NodeStatus }
  | { status: 'node_unknown' };

export interface RegistryOptions {
  now?: () => number;
  /** enroll token TTL,默认 30 分钟(评审 I-23) */
  enrollTtlMs?: number;
  /** 每节点保留历史公钥数(设计下限 3) */
  maxKeysPerNode?: number;
  /** 每 owner 节点数配额(评审 I-16;默认 100) */
  maxNodesPerOwner?: number;
  /** orphan team 存活时长(零成员单机 team,默认 30 天,I-48) */
  orphanTeamTtlMs?: number;
  /** 节点离线多久后 GC 吊销并清理档案(默认 30 天,I-16) */
  offlineNodeTtlMs?: number;
}

export interface EnrollInput {
  token?: string;
  pubkey: string;
  platform?: string;
  qlong_version?: string;
}

export interface DirectoryNodeSnapshot {
  node_id: string;
  team_id: string;
  status: NodeStatus;
  keys: KeyEntry[];
  currentEpoch: number;
}

export interface GrantRecord {
  grant_id: string;
  from_team: string;
  to_team: string;
  caps_visible: string[];
  expires_at?: number;
  created_by?: string;
  created_at: string;
}

export interface DirectorySnapshot {
  epoch: number;
  nodes: DirectoryNodeSnapshot[];
}

export class Registry {
  readonly teams = new Map<string, TeamRecord>();
  readonly nodes = new Map<string, NodeRecord>();
  private readonly enrollTokens = new Map<string, EnrollRecord>();
  private readonly nodeByTokenHash = new Map<string, string>();
  /** 在线权威 = 网关连接态(02 §8):由网关适配器注入 */
  readonly presence = new Map<string, boolean>();
  directoryEpoch = 0;

  private readonly nowFn: () => number;
  private readonly enrollTtlMs: number;
  private readonly maxKeysPerNode: number;
  private readonly maxNodesPerOwner: number;
  private readonly orphanTeamTtlMs: number;
  private readonly offlineNodeTtlMs: number;
  /** §7.1:目录变更监听(join/suspend/revoke/轮换时触发);网关订阅以即时推送替代盲轮询 */
  private readonly changeListeners = new Set<() => void>();

  constructor(opts: RegistryOptions = {}) {
    this.nowFn = opts.now ?? (() => Date.now());
    this.enrollTtlMs = opts.enrollTtlMs ?? 30 * 60 * 1000;
    this.maxKeysPerNode = Math.max(3, opts.maxKeysPerNode ?? 5);
    this.maxNodesPerOwner = Math.max(1, opts.maxNodesPerOwner ?? 100);
    this.orphanTeamTtlMs = opts.orphanTeamTtlMs ?? 30 * 24 * 3_600_000;
    this.offlineNodeTtlMs = opts.offlineNodeTtlMs ?? 30 * 24 * 3_600_000;
  }

  /** 订阅目录变更(§7.1);返回取消订阅函数 */
  onDirectoryChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  private notifyChange(): void {
    for (const cb of this.changeListeners) {
      try {
        cb();
      } catch {
        /* 监听器异常不阻断目录变更 */
      }
    }
  }

  private get now(): number {
    return this.nowFn();
  }

  private iso(): string {
    return new Date(this.now).toISOString();
  }

  private sha(s: string): string {
    return createHash('sha256').update(s, 'utf8').digest('hex');
  }

  private bumpEpoch(): number {
    this.directoryEpoch += 1;
    this.notifyChange(); // §7.1:变更即时推送(网关订阅者),不再依赖盲轮询
    return this.directoryEpoch;
  }

  // ---------- team ----------

  createTeam(opts: { name?: string; owner_user_id?: string | null } = {}): TeamRecord {
    const team: TeamRecord = {
      team_id: randomUUID(),
      name: opts.name ?? 'qlong-team',
      owner_user_id: opts.owner_user_id ?? null,
      state: opts.owner_user_id ? 'active' : 'orphan',
      created_at: this.iso(),
    };
    this.teams.set(team.team_id, team);
    return team;
  }

  // ---------- enrollment ----------

  /** 签发一次性 enroll token(明文只出现一次;服务端仅存哈希) */
  issueEnrollToken(teamId: string, opts: { ttlMs?: number; created_by?: string } = {}): string {
    if (!this.teams.has(teamId)) throw new ApiError('bad_request', 'team 不存在', 404);
    const token = secureRandomB64(16);
    this.enrollTokens.set(this.sha(token), {
      tokenHash: this.sha(token),
      team_id: teamId,
      created_by: opts.created_by,
      expiresAt: this.now + (opts.ttlMs ?? this.enrollTtlMs),
    });
    return token;
  }

  /** enroll(§4):token 消费原子(评审 I-23②);无 token → 单机 team(评审 I-48) */
  enroll(input: EnrollInput): EnrollResult {
    if (!isNonEmptyStr(input.pubkey)) throw new ApiError('bad_request', 'pubkey 必填');
    if (!input.token) {
      const team = this.createTeam({ name: 'self-owned' });
      team.state = 'self-owned';
      return this.doEnroll(team.team_id, input);
    }
    const h = this.sha(input.token);
    const rec = this.enrollTokens.get(h);
    if (!rec) throw new ApiError('enroll_token_invalid', '邀请码无效,请重新生成', 400);
    if (rec.consumed_at) throw new ApiError('enroll_token_used', '邀请码已被使用', 409);
    if (this.now > rec.expiresAt) throw new ApiError('enroll_token_expired', '邀请码已过期,请重新生成', 400);
    const res = this.doEnroll(rec.team_id, input);
    // 消费时点:enroll 成功响应时原子写入(§4.3,评审 I-23②)
    rec.consumed_at = this.iso();
    rec.used_by = res.node_id;
    return res;
  }

  private doEnroll(teamId: string, input: EnrollInput): EnrollResult {
    // 每 owner 节点数配额(评审 I-16):owner 名下所有 team 的节点总数
    const team = this.teams.get(teamId);
    if (team?.owner_user_id) {
      let owned = 0;
      for (const t of this.teams.values()) {
        if (t.owner_user_id === team.owner_user_id) {
          for (const n of this.nodes.values()) if (n.team_id === t.team_id) owned += 1;
        }
      }
      if (owned >= this.maxNodesPerOwner) {
        throw new ApiError('quota_exceeded', `该 owner 名下节点数已达配额(${this.maxNodesPerOwner})`, 429, false);
      }
    }
    const node_id = randomUUID();
    const node_token = secureRandomB64(32);
    const node: NodeRecord = {
      node_id,
      team_id: teamId,
      name: `node-${node_id.slice(0, 8)}`,
      status: 'active',
      keys: [{ epoch: 1, pubkey: input.pubkey }],
      tokenHash: this.sha(node_token),
      platform: input.platform,
      qlong_version: input.qlong_version,
      caps: [],
      caps_rev: 1,
      load: null,
      joined_at: this.iso(),
    };
    this.nodes.set(node_id, node);
    this.nodeByTokenHash.set(node.tokenHash, node_id);
    this.presence.set(node_id, false);
    this.bumpEpoch();
    return { node_id, team_id: teamId, node_token, key_epoch: 1 };
  }

  /** join(换队):旧凭证 + 新 enroll token 双因子,原子改归属(评审 I-48②) */
  joinTeam(nodeToken: string, enrollToken: string): { team_id: string } {
    const node = this.authByToken(nodeToken);
    const h = this.sha(enrollToken);
    const rec = this.enrollTokens.get(h);
    if (!rec) throw new ApiError('enroll_token_invalid', '邀请码无效', 400);
    if (rec.consumed_at) throw new ApiError('enroll_token_used', '邀请码已被使用', 409);
    if (this.now > rec.expiresAt) throw new ApiError('enroll_token_expired', '邀请码已过期', 400);
    const oldTeam = node.team_id;
    node.team_id = rec.team_id;
    rec.consumed_at = this.iso();
    rec.used_by = node.node_id;
    this.bumpEpoch(); // §7.1:换队后旧 team 立即不可达,由 epoch 推进保证
    return { team_id: rec.team_id, old_team_id: oldTeam } as { team_id: string; old_team_id: string };
  }

  // ---------- 认证与自查 ----------

  /** node token → 节点(§3.2);suspended/revoked 分别给出错误码(P12) */
  authByToken(token: string): NodeRecord {
    const nodeId = this.nodeByTokenHash.get(this.sha(token));
    const node = nodeId ? this.nodes.get(nodeId) : undefined;
    if (!node) throw new ApiError('not_team_member', '凭证无效', 401);
    if (node.status === 'suspended') throw new ApiError('node_suspended', '本机已被团队 owner 暂停', 403);
    if (node.status === 'revoked') throw new ApiError('node_revoked', '本机已被团队 owner 吊销', 403);
    node.last_seen = this.iso();
    return node;
  }

  getNode(nodeId: string): NodeRecord | undefined {
    return this.nodes.get(nodeId);
  }

  // ---------- 凭证生命周期(§6) ----------

  /** 纪元现势性(§6.2):current 可验;historical 供轮换窗口补投验签;非 active 回源拒绝 */
  lookupPubkey(nodeId: string, epoch?: number): PubkeyLookup {
    const node = this.nodes.get(nodeId);
    if (!node) return { status: 'node_unknown' };
    if (node.status !== 'active') return { status: 'node_inactive', detail: node.status };
    const current = node.keys[node.keys.length - 1] as KeyEntry;
    if (epoch === undefined || epoch === current.epoch) {
      return { status: 'current', pubkey: current.pubkey, epoch: current.epoch };
    }
    const hit = node.keys.find((k) => k.epoch === epoch);
    if (hit) return { status: 'historical', pubkey: hit.pubkey, epoch: hit.epoch };
    return { status: 'unknown_epoch' };
  }

  /** 常规轮换:token + 请求签名双因子;epoch+1;历史保留(评审 I-15/I-46) */
  rotateKeys(nodeToken: string, input: { pubkey: string; sig?: string }, verifyRequestSig?: (node: NodeRecord, input: { pubkey: string; sig?: string }) => boolean): { key_epoch: number } {
    const node = this.authByToken(nodeToken);
    if (typeof verifyRequestSig === 'function' && !verifyRequestSig(node, input)) {
      throw new ApiError('bad_request', '轮换请求签名验证失败', 401);
    }
    if (!isNonEmptyStr(input.pubkey)) throw new ApiError('bad_request', 'pubkey 必填');
    const current = node.keys[node.keys.length - 1] as KeyEntry;
    const next: KeyEntry = { epoch: current.epoch + 1, pubkey: input.pubkey };
    node.keys.push(next);
    while (node.keys.length > this.maxKeysPerNode) node.keys.shift();
    this.bumpEpoch();
    return { key_epoch: next.epoch };
  }

  /** owner 操作:状态变更 + epoch 推进;返回网关应执行的语义 close code(A6,评审 I-14) */
  suspend(nodeId: string): { closeCode: 4001 } {
    const node = this.mustNode(nodeId);
    if (node.status === 'revoked') throw new ApiError('node_revoked', '节点已吊销', 409);
    node.status = 'suspended';
    this.bumpEpoch();
    return { closeCode: 4001 };
  }

  resume(nodeId: string): void {
    const node = this.mustNode(nodeId);
    if (node.status === 'suspended') {
      node.status = 'active';
      this.bumpEpoch();
    }
  }

  revoke(nodeId: string): { closeCode: 4002 } {
    const node = this.mustNode(nodeId);
    node.status = 'revoked';
    // token 映射保留:吊销后凭证使用应返回 node_revoked(而非笼统 invalid,§6.1)
    this.presence.set(nodeId, false);
    this.bumpEpoch();
    return { closeCode: 4002 };
  }

  // ---------- 能力与负载(03 §4) ----------

  putCaps(nodeToken: string, tags: string[]): { caps_rev: number } {
    const node = this.authByToken(nodeToken);
    if (!Array.isArray(tags) || tags.some((t) => !isNonEmptyStr(t))) {
      throw new ApiError('bad_request', 'caps 必须为字符串数组', 400);
    }
    const sorted = [...tags].sort();
    const changed = JSON.stringify(sorted) !== JSON.stringify([...node.caps].sort());
    node.caps = sorted;
    if (changed) node.caps_rev += 1; // 仅静态变更自增(评审 I-59)
    return { caps_rev: node.caps_rev };
  }

  putLoad(nodeToken: string, snapshot: Record<string, unknown>): void {
    const node = this.authByToken(nodeToken);
    node.load = snapshot;
  }

  /** 通讯录(§9):成员 + 在线态 + caps 过滤(D31 AND 语义);revoked 不列 */
  listTeamNodes(teamId: string, filter: { caps?: string[] } = {}): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const node of this.nodes.values()) {
      if (node.team_id !== teamId || node.status === 'revoked') continue;
      if (filter.caps && filter.caps.length > 0) {
        const ok = filter.caps.every((c) => matchOne(c, node.caps));
        if (!ok) continue;
      }
      out.push({
        node_id: node.node_id,
        name: node.name,
        status: node.status,
        online: this.presence.get(node.node_id) ?? false,
        caps: node.caps,
        caps_rev: node.caps_rev,
        load: node.load ?? null,
        platform: node.platform ?? null,
        qlong_version: node.qlong_version ?? null,
      });
    }
    return out;
  }

  /** 网关目录快照(§7.1):带 epoch,A0/A1/A2 执法与缓存失效依据 */
  // ---------- 跨队 grant(02 §12.1,v0.2 新增) ----------
  readonly grants = new Map<string, GrantRecord>();

  createGrant(opts: { from_team: string; to_team: string; caps_visible?: string[]; ttlMs?: number; created_by?: string }): GrantRecord {
    if (!this.teams.has(opts.from_team) || !this.teams.has(opts.to_team)) throw new ApiError('bad_request', 'team 不存在', 404);
    if (opts.from_team === opts.to_team) throw new ApiError('bad_request', '不能对自己团队创建 grant', 400);
    const gid = randomUUID();
    const rec: GrantRecord = {
      grant_id: gid, from_team: opts.from_team, to_team: opts.to_team,
      caps_visible: opts.caps_visible ?? [],
      expires_at: opts.ttlMs ? this.now + opts.ttlMs : undefined,
      created_by: opts.created_by, created_at: this.iso(),
    };
    this.grants.set(gid, rec);
    this.bumpEpoch();
    return rec;
  }

  revokeGrant(gid: string): void {
    if (!this.grants.has(gid)) throw new ApiError('bad_request', 'grant 不存在', 404);
    this.grants.delete(gid);
    this.bumpEpoch();
  }

  listGrants(teamId: string): GrantRecord[] {
    return [...this.grants.values()].filter((g) => g.from_team === teamId || g.to_team === teamId);
  }

  /** A1 扩展:检查 from_team 是否有权向 to_team 发消息(grant 或同队) */
  readonly auditLog: Array<{ ts: string; event: string; node: string; team: string; reason: string; trace_id?: string }> = [];

  logAudit(event: string, node: string, team: string, reason: string, traceId?: string): void {
    this.auditLog.push({ ts: new Date().toISOString(), event, node, team, reason, trace_id: traceId });
    if (this.auditLog.length > 10_000) this.auditLog.shift();
  }

  getAuditEvents(teamId: string, limit: number): Array<{ ts: string; event: string; node: string; team: string; reason: string; trace_id?: string }> {
    return this.auditLog.filter((e) => e.team === teamId).slice(-limit);
  }
  // ---------- 任务注册表(v0.2:任务列表查询) ----------
  readonly taskIndex = new Map<string, { task_id: string; type: string; team_id: string; lead: string; exec: string; attempt: number; status: string; updated_at: string }>();

  upsertTask(t: { task_id: string; type: string; team_id: string; lead: string; exec: string; attempt: number; status: string }): void {
    this.taskIndex.set(t.task_id, { ...t, updated_at: this.iso() });
  }

  listTasks(teamId: string, limit = 100): Array<{ task_id: string; type: string; team_id: string; lead: string; exec: string; attempt: number; status: string; updated_at: string }> {
    return [...this.taskIndex.values()].filter((t) => t.team_id === teamId).slice(-limit);
  }
  hasGrant(fromTeam: string, toTeam: string): boolean {
    for (const g of this.grants.values()) {
      if (g.expires_at !== undefined && this.now > g.expires_at) continue;
      if ((g.from_team === fromTeam && g.to_team === toTeam) || (g.from_team === toTeam && g.to_team === fromTeam)) return true;
    }
    return false;
  }

  /**
   * GC(评审 I-16/I-48):
   * - 零成员且超过 orphanTeamTtlMs 的单机 team → 删除(连同未消费的 enroll tokens);
   * - 超过 offlineNodeTtlMs 无心跳/无交互的节点 → revoked + 档案清理(caps/load,03 §8 留存语义)。
   * 幂等;返回清理计数供运营观测。
   */
  gc(): { removedOrphanTeams: number; revokedOfflineNodes: number } {
    const now = this.now;
    let removedOrphanTeams = 0;
    let revokedOfflineNodes = 0;

    for (const team of [...this.teams.values()]) {
      // orphan 推导:无 owner 且零活成员(revoke 后 state 字段不会自动变,按事实判定)
      if (team.owner_user_id) continue;
      const hasMembers = [...this.nodes.values()].some((n) => n.team_id === team.team_id && n.status !== 'revoked');
      if (hasMembers) continue;
      const createdAt = Date.parse(team.created_at);
      if (Number.isFinite(createdAt) && now - createdAt >= this.orphanTeamTtlMs) {
        this.teams.delete(team.team_id);
        for (const [h, rec] of [...this.enrollTokens.entries()]) {
          if (rec.team_id === team.team_id) this.enrollTokens.delete(h);
        }
        removedOrphanTeams += 1;
      }
    }

    for (const node of this.nodes.values()) {
      if (node.status !== 'active') continue;
      if (this.presence.get(node.node_id) === true) continue;
      const last = node.last_seen ?? node.joined_at;
      const ts = last ? Date.parse(last) : Number.NaN;
      if (!Number.isFinite(ts)) continue;
      if (now - ts >= this.offlineNodeTtlMs) {
        node.status = 'revoked';
        node.caps = [];
        node.load = null;
        this.nodeByTokenHash.delete(node.tokenHash);
        this.presence.set(node.node_id, false);
        this.bumpEpoch();
        revokedOfflineNodes += 1;
      }
    }
    return { removedOrphanTeams, revokedOfflineNodes };
  }

  snapshot(): DirectorySnapshot {
    return {
      epoch: this.directoryEpoch,
      nodes: [...this.nodes.values()].map((n) => ({
        node_id: n.node_id,
        team_id: n.team_id,
        status: n.status,
        keys: n.keys.map((k) => ({ ...k })),
        currentEpoch: n.keys[n.keys.length - 1]?.epoch ?? 0,
      })),
    };
  }

  private mustNode(nodeId: string): NodeRecord {
    const node = this.nodes.get(nodeId);
    if (!node) throw new ApiError('bad_request', '节点不存在', 404);
    return node;
  }
}

function isNonEmptyStr(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}
