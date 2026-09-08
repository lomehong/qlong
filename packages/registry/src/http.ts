/**
 * 注册中心 HTTP 面(02 §9,node:http 零依赖实现;fastify 候选被否——镜像抖动环境优先零新增依赖)。
 * 鉴权:节点 = Bearer node token;owner = opts.ownerAuth(产品侧会话代持接入点,v1 默认拒绝,P12)。
 * 错误:统一信封 {error:{code,message,retryable?,details?}}(评审 I-31)。
 */
import { join } from 'node:path';
import { SESSION_COOKIE, AuthError } from './auth.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ApiError } from './errors.js';
import type { Registry } from './directory.js';

export interface RegistryServerOptions {
  registry: Registry;
  /** owner 端点鉴权(产品侧接入点);未配置 → 一律 503 owner_auth_unconfigured(P12) */
  ownerAuth?: (req: IncomingMessage, teamId: string) => boolean | Promise<boolean>;
  /** 轮换请求签名校验(§6.1 双因子;未配置 → 仅 token 认证放行,签名要素由调用方自证) */
  verifyRotationSig?: (node: { node_id: string }, input: { pubkey: string; sig?: string }) => boolean;
  /** enroll 每 IP 每分钟上限(评审 I-16) */
  enrollRatePerMinPerIp?: number;
  /** 书坊分发目录(纪要 §3):提供 /install.sh、/install.ps1、/install、/releases/<版本>/<文件> */
  distDir?: string;
  /** 人类账号与会话(02 §3.1):配置后 owner 端点走会话 Cookie 鉴权(未登录 → 401 → 控制台跳登录页) */
  auth?: import('./auth.js').AuthService;
}

const MAX_BODY = 1 << 20;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function sendError(res: ServerResponse, e: unknown): void {
  if (e instanceof ApiError) {
    sendJson(res, e.httpStatus, e.body());
    return;
  }
  sendJson(res, 500, { error: { code: 'internal_error', message: 'internal error' } });
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ApiError('bad_request', '请求体过大', 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          reject(new ApiError('bad_request', '请求体必须为 JSON 对象', 400));
        } else {
          resolve(parsed as Record<string, unknown>);
        }
      } catch {
        reject(new ApiError('bad_request', '非法 JSON', 400));
      }
    });
    req.on('error', reject);
  });
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) return undefined;
  const token = h.slice(7).trim();
  return token.length > 0 ? token : undefined;
}

function sessionIdFromCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const raw = cookieHeader.split(';').map((c) => c.trim()).find((c) => c.startsWith(SESSION_COOKIE + '='));
  return raw ? raw.slice(SESSION_COOKIE.length + 1) : undefined;
}

function sessionCookie(sessionId: string): string {
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`;
}

const DIST_TYPES: Record<string, string> = {
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.cmd': 'text/plain; charset=utf-8',
};

/** 书坊:发布物静态服务。/install* 取 latest;/releases/<版本>/<文件> 支持多版本共存。 */
async function serveDist(res: ServerResponse, distDir: string, pathname: string): Promise<void> {
  const { stat } = await import('node:fs/promises');
  const path = await import('node:path');
  let rel: string;
  if (pathname === '/install') {
    rel = 'latest/install.html';
  } else if (pathname === '/install.sh' || pathname === '/install.ps1') {
    rel = 'latest/' + pathname.slice(1);
  } else if (pathname === '/' || pathname === '/console' || pathname === '/console.html') {
    rel = 'latest/console.html';
  } else if (pathname === '/console-bundle.js' || pathname === '/console-bundle.css') {
    rel = 'latest/' + pathname.slice(1);
  } else {
    rel = pathname.replace(/^\/releases\//, '');
  }
  const base = path.resolve(distDir);
  const target = path.resolve(base, rel);
  if (!target.startsWith(base + path.sep) && target !== base) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    const st = await stat(target);
    if (!st.isFile()) throw new Error('not a file');
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': DIST_TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': st.size,
    });
    const { createReadStream } = await import('node:fs');
    createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('发布物不存在:' + pathname);
  }
}

export function createRegistryServer(opts: RegistryServerOptions): Server {
  const { registry } = opts;
  const rate = new Map<string, { windowStart: number; count: number }>();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const seg = url.pathname.split('/').filter(Boolean);
      const method = (req.method ?? 'GET').toUpperCase();

      const enrollLimit = opts.enrollRatePerMinPerIp;
      if (method === 'POST' && seg[1] === 'enroll' && enrollLimit !== undefined) {
        const ip = req.socket.remoteAddress ?? 'unknown';
        const nowMs = Date.now();
        let bucket = rate.get(ip);
        if (!bucket || nowMs - bucket.windowStart > 60_000) {
          bucket = { windowStart: nowMs, count: 0 };
          rate.set(ip, bucket);
        }
        bucket.count += 1;
        if (bucket.count > enrollLimit) {
          throw new ApiError('rate_limited', '注册请求过于频繁', 429, true);
        }
      }

      // ---- 书坊静态分发(纪要 §3 第三服务;路径穿越防护:P12)----
      if (method === 'GET' && opts.distDir && (seg[0] === 'releases' || url.pathname === '/install.sh' || url.pathname === '/install.ps1' || url.pathname === '/install' || url.pathname === '/' || url.pathname === '/console' || url.pathname === '/console-bundle.js' || url.pathname === '/console-bundle.css')) {
        await serveDist(res, opts.distDir, url.pathname);
        return;
      }

      // ---- 人类账号与会话(02 §3.1):公开路由;会话经 HttpOnly Cookie ----
      if (method === 'GET' && seg[1] === 'auth' && seg[2] === 'status' && opts.auth) {
        sendJson(res, 200, { needs_init: opts.auth.needsInit });
        return;
      }
      if (method === 'POST' && seg[1] === 'auth' && seg[2] === 'register' && opts.auth) {
        const body = await readJson(req);
        try {
          opts.auth.register(String(body.username ?? ''), String(body.password ?? ''));
        } catch (e) {
          if (e instanceof AuthError) throw new ApiError('auth_error', e.message, e.httpStatus);
          throw e;
        }
        // 首个管理员注册即登录(免再输一次)
        const r = opts.auth.login(String(body.username ?? ''), String(body.password ?? ''));
        res.setHeader('Set-Cookie', sessionCookie(r.sessionId));
        sendJson(res, 200, { username: r.username, csrf: r.csrf });
        return;
      }
      if (method === 'POST' && seg[1] === 'auth' && seg[2] === 'login' && opts.auth) {
        const body = await readJson(req);
        let r;
        try {
          r = opts.auth.login(String(body.username ?? ''), String(body.password ?? ''));
        } catch (e) {
          if (e instanceof AuthError) throw new ApiError('auth_failed', e.message, e.httpStatus);
          throw e;
        }
        res.setHeader('Set-Cookie', sessionCookie(r.sessionId));
        sendJson(res, 200, { username: r.username, csrf: r.csrf });
        return;
      }
      if (method === 'POST' && seg[1] === 'auth' && seg[2] === 'logout' && opts.auth) {
        const sid = sessionIdFromCookie(req.headers.cookie);
        if (sid) opts.auth.logout(sid);
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
        sendJson(res, 200, {});
        return;
      }
      if (method === 'GET' && seg[1] === 'auth' && seg[2] === 'me' && opts.auth) {
        const sid = sessionIdFromCookie(req.headers.cookie);
        const session = sid ? opts.auth.session(sid) : undefined;
        if (!session) throw new ApiError('unauthorized', '未登录', 401, false, { login: '#/login' });
        sendJson(res, 200, { username: session.username, csrf: session.csrf });
        return;
      }

      if (seg[0] !== 'v1') throw new ApiError('bad_request', 'not found', 404);

      // ---- 公开:enroll ----
      if (seg[1] === 'enroll' && seg.length === 2 && method === 'POST') {
        const body = await readJson(req);
        const r = registry.enroll({
          token: typeof body.token === 'string' ? body.token : undefined,
          pubkey: String(body.pubkey ?? ''),
          platform: typeof body.platform === 'string' ? body.platform : undefined,
          qlong_version: typeof body.qlong_version === 'string' ? body.qlong_version : undefined,
        });
        sendJson(res, 200, r);
        return;
      }

      // ---- 节点凭证面 ----
      const token = bearer(req);
      if (seg[1] === 'nodes' && (seg[2] === 'me' || (seg[2] !== undefined && seg[2] !== 'me'))) {
        if (!token) throw new ApiError('not_team_member', '缺少凭证', 401);

        if (seg[2] === 'me' && seg.length === 3) {
          const node = registry.authByToken(token);
          if (method === 'GET') {
            sendJson(res, 200, { ...node, tokenHash: undefined });
            return;
          }
          if (method === 'PATCH') {
            const body = await readJson(req);
            if (typeof body.name === 'string' && body.name.length > 0) node.name = body.name;
            sendJson(res, 200, { ...node, tokenHash: undefined });
            return;
          }
          throw new ApiError('bad_request', '不支持的方法', 405);
        }

        if (seg[2] === 'me' && seg[3] === 'caps' && method === 'PUT') {
          const node = registry.authByToken(token);
          const body = await readJson(req);
          const r = registry.putCaps(token, Array.isArray(body.caps) ? (body.caps as string[]) : []);
          void node;
          sendJson(res, 200, r);
          return;
        }
        if (seg[2] === 'me' && seg[3] === 'load' && method === 'PUT') {
          const body = await readJson(req);
          registry.putLoad(token, body);
          res.writeHead(204);
          res.end();
          return;
        }
        if (seg[2] === 'me' && seg[3] === 'keys' && method === 'POST') {
          const body = await readJson(req);
          const verifier = opts.verifyRotationSig
            ? (node: { node_id: string }, input: { pubkey: string; sig?: string }) =>
                (opts.verifyRotationSig as NonNullable<NonNullable<RegistryServerOptions['verifyRotationSig']>>)(
                  { node_id: node.node_id },
                  input,
                )
            : undefined;
          const r = registry.rotateKeys(token, {
            pubkey: String(body.pubkey ?? ''),
            sig: typeof body.sig === 'string' ? body.sig : undefined,
          }, verifier);
          sendJson(res, 200, r);
          return;
        }

        // /v1/nodes/{id}/pubkey | suspend | revoke
        if (seg[3] === 'pubkey' && method === 'GET') {
          const self = registry.authByToken(token);
          const targetId = seg[2] as string;
          const target = registry.getNode(targetId);
          if (!target) throw new ApiError('bad_request', '节点不存在', 404);
          if (target.team_id !== self.team_id) throw new ApiError('not_team_member', '仅同 team 可查', 403);
          const epochParam = url.searchParams.get('epoch');
          const epoch = epochParam === null ? undefined : Number(epochParam);
          const lookup = registry.lookupPubkey(targetId, epoch);
          if (lookup.status === 'current' || lookup.status === 'historical') {
            sendJson(res, 200, { node_id: targetId, status: lookup.status, key_epoch: lookup.epoch, pubkey: lookup.pubkey });
            return;
          }
          if (lookup.status === 'node_inactive') {
            throw new ApiError(
              lookup.detail === 'suspended' ? 'node_suspended' : 'node_revoked',
              '节点非 active,纪元回源拒绝',
              403,
            );
          }
          if (lookup.status === 'node_unknown') throw new ApiError('bad_request', '节点不存在', 404);
          throw new ApiError('key_epoch_conflict', '查无此纪元', 404);
        }

        if ((seg[3] === 'suspend' || seg[3] === 'revoke') && method === 'POST') {
          const targetId = seg[2] as string;
          const target = registry.getNode(targetId);
          if (!target) throw new ApiError('bad_request', '节点不存在', 404);
          await assertOwner(opts, req, target.team_id);
          if (seg[3] === 'suspend') {
            const r = registry.suspend(targetId);
            sendJson(res, 200, r);
          } else {
            const r = registry.revoke(targetId);
            sendJson(res, 200, r);
          }
          return;
        }
      }

      // ---- team 面 ----
      // ---- owner:团队列表(控制台动态发现,替代硬编码 team_id)----
      if (seg[1] === 'teams' && seg.length === 2 && method === 'GET') {
        await assertOwner(opts, req, '*');
        sendJson(res, 200, { teams: registry.listTeams() });
        return;
      }

      if (seg[1] === 'teams' && seg.length >= 3) {
        const teamId = seg[2] as string;

        // 控制台概览(评审 I-21,§8.7):GET /v1/teams/{id}/overview
        if (seg[3] === 'overview' && method === 'GET' && seg.length === 4) {
          requireTeamAccess(opts, req, teamId);
          const nodes = registry.listTeamNodes(teamId);
          const grantList = registry.listGrants(teamId);
          sendJson(res, 200, {
            team_id: teamId,
            nodes,
            grants: grantList,
            stats: { total: nodes.length, online: nodes.filter((n: Record<string, unknown>) => n.online).length },
          });
          return;
        }
        if (seg[3] === 'nodes' && method === 'GET' && seg.length === 4) {
          requireTeamAccess(opts, req, teamId);
          const caps = url.searchParams.getAll('caps');
          sendJson(res, 200, { nodes: registry.listTeamNodes(teamId, { caps }), next_cursor: null });
          return;
        }
        // 任务列表:v0.2 GET /v1/teams/{id}/tasks
        if (seg[3] === 'tasks' && method === 'GET' && seg.length === 4) {
          requireTeamAccess(opts, req, teamId);
          const tasks = registry.listTasks(teamId, 100);
          sendJson(res, 200, { tasks });
          return;
        }
        // 节点恢复(v0.2 P1):POST /v1/teams/{id}/nodes/{nid}/resume
        if (seg[3] === 'nodes' && seg[5] === 'resume' && method === 'POST' && seg.length === 6) {
          requireTeamAccess(opts, req, teamId);
          registry.resume(seg[4] as string);
          sendJson(res, 200, { ok: true });
          return;
        }
        // 节点暂停(v0.2 P1):POST /v1/teams/{id}/nodes/{nid}/suspend
        if (seg[3] === 'nodes' && seg[5] === 'suspend' && method === 'POST' && seg.length === 6) {
          requireTeamAccess(opts, req, teamId);
          registry.suspend(seg[4] as string);
          sendJson(res, 200, { ok: true });
          return;
        }
        // 审计查询(§11):GET /v1/teams/{id}/audit
        if (seg[3] === 'audit' && method === 'GET' && seg.length === 4) {
          requireTeamAccess(opts, req, teamId);
          const events = registry.getAuditEvents ? registry.getAuditEvents(teamId, 1000) : [];
          sendJson(res, 200, { events });
          return;
        }
        if (seg[3] === 'grants' && seg.length >= 4) {
        // grant 管理(v0.2 D1)
        if (seg[3] === 'grants' && seg.length === 4) {
          await assertOwner(opts, req, teamId);
          if (method === 'GET') {
            sendJson(res, 200, { grants: registry.listGrants(teamId) });
            return;
          }
          if (method === 'POST') {
            const body = await readJson(req);
            const grant = registry.createGrant({
              from_team: teamId,
              to_team: String(body.to_team ?? ''),
              caps_visible: Array.isArray(body.caps_visible) ? (body.caps_visible as string[]) : [],
              ttlMs: typeof body.ttl_ms === 'number' ? body.ttl_ms : undefined,
              created_by: 'owner',
            });
            sendJson(res, 200, grant);
            return;
          }
        }
        if (seg[3] === 'grants' && seg[4] && method === 'DELETE' && seg.length === 5) {
          await assertOwner(opts, req, teamId);
          registry.revokeGrant(seg[4] as string);
          sendJson(res, 200, { ok: true });
          return;
        }
        }
        if (seg[3] === 'enroll-tokens' && method === 'POST' && seg.length === 4) {
          await assertOwner(opts, req, teamId);
          const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
          const ttl = typeof body.ttl_ms === 'number' ? body.ttl_ms : undefined;
          const tokenStr = registry.issueEnrollToken(teamId, { ttlMs: ttl });
          sendJson(res, 200, { token: tokenStr });
          return;
        }
      }

      throw new ApiError('bad_request', 'not found', 404);
    })()
      .catch((e: unknown) => sendError(res, e));
  });

  return server;

  /**
   * 团队级访问(读/成员操作):人类会话(02 §3.1)或 同队 active 节点 token 任一即可。
   * 会话缺失且无有效节点 token → 401(控制台跳登录页)。
   */
  function requireTeamAccess(o: RegistryServerOptions, req: IncomingMessage, teamId: string): void {
    // ① 人类会话(02 §3.1):有效登录会话即可(读/成员操作)
    if (o.auth) {
      const session = o.auth.sessionFromCookie(req.headers.cookie);
      if (session) return;
    }
    // ② 节点 token:须 active 且属于该 team
    const token = bearer(req);
    if (token) {
      const self = registry.authByToken(token);
      if (self.team_id !== teamId) {
        throw new ApiError('not_team_member', '仅本 team 成员可访问', 403);
      }
      if (self.status !== 'active') {
        throw new ApiError('node_suspended', `节点状态 ${self.status}`, 403);
      }
      return;
    }
    // ③ 无任何凭证 → 401(控制台跳登录页;P12 失败关闭)
    throw new ApiError('unauthorized', '未登录或无本 team 节点凭证', 401, false, { login: '#/login' });
  }

  async function assertOwner(o: RegistryServerOptions, req: IncomingMessage, teamId: string): Promise<void> {
    // ① 人类会话(02 §3.1):有效登录会话即 owner(v1 单运营者);变更类请求须携带会话 CSRF
    if (o.auth) {
      const session = o.auth.sessionFromCookie(req.headers.cookie);
      if (!session) {
        throw new ApiError('unauthorized', '未登录', 401, false, { login: '#/login' });
      }
      const method = (req.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        if (req.headers['x-csrf-token'] !== session.csrf) {
          throw new ApiError('csrf_mismatch', 'CSRF 校验失败,请刷新页面重试', 403);
        }
      }
      return;
    }
    // ② 产品侧接入点(无独立产品时的替代:QLONG_OWNER_TOKEN 环境变量)
    if (!o.ownerAuth) throw new ApiError('owner_auth_unconfigured', 'owner 鉴权未配置(产品侧接入点)', 503);
    const ok = await o.ownerAuth(req, teamId);
    if (!ok) throw new ApiError('not_team_member', 'owner 鉴权失败', 403);
  }
}
