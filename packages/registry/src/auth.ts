/**
 * 人类账号与会话(02 §3.1/§3.2 的"产品侧"最小实现)。
 * - 人:用户名 + 密码(scrypt 加盐哈希);登录 → HttpOnly 会话 Cookie;
 * - Agent/节点:node token + Ed25519(02 §3.2)——两套凭证严格分离,人的登录与节点凭证互不相干;
 * - 首个管理员显式为 global_owner;普通 user 仅能管理 owner_user_id 匹配自己的团队;
 * - CSRF:Cookie 会话的所有变更请求必须携带会话级 X-CSRF-Token。
 * 可借用服务级 SQLite 持久化账号/会话,权限以当前用户为准;旧文件模式仅留作显式迁移兼容。
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqliteStore } from '../../storage/src/index.js';
import { AuthStore, isUserRole, parseUserRecord } from './auth-store.js';

export const SESSION_COOKIE = 'qlong_session';
const INITIALIZED_MARKER = 'initialized-v1\n';

export type UserRole = 'global_owner' | 'user';

export interface UserRecord {
  username: string;
  role: UserRole;
  salt: string;
  hash: string;
  created_at: string;
}

export interface SessionRecord {
  username: string;
  /** 签发时角色快照;session() 必须按当前用户角色重新验证,不能据此保留旧权限。 */
  role: UserRole;
  csrf: string;
  expiresAt: number;
}

export interface AuthOptions {
  now?: () => number;
  /** 会话时长(默认 7 天) */
  sessionTtlMs?: number;
  /** 服务持有的共享 SQLite;本服务不打开/迁移/关闭连接。 */
  storage?: SqliteStore;
  /** 旧文件兼容模式,不能与 storage 同用;生产切换必须显式迁移。 */
  persistDir?: string;
}

export interface LoginResult {
  username: string;
  sessionId: string;
  csrf: string;
}

export function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password: string, salt: string, hash: string): boolean {
  const a = Buffer.from(hashPassword(password, salt), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 只有 lstat 的 ENOENT 可视为首次部署;读取失败/目录/悬空链接绝不能变成空用户。 */
function readOptionalFile(file: string): string | undefined {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  if (!stat.isFile()) throw new Error('invalid auth storage file');
  return readFileSync(file, 'utf8');
}

function writeExclusive(file: string, contents: string): void {
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export class AuthService {
  private readonly memoryUsers = new Map<string, UserRecord>();
  private readonly memorySessions = new Map<string, SessionRecord>(); // key = sha256(sessionId)
  private readonly nowFn: () => number;
  private readonly ttlMs: number;
  private readonly persistDir?: string;
  private readonly authStore?: AuthStore;
  private initialized = false;
  private storageFailed = false;

  constructor(opts: AuthOptions = {}) {
    if (opts.storage !== undefined && opts.persistDir !== undefined) {
      throw new AuthError('认证存储选项冲突,需要显式迁移', 503);
    }
    this.nowFn = opts.now ?? (() => Date.now());
    this.ttlMs = opts.sessionTtlMs ?? 7 * 24 * 3_600_000;
    this.persistDir = opts.persistDir;
    this.authStore = opts.storage === undefined ? undefined : new AuthStore(opts.storage);
    if (this.persistDir !== undefined && !this.persistDir.trim()) this.failStorage();
    if (this.authStore) this.withStore((store) => store.snapshot());
    else this.loadUsers();
  }

  /** 持久化模式只暴露分离快照;内存兼容模式保留可变 Map。 */
  get users(): Map<string, UserRecord> {
    return this.authStore ? this.withStore((store) => store.snapshot().users) : this.memoryUsers;
  }

  get sessions(): Map<string, SessionRecord> {
    return this.authStore ? this.withStore((store) => store.snapshot().sessions) : this.memorySessions;
  }

  get needsInit(): boolean {
    if (this.storageFailed) return false;
    if (this.authStore) {
      try { return !this.withStore((store) => store.snapshot().initialized); }
      catch { return false; } // 故障不能重新开放 bootstrap;其他认证入口返回通用 503。
    }
    return !this.initialized && !this.storageFailed;
  }

  /** 首次初始化显式创建 global_owner:不以空 users 推断;落盘成功才发布内存用户。 */
  register(username: string, password: string): { username: string } {
    this.assertAvailable();
    const initialized = this.authStore ? this.withStore((store) => store.snapshot().initialized) : this.initialized;
    if (initialized) throw new AuthError('已初始化:注册已关闭,请登录', 403);
    if (!username || username.length < 3) throw new AuthError('用户名至少 3 个字符', 400);
    if (!password || password.length < 8) throw new AuthError('密码至少 8 个字符', 400);
    const salt = randomBytes(16).toString('hex');
    const user: UserRecord = {
      username,
      role: 'global_owner',
      salt,
      hash: hashPassword(password, salt),
      created_at: new Date(this.now).toISOString(),
    };
    if (this.authStore) {
      if (!this.withStore((store) => store.register(user))) throw new AuthError('已初始化:注册已关闭,请登录', 403);
    } else {
      this.saveUsers([user]);
      this.users.set(username, user);
      this.initialized = true;
    }
    return { username };
  }

  /** 登录:校验密码 → 签发会话(HttpOnly Cookie 值) */
  login(username: string, password: string): LoginResult {
    this.assertAvailable();
    const u = this.users.get(username);
    const fail = () => new AuthError('用户名或密码错误', 401);
    if (!u || u.username !== username) throw fail();
    if (!verifyPassword(password, u.salt, u.hash)) throw fail();
    if (!isUserRole(u.role)) throw new AuthError('账号角色无效,拒绝认证', 403);
    const sessionId = randomBytes(32).toString('hex');
    const csrf = randomBytes(24).toString('hex');
    const session: SessionRecord = {
      username,
      role: u.role,
      csrf,
      expiresAt: this.now + this.ttlMs,
    };
    if (this.authStore) this.withStore((store) => store.saveSession(this.sha(sessionId), session));
    else this.sessions.set(this.sha(sessionId), session);
    return { username, sessionId, csrf };
  }

  logout(sessionId: string): void {
    this.assertAvailable();
    if (this.authStore) this.withStore((store) => store.deleteSession(this.sha(sessionId)));
    else this.sessions.delete(this.sha(sessionId));
  }

  /** 会话须未过期且用户仍存在;返回当前用户权限,未知角色失败关闭(403)。 */
  session(sessionId: string): SessionRecord | undefined {
    this.assertAvailable();
    const state = this.authStore ? this.withStore((store) => store.snapshot()) : undefined;
    const s = (state?.sessions ?? this.sessions).get(this.sha(sessionId));
    if (!s) return undefined;
    if (this.now >= s.expiresAt) {
      this.logout(sessionId);
      return undefined;
    }
    const user = (state?.users ?? this.users).get(s.username);
    if (!user || user.username !== s.username) return undefined;
    if (!isUserRole(user.role) || !isUserRole(s.role)) throw new AuthError('账号或会话角色无效,拒绝认证', 403);
    return { ...s, role: user.role };
  }

  /** 从请求 Cookie 头解析会话(无/失效 → undefined) */
  sessionFromCookie(cookieHeader: string | undefined): SessionRecord | undefined {
    this.assertAvailable();
    if (this.authStore) this.withStore((store) => store.snapshot());
    if (!cookieHeader) return undefined;
    const raw = cookieHeader
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(SESSION_COOKIE + '='));
    if (!raw) return undefined;
    return this.session(raw.slice(SESSION_COOKIE.length + 1));
  }

  private sha(s: string): string {
    return createHash('sha256').update(s).digest('hex');
  }

  private get now(): number {
    return this.nowFn();
  }

  private loadUsers(): void {
    if (!this.persistDir) return;
    try {
      const marker = readOptionalFile(join(this.persistDir, 'initialized'));
      const contents = readOptionalFile(join(this.persistDir, 'users.json'));
      if (marker !== undefined && marker !== INITIALIZED_MARKER) throw new Error('invalid initialization marker');
      if (contents === undefined) {
        if (marker !== undefined) throw new Error('initialized users missing');
        return;
      }
      const arr: unknown = JSON.parse(contents);
      if (!Array.isArray(arr) || arr.length === 0) throw new Error('invalid users');
      const loaded = new Map<string, UserRecord>();
      for (const value of arr) {
        const u = parseUserRecord(value, arr.length === 1);
        if (!u || loaded.has(u.username)) throw new Error('invalid user record');
        loaded.set(u.username, u);
      }
      // 旧版单管理员仅在加载时规范化角色,不覆写源文件;补标记失败不发布部分用户。
      if (marker === undefined) {
        try {
          writeExclusive(join(this.persistDir, 'initialized'), INITIALIZED_MARKER);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST'
            || readOptionalFile(join(this.persistDir, 'initialized')) !== INITIALIZED_MARKER) throw e;
        }
      }
      for (const [username, user] of loaded) this.users.set(username, user);
      this.initialized = true;
    } catch {
      this.failStorage();
    }
  }

  private saveUsers(users: UserRecord[]): void {
    if (!this.persistDir) return;
    try {
      mkdirSync(this.persistDir, { recursive: true, mode: 0o700 });
      // 先独占标记再写 users:中断后只允许人工恢复,绝不重新开放注册或覆盖其他实例。
      writeExclusive(join(this.persistDir, 'initialized'), INITIALIZED_MARKER);
      writeExclusive(join(this.persistDir, 'users.json'), JSON.stringify(users, null, 2));
    } catch {
      this.failStorage();
    }
  }

  private assertAvailable(): void {
    if (this.storageFailed) throw new AuthError('认证存储不可用,拒绝认证与初始化', 503);
  }

  private withStore<T>(operation: (store: AuthStore) => T): T {
    this.assertAvailable();
    try {
      if (!this.authStore) return this.failStorage();
      return operation(this.authStore);
    } catch {
      return this.failStorage();
    }
  }

  private failStorage(): never {
    this.storageFailed = true;
    this.memorySessions.clear();
    throw new AuthError('认证存储不可用,拒绝认证与初始化', 503);
  }
}

export class AuthError extends Error {
  constructor(message: string, readonly httpStatus: number = 401) {
    super(message);
  }
}
