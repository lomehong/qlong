/**
 * 注册中心 HTTP 面(02 §9,node:http 零依赖实现;fastify 候选被否——镜像抖动环境优先零新增依赖)。
 * 鉴权:节点 = Bearer node token;人类 owner = 当前 global_owner 或目标团队 owner;无 auth 时走 ownerAuth。
 * 错误:统一信封 {error:{code,message,retryable?,details?}}(评审 I-31)。
 */
import { SESSION_COOKIE, AuthError, type SessionRecord } from './auth.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ApiError } from './errors.js';
import { isUuid } from '@qlong/core';
import type { NodeRecord, Registry } from './directory.js';

export interface RegistryServerOptions {
  registry: Registry;
  /** 未配置 auth 时的 owner 接入点;teamId='*' 要求全局权限;两者均缺失 → 503(P12)。 */
  ownerAuth?: (req: IncomingMessage, teamId: string) => boolean | Promise<boolean>;
  /** 轮换请求验签:必须用当前公钥校验并绑定目标/纪元/新公钥;未配置 → 503 失败关闭。 */
  verifyRotationSig?: (node: { node_id: string; key_epoch: number; pubkey: string }, input: { pubkey: string; sig?: string }) => boolean;
  /** enroll 每 IP 每分钟上限(评审 I-16) */
  enrollRatePerMinPerIp?: number;
  /** 书坊分发目录(纪要 §3):提供 /install.sh、/install.ps1、/install、/releases/<版本>/<文件> */
  distDir?: string;
  /** 人类账号会话:owner 端点校验当前角色及团队归属(未登录 401,无资源权限 403)。 */
  auth?: import('./auth.js').AuthService;
  /** v0.8 网关集群中继(02 §12.1):两者齐备时暴露 POST /internal/envelope(单端口部署形态) */
  clusterSecret?: string;
  onInternalEnvelope?: (toNodeId: string, envelope: unknown) => 'delivered' | 'queued' | 'not_here';
  /** d1d custody 集群中继(单端口形态):两者齐备时暴露 POST /internal/pump(不传 payload,仅通知泵) */
  relaySecret?: string;
  onPumpNotify?: (toNodeId: string, generation: number) => boolean;
  /**
   * 投递结果查询(A2):发送方节点查自己发出消息的 custody 终态。from_node 由路由强制为已
   * 认证节点身份,据此仅返回该节点为发送方的记录;未配置(如无中心 SQLite 的 ephemeral
   * 形态)→ 503 失败关闭,绝不伪称“查无此投递”。
   */
  deliveryOutcome?: (fromNode: string, msgId: string) => undefined | { status: string; digest: string; toNode: string };
}

const MAX_BODY = 1 << 20;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function sendError(res: ServerResponse, e: unknown): void {
  if (e instanceof AuthError) {
    sendJson(res, e.httpStatus, new ApiError('auth_error', e.message, e.httpStatus).body());
    return;
  }
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

function isWrite(req: IncomingMessage): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes((req.method ?? 'GET').toUpperCase());
}

function assertCsrf(req: IncomingMessage, session: SessionRecord): void {
  if (isWrite(req) && req.headers['x-csrf-token'] !== session.csrf) {
    throw new ApiError('csrf_mismatch', 'CSRF 校验失败,请刷新页面重试', 403);
  }
}

/** 登录/首次注册尚无 CSRF 会话:要求非简单 JSON 请求,并拒绝跨站 Cookie 签发。 */
function assertAuthRequest(req: IncomingMessage): void {
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new ApiError('bad_request', '认证请求必须使用 application/json', 400);
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    throw new ApiError('csrf_mismatch', '拒绝跨站认证请求', 403);
  }
}

/** 显式白名单:仅公开身份、纪元与公钥,禁止展开内部记录(含 tokenHash)。 */
function publicNode(node: NodeRecord) {
  const pubkeys = node.keys.map(({ epoch, pubkey }) => ({ epoch, pubkey }));
  const current = pubkeys[pubkeys.length - 1];
  if (!current || !Number.isSafeInteger(current.epoch) || current.epoch < 1) {
    throw new ApiError('key_epoch_conflict', '节点公钥纪元不可用', 503);
  }
  return {
    node_id: node.node_id, team_id: node.team_id, name: node.name, status: node.status,
    key_epoch: current.epoch,
    pubkeys, keys: pubkeys,
    platform: node.platform, qlong_version: node.qlong_version,
    caps: node.caps, caps_rev: node.caps_rev, load: node.load,
    last_seen: node.last_seen, joined_at: node.joined_at,
  };
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

      // Cookie 一旦随写请求发送就必须校验,不能用同时携带的 Bearer 绕过 CSRF。
      if (isWrite(req) && sessionIdFromCookie(req.headers.cookie) !== undefined) {
        if (!opts.auth) throw new ApiError('csrf_mismatch', 'Cookie 会话校验未配置', 403);
        const session = opts.auth.sessionFromCookie(req.headers.cookie);
        if (session) {
          assertCsrf(req, session);
        } else if (method === 'POST' && seg[0] === 'v1' && seg[1] === 'auth'
          && seg.length === 3 && (seg[2] === 'login' || seg[2] === 'register')) {
          // 重启/过期后的 Cookie 不再提供任何授权;密码重登仍须通过非简单请求保护。
          assertAuthRequest(req);
        } else {
          throw new ApiError('unauthorized', '会话无效', 401);
        }
      }

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

      // ---- 网关集群中继(02 §12.1,v0.8):集群内部信任域,共享密钥头鉴权 ----
      if (url.pathname === '/internal/envelope' && method === 'POST' && opts.clusterSecret && opts.onInternalEnvelope) {
        if (req.headers['x-qlong-cluster-secret'] !== opts.clusterSecret) {
          sendJson(res, 403, { error: { code: 'forbidden', message: 'cluster secret mismatch' } });
          return;
        }
        try {
          const body = await readJson(req);
          const toNodeId = typeof body.to_node_id === 'string' ? body.to_node_id : '';
          if (!toNodeId || !body.envelope) throw new Error('bad body');
          const result = opts.onInternalEnvelope(toNodeId, body.envelope);
          sendJson(res, 200, { result });
        } catch {
          sendJson(res, 400, { error: { code: 'bad_request', message: 'malformed relay body' } });
        }
        return;
      }

      // ---- custody 集群中继(d1d,单端口形态):只传 {to_node_id, generation} 通知,不传 payload ----
      if (url.pathname === '/internal/pump' && method === 'POST' && opts.relaySecret && opts.onPumpNotify) {
        if (req.headers['x-qlong-relay-secret'] !== opts.relaySecret) {
          sendJson(res, 403, { error: { code: 'forbidden', message: 'relay secret mismatch' } });
          return;
        }
        try {
          const body = await readJson(req);
          const toNodeId = typeof body.to_node_id === 'string' ? body.to_node_id : '';
          const generation = body.generation;
          if (!isUuid(toNodeId) || !Number.isSafeInteger(generation) || (generation as number) < 1) {
            throw new Error('bad body');
          }
          sendJson(res, 200, { pumped: opts.onPumpNotify!(toNodeId, generation as number) });
        } catch {
          sendJson(res, 400, { error: { code: 'bad_request', message: 'malformed relay body' } });
        }
        return;
      }

      if (seg[0] !== 'v1') throw new ApiError('bad_request', 'not found', 404);

      // ---- 人类账号与会话(02 §3.1):公开路由;会话经 HttpOnly Cookie ----
      if (method === 'GET' && seg[1] === 'auth' && seg[2] === 'status' && seg.length === 3 && opts.auth) {
        sendJson(res, 200, { needs_init: opts.auth.needsInit });
        return;
      }
      if (method === 'POST' && seg[1] === 'auth' && seg[2] === 'register' && seg.length === 3 && opts.auth) {
        assertAuthRequest(req);
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
      if (method === 'POST' && seg[1] === 'auth' && seg[2] === 'login' && seg.length === 3 && opts.auth) {
        assertAuthRequest(req);
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
      if (method === 'POST' && seg[1] === 'auth' && seg[2] === 'logout' && seg.length === 3 && opts.auth) {
        // 销毁自己的会话不要求任何团队所有权,但仍须有效会话和 CSRF。
        requireSession(opts, req);
        const sid = sessionIdFromCookie(req.headers.cookie);
        if (sid) opts.auth.logout(sid);
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
        sendJson(res, 200, {});
        return;
      }
      if (method === 'GET' && seg[1] === 'auth' && seg[2] === 'me' && seg.length === 3 && opts.auth) {
        const session = requireSession(opts, req);
        sendJson(res, 200, { username: session.username, csrf: session.csrf });
        return;
      }

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

      // ---- owner 节点管理:不得被后面的 node token 认证提前拦住 ----
      if (seg[1] === 'nodes' && seg[2] !== 'me' && seg.length === 4
        && (seg[3] === 'suspend' || seg[3] === 'revoke') && method === 'POST') {
        const targetId = seg[2] as string;
        const target = registry.getNode(targetId);
        if (!target) throw new ApiError('bad_request', '节点不存在', 404);
        const targetTeamId = target.team_id;
        await assertOwner(opts, req, targetTeamId);
        if (registry.getNode(targetId)?.team_id !== targetTeamId) {
          throw new ApiError('not_team_member', '节点团队已变更,请重试授权', 403);
        }
        sendJson(res, 200, seg[3] === 'suspend' ? registry.suspend(targetId) : registry.revoke(targetId));
        return;
      }

      // ---- 节点凭证面 ----
      const token = bearer(req);
      if (seg[1] === 'nodes' && seg[2] !== undefined) {
        if (!token) throw new ApiError('not_team_member', '缺少凭证', 401);

        if (seg[2] === 'me' && seg.length === 3) {
          if (method === 'GET') {
            sendJson(res, 200, publicNode(registry.authByToken(token)));
            return;
          }
          if (method === 'PATCH') {
            const body = await readJson(req);
            if (Object.keys(body).length !== 1 || typeof body.name !== 'string' || body.name.trim().length === 0) {
              throw new ApiError('bad_request', 'PATCH 必须且只能包含非空 name');
            }
            // No pre-await auth record: revalidate Cookie and bearer after the body arrives.
            if (sessionIdFromCookie(req.headers.cookie) !== undefined) requireSession(opts, req);
            sendJson(res, 200, publicNode(registry.updateNodeName(token, body.name)));
            return;
          }
          throw new ApiError('bad_request', '不支持的方法', 405);
        }

        if (seg[2] === 'me' && seg[3] === 'caps' && seg.length === 4 && method === 'PUT') {
          const body = await readJson(req);
          if (!Array.isArray(body.caps)) throw new ApiError('bad_request', 'caps 必须为字符串数组');
          // Authentication/touch belongs to putCaps' transaction, not a pre-await commit.
          const r = registry.putCaps(token, body.caps as string[]);
          sendJson(res, 200, r);
          return;
        }
        if (seg[2] === 'me' && seg[3] === 'load' && seg.length === 4 && method === 'PUT') {
          const body = await readJson(req);
          registry.putLoad(token, body);
          res.writeHead(204);
          res.end();
          return;
        }
        if (seg[2] === 'me' && seg[3] === 'keys' && seg.length === 4 && method === 'POST') {
          const body = await readJson(req);
          const verifySig = opts.verifyRotationSig;
          const verifier = verifySig
            ? (node: NodeRecord, input: { pubkey: string; sig?: string }) => {
                const current = node.keys[node.keys.length - 1];
                return current !== undefined && verifySig(
                  { node_id: node.node_id, key_epoch: current.epoch, pubkey: current.pubkey }, input,
                );
              }
            : undefined;
          const r = registry.rotateKeys(token, {
            pubkey: String(body.pubkey ?? ''),
            sig: typeof body.sig === 'string' ? body.sig : undefined,
          }, verifier);
          sendJson(res, 200, r);
          return;
        }

        // 投递结果查询(A2):发送方查自己发出消息的终态。from_node 强制为认证身份(self.node_id),
        // 绝不取自请求,故他方查同一 msgId 必得 404;custody 后端缺失时 503 失败关闭而非伪称查无。
        if (seg[2] === 'me' && seg[3] === 'deliveries' && seg.length === 5 && method === 'GET') {
          const self = registry.authByToken(token);
          if (!opts.deliveryOutcome) throw new ApiError('bad_request', '投递结果查询未配置', 503);
          const msgId = seg[4] as string;
          const result = opts.deliveryOutcome(self.node_id, msgId);
          if (!result) throw new ApiError('bad_request', '投递不存在', 404);
          sendJson(res, 200, { msg_id: msgId, to_node: result.toNode, status: result.status, digest: result.digest });
          return;
        }

        // /v1/nodes/{id}/pubkey
        if (seg[3] === 'pubkey' && seg.length === 4 && method === 'GET') {
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
      }

      // ---- team 面 ----
      // ---- global_owner:全局团队列表;普通团队 owner 不得枚举所有团队 ----
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
        if (seg[3] === 'tasks' && method === 'POST' && seg.length === 4) {
          // Lead projection, never owner-cookie scheduling. Do not authenticate/touch separately.
          if (!token) throw new ApiError('not_team_member', '缺少节点凭证', 401);
          const body = await readJson(req);
          if (sessionIdFromCookie(req.headers.cookie) !== undefined) requireSession(opts, req);
          sendJson(res, 200, registry.reportTask(token, teamId, body));
          return;
        }
        if (seg[3] === 'tasks' && method === 'GET' && seg.length === 5) {
          requireTeamAccess(opts, req, teamId);
          // Authorization and lookup are synchronous: no awaited revocation/team-change gap.
          const task = registry.getTask(teamId, seg[4] as string);
          if (!task) throw new ApiError('bad_request', '任务不存在', 404);
          sendJson(res, 200, task);
          return;
        }
        // 暂停/恢复属于 owner 管理,普通成员不得调用;目标必须属于 URL team。
        if (seg[3] === 'nodes' && (seg[5] === 'resume' || seg[5] === 'suspend') && method === 'POST' && seg.length === 6) {
          await assertOwner(opts, req, teamId);
          const targetId = seg[4] as string;
          const target = registry.getNode(targetId);
          if (!target) throw new ApiError('bad_request', '节点不存在', 404);
          if (target.team_id !== teamId) throw new ApiError('not_team_member', '节点不属于 URL team', 403);
          if (seg[5] === 'resume') registry.resume(targetId);
          else registry.suspend(targetId);
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
          const grant = registry.grants.get(seg[4]);
          if (!grant) throw new ApiError('bad_request', 'grant 不存在', 404);
          // 保守 owner-only:接收方/无关团队不得借 URL 删除来源方创建的授权。
          if (grant.from_team !== teamId) throw new ApiError('not_team_member', 'grant 不属于 URL 来源 team', 403);
          registry.revokeGrant(grant.grant_id);
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

  function requireSession(o: RegistryServerOptions, req: IncomingMessage): SessionRecord {
    const session = o.auth?.sessionFromCookie(req.headers.cookie);
    if (!session) throw new ApiError('unauthorized', '未登录', 401, false, { login: '#/login' });
    assertCsrf(req, session);
    return session;
  }

  /** session() 已按当前用户刷新角色;仍显式白名单校验,未知角色绝不能靠 owner 字段放行。 */
  function assertSessionOwner(session: SessionRecord, teamId: string): void {
    if (session.role === 'global_owner') return;
    if (session.role === 'user' && teamId !== '*'
      && registry.teams.get(teamId)?.owner_user_id === session.username) return;
    throw new ApiError('not_team_member', '无目标团队 owner 权限', 403);
  }

  /**
   * 团队级读取:人类 global_owner/本团队 owner 或同队 active 节点 token。
   * 会话缺失且无有效节点 token → 401(控制台跳登录页)。
   */
  function requireTeamAccess(o: RegistryServerOptions, req: IncomingMessage, teamId: string): void {
    // ① 人类会话须有资源所有权;不得退回外部 ownerAuth 绕过,未来写路由也须 CSRF。
    if (o.auth) {
      const session = o.auth.sessionFromCookie(req.headers.cookie);
      if (session) {
        assertCsrf(req, session);
        assertSessionOwner(session, teamId);
        return;
      }
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
    // ① 人类会话:当前显式角色 + 目标团队归属;变更类请求须携带会话 CSRF。
    if (o.auth) {
      assertSessionOwner(requireSession(o, req), teamId);
      return;
    }
    // ② 产品侧接入点(无独立产品时的替代:QLONG_OWNER_TOKEN 环境变量)
    if (isWrite(req) && req.headers.cookie) {
      throw new ApiError('csrf_mismatch', '外部 Cookie owner 鉴权缺少会话 CSRF 验证', 403);
    }
    if (!o.ownerAuth) throw new ApiError('owner_auth_unconfigured', 'owner 鉴权未配置(产品侧接入点)', 503);
    const ok = await o.ownerAuth(req, teamId);
    if (ok !== true) throw new ApiError('not_team_member', 'owner 鉴权失败', 403);
  }
}
