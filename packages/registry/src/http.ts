/**
 * 注册中心 HTTP 面(02 §9,node:http 零依赖实现;fastify 候选被否——镜像抖动环境优先零新增依赖)。
 * 鉴权:节点 = Bearer node token;owner = opts.ownerAuth(产品侧会话代持接入点,v1 默认拒绝,P12)。
 * 错误:统一信封 {error:{code,message,retryable?,details?}}(评审 I-31)。
 */
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
      if (seg[1] === 'teams' && seg.length >= 3) {
        const teamId = seg[2] as string;

        // 控制台概览(评审 I-21,§8.7):GET /v1/teams/{id}/overview
        if (seg[3] === 'overview' && method === 'GET' && seg.length === 4) {
          const self = registry.authByToken(token ?? '');
          if (self.team_id !== teamId) throw new ApiError('not_team_member', '仅本 team 成员可查', 403);
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
          const self = registry.authByToken(token ?? '');
          if (self.team_id !== teamId) throw new ApiError('not_team_member', '仅本 team 成员可查', 403);
          const caps = url.searchParams.getAll('caps');
          sendJson(res, 200, { nodes: registry.listTeamNodes(teamId, { caps }), next_cursor: null });
          return;
        }
        // 审计查询(§11):GET /v1/teams/{id}/audit
        if (seg[3] === 'audit' && method === 'GET' && seg.length === 4) {
          const self = registry.authByToken(token ?? '');
          if (self.team_id !== teamId) throw new ApiError('not_team_member', '仅本 team 成员可查', 403);
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

  async function assertOwner(o: RegistryServerOptions, req: IncomingMessage, teamId: string): Promise<void> {
    if (!o.ownerAuth) throw new ApiError('owner_auth_unconfigured', 'owner 鉴权未配置(产品侧接入点)', 503);
    const ok = await o.ownerAuth(req, teamId);
    if (!ok) throw new ApiError('not_team_member', 'owner 鉴权失败', 403);
  }
}
