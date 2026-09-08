/**
 * 人类账号与会话(02 §3.1/§3.2 的"产品侧"最小实现)。
 * - 人:用户名 + 密码(scrypt 加盐哈希);登录 → HttpOnly 会话 Cookie;
 * - Agent/节点:node token + Ed25519(02 §3.2)——两套凭证严格分离,人的登录与节点凭证互不相干;
 * - v1 单运营者:任意有效会话即 owner(多人角色分离列后续);
 * - CSRF:Cookie 会话的变更类 owner 请求必须携带会话级 X-CSRF-Token。
 * 存储为内存态(可选 persistDir 落盘 users);重启后需重新登录/注册(与目录内存态一致)。
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SESSION_COOKIE = 'qlong_session';

export interface UserRecord {
  username: string;
  salt: string;
  hash: string;
  created_at: string;
}

export interface SessionRecord {
  username: string;
  csrf: string;
  expiresAt: number;
}

export interface AuthOptions {
  now?: () => number;
  /** 会话时长(默认 7 天) */
  sessionTtlMs?: number;
  /** 持久化目录(设置后 users 存 JSON,重启不丢账号) */
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

export class AuthService {
  readonly users = new Map<string, UserRecord>();
  readonly sessions = new Map<string, SessionRecord>(); // key = sha256(sessionId)
  private readonly nowFn: () => number;
  private readonly ttlMs: number;
  private readonly persistDir?: string;

  constructor(opts: AuthOptions = {}) {
    this.nowFn = opts.now ?? (() => Date.now());
    this.ttlMs = opts.sessionTtlMs ?? 7 * 24 * 3_600_000;
    this.persistDir = opts.persistDir;
    this.loadUsers();
  }

  get needsInit(): boolean {
    return this.users.size === 0;
  }

  /** 首次初始化:仅当无任何用户时允许创建管理员 */
  register(username: string, password: string): { username: string } {
    if (!username || username.length < 3) throw new AuthError('用户名至少 3 个字符', 400);
    if (!password || password.length < 8) throw new AuthError('密码至少 8 个字符', 400);
    if (this.users.size > 0) throw new AuthError('已初始化:注册已关闭,请登录', 403);
    const salt = randomBytes(16).toString('hex');
    this.users.set(username, {
      username,
      salt,
      hash: hashPassword(password, salt),
      created_at: new Date(this.now).toISOString(),
    });
    this.saveUsers();
    return { username };
  }

  /** 登录:校验密码 → 签发会话(HttpOnly Cookie 值) */
  login(username: string, password: string): LoginResult {
    const u = this.users.get(username);
    const fail = () => new AuthError('用户名或密码错误', 401);
    if (!u) throw fail();
    if (!verifyPassword(password, u.salt, u.hash)) throw fail();
    const sessionId = randomBytes(32).toString('hex');
    const csrf = randomBytes(24).toString('hex');
    this.sessions.set(this.sha(sessionId), {
      username,
      csrf,
      expiresAt: this.now + this.ttlMs,
    });
    return { username, sessionId, csrf };
  }

  logout(sessionId: string): void {
    this.sessions.delete(this.sha(sessionId));
  }

  /** 会话校验:存在且未过期;返回会话或 undefined */
  session(sessionId: string): SessionRecord | undefined {
    const s = this.sessions.get(this.sha(sessionId));
    if (!s) return undefined;
    if (this.now >= s.expiresAt) {
      this.sessions.delete(this.sha(sessionId));
      return undefined;
    }
    return s;
  }

  /** 从请求 Cookie 头解析会话(无/失效 → undefined) */
  sessionFromCookie(cookieHeader: string | undefined): SessionRecord | undefined {
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
    const file = join(this.persistDir, 'users.json');
    try {
      if (!existsSync(file)) return;
      const arr = JSON.parse(readFileSync(file, 'utf8')) as UserRecord[];
      for (const u of arr) this.users.set(u.username, u);
    } catch {
      /* 损坏文件视为无用户(bootstrap 重新可用) */
    }
  }

  private saveUsers(): void {
    if (!this.persistDir) return;
    try {
      mkdirSync(this.persistDir, { recursive: true });
      writeFileSync(
        join(this.persistDir, 'users.json'),
        JSON.stringify([...this.users.values()], null, 2),
        { mode: 0o600 },
      );
    } catch {
      /* 持久化失败不阻断内存态 */
    }
  }
}

export class AuthError extends Error {
  constructor(message: string, readonly httpStatus: number = 401) {
    super(message);
  }
}
