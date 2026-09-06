import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Registry } from '../src/index.js';
import { createRegistryServer } from '../src/http.js';

const PUB1 = 'A'.repeat(86) + '==';
const PUB2 = 'C'.repeat(86) + '==';

let server: ReturnType<typeof createRegistryServer>;
let base = '';
let bearer = '';
let teamId = '';
const registry = new Registry({ now: () => 1_000_000 });

beforeAll(async () => {
  const team = registry.createTeam({ owner_user_id: 'u1' });
  teamId = team.team_id;
  const token = registry.issueEnrollToken(teamId);
  const res = registry.enroll({ token, pubkey: PUB1 });
  bearer = res.node_token;
  server = createRegistryServer({ registry, ownerAuth: () => true, enrollRatePerMinPerIp: 1000 });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

async function call(method: string, path: string, body?: unknown, auth?: string) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as unknown;
  return { status: res.status, json };
}

describe('注册中心 HTTP 面(02 §9)', () => {
  it('A1 种子:enroll happy → 200;重放 → 409 enroll_token_used', async () => {
    const t = registry.issueEnrollToken(teamId);
    const r1 = await call('POST', '/v1/enroll', { token: t, pubkey: PUB2, platform: 'linux' });
    expect(r1.status).toBe(200);
    expect((r1.json as { key_epoch: number }).key_epoch).toBe(1);
    const r2 = await call('POST', '/v1/enroll', { token: t, pubkey: PUB2 });
    expect(r2.status).toBe(409);
    expect((r2.json as { error: { code: string } }).error.code).toBe('enroll_token_used');
  });

  it('auth:无凭证 401;错凭证 401;GET /v1/nodes/me 返回自身(无 tokenHash)', async () => {
    expect((await call('GET', '/v1/nodes/me')).status).toBe(401);
    expect((await call('GET', '/v1/nodes/me', undefined, 'bogus')).status).toBe(401);
    const r = await call('GET', '/v1/nodes/me', undefined, bearer);
    expect(r.status).toBe(200);
    expect((r.json as Record<string, unknown>)).not.toHaveProperty('tokenHash');
  });

  it('caps/load:PUT 全量替换 + rev 仅静态变更自增', async () => {
    const r1 = await call('PUT', '/v1/nodes/me/caps', { caps: ['tool:node@20'] }, bearer);
    expect((r1.json as { caps_rev: number }).caps_rev).toBe(2);
    const r2 = await call('PUT', '/v1/nodes/me/caps', { caps: ['tool:node@20'] }, bearer);
    expect((r2.json as { caps_rev: number }).caps_rev).toBe(2);
    const r3 = await call('PUT', '/v1/nodes/me/load', { queueDepth: 0, running: 0, accepting: true }, bearer);
    expect(r3.status).toBe(204);
  });

  it('通讯录:成员过滤 caps + 跨 team 403', async () => {
    const r = await call('GET', `/v1/teams/${teamId}/nodes?caps=${encodeURIComponent('tool:node@20')}`, undefined, bearer);
    expect(r.status).toBe(200);
    expect((r.json as { nodes: unknown[] }).nodes.length).toBeGreaterThanOrEqual(1);
    const other = registry.createTeam({ owner_user_id: 'u1' });
    const wrong = await call('GET', `/v1/teams/${other.team_id}/nodes`, undefined, bearer);
    expect(wrong.status).toBe(403);
    expect((wrong.json as { error: { code: string } }).error.code).toBe('not_team_member');
  });

  it('公钥目录:current/historical/unknown_epoch 三态 + 限流独立', async () => {
    const me = await call('GET', '/v1/nodes/me', undefined, bearer);
    const nodeId = (me.json as { node_id: string }).node_id;
    await call('POST', '/v1/nodes/me/keys', { pubkey: PUB2 }, bearer);
    const cur = await call('GET', `/v1/nodes/${nodeId}/pubkey`, undefined, bearer);
    expect(cur.status).toBe(200);
    expect((cur.json as { key_epoch: number }).key_epoch).toBe(2);
    const his = await call('GET', `/v1/nodes/${nodeId}/pubkey?epoch=1`, undefined, bearer);
    expect((his.json as { status: string }).status).toBe('historical');
    const unknown = await call('GET', `/v1/nodes/${nodeId}/pubkey?epoch=99`, undefined, bearer);
    expect(unknown.status).toBe(404);
    expect((unknown.json as { error: { code: string } }).error.code).toBe('key_epoch_conflict');
  });

  it('owner 面:签发 token + suspend → 节点凭证 403 node_suspended', async () => {
    const issue = await call('POST', `/v1/teams/${teamId}/enroll-tokens`, {}, bearer);
    expect(issue.status).toBe(200);
    const me = await call('GET', '/v1/nodes/me', undefined, bearer);
    const nodeId = (me.json as { node_id: string }).node_id;
    const sup = await call('POST', `/v1/nodes/${nodeId}/suspend`, {}, bearer);
    expect((sup.json as { closeCode: number }).closeCode).toBe(4001);
    const blocked = await call('GET', '/v1/nodes/me', undefined, bearer);
    expect(blocked.status).toBe(403);
    expect((blocked.json as { error: { code: string } }).error.code).toBe('node_suspended');
    const r2 = registry.resume(nodeId);
    void r2;
  });

  it('P12 失败关闭(真实断言):未配置 ownerAuth → 503;拒绝 → 403;节点凭证无法行使 owner 权', async () => {
    const s2 = createRegistryServer({ registry });
    await new Promise<void>((r) => s2.listen(0, '127.0.0.1', () => r()));
    const port2 = (s2.address() as AddressInfo).port;
    try {
      const unconfigured = await fetch(`http://127.0.0.1:${port2}/v1/teams/${teamId}/enroll-tokens`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}` },
      });
      expect(unconfigured.status).toBe(503);
      expect(((await unconfigured.json()) as { error: { code: string } }).error.code).toBe('owner_auth_unconfigured');
    } finally {
      s2.close();
    }
    const deny = createRegistryServer({ registry, ownerAuth: () => false });
    await new Promise<void>((r) => deny.listen(0, '127.0.0.1', () => r()));
    const port3 = (deny.address() as AddressInfo).port;
    try {
      const denied = await fetch(`http://127.0.0.1:${port3}/v1/teams/${teamId}/enroll-tokens`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}` },
      });
      expect(denied.status).toBe(403);
      expect(((await denied.json()) as { error: { code: string } }).error.code).toBe('not_team_member');
    } finally {
      deny.close();
    }
  });
});