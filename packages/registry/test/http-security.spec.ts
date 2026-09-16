import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthService, SESSION_COOKIE, type UserRole } from '../src/auth.js';
import { Registry } from '../src/directory.js';
import { createRegistryServer, type RegistryServerOptions } from '../src/http.js';

const PUB = Buffer.alloc(32, 1).toString('base64');

describe('registry HTTP 安全入口', () => {
  let registry: Registry;
  let opts: RegistryServerOptions;
  let server: ReturnType<typeof createRegistryServer>;
  let base: string;
  let teamId: string;
  let otherId: string;
  let target: ReturnType<Registry['enroll']>;
  let member: ReturnType<Registry['enroll']>;

  beforeEach(async () => {
    registry = new Registry();
    teamId = registry.createTeam({ owner_user_id: 'test-owner' }).team_id;
    otherId = registry.createTeam({ owner_user_id: 'other-owner' }).team_id;
    target = registry.enroll({ token: registry.issueEnrollToken(teamId), pubkey: PUB });
    member = registry.enroll({ token: registry.issueEnrollToken(teamId), pubkey: PUB });
    opts = { registry, ownerAuth: (req, team) => req.headers['x-test-owner-team'] === team };
    server = createRegistryServer(opts);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
    const requestHeaders = new Headers(headers);
    if (!requestHeaders.has('content-type')) requestHeaders.set('content-type', 'application/json');
    const res = await fetch(base + path, {
      method, headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie') };
  }
  function login(username = 'test-owner', role: UserRole = 'global_owner') {
    const auth = new AuthService();
    const password = randomUUID();
    auth.register(username, password);
    // 仅本地测试夹具创建普通账户,使用真实密码登录签发会话,不伪造 Cookie。
    auth.users.get(username)!.role = role;
    const session = auth.login(username, password);
    opts.auth = auth;
    return { Cookie: `${SESSION_COOKIE}=${session.sessionId}`, 'X-CSRF-Token': session.csrf };
  }

  it('有效普通会话没有资源 owner 权时不能读取其他团队、无主团队或全局清单', async () => {
    const headers = login('other-owner', 'user');
    opts.ownerAuth = () => true; // 不得从会话权限失败退回宽松回调。
    const orphanId = registry.createTeam().team_id;
    expect((await call('GET', '/v1/auth/me', headers)).status).toBe(200);
    expect((await call('GET', '/v1/teams', headers)).status).toBe(403);
    for (const team of [teamId, orphanId, 'missing-team']) {
      for (const resource of ['overview', 'nodes', 'tasks', 'audit', 'grants']) {
        const res = await call('GET', `/v1/teams/${team}/${resource}`, headers);
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ error: { code: 'not_team_member' } });
      }
    }
  });

  it('有效普通会话加正确 CSRF 仍不能管理非自身团队的节点、grant 或 enroll-token', async () => {
    const headers = login('other-owner', 'user');
    opts.ownerAuth = () => true;
    const grant = registry.createGrant({ from_team: teamId, to_team: otherId });
    const before = registry.directoryEpoch;
    const paths = [
      ['POST', `/v1/teams/${teamId}/nodes/${target.node_id}/suspend`],
      ['POST', `/v1/teams/${teamId}/nodes/${target.node_id}/resume`],
      ['POST', `/v1/nodes/${target.node_id}/suspend`],
      ['POST', `/v1/nodes/${target.node_id}/revoke`],
      ['POST', `/v1/teams/${teamId}/enroll-tokens`],
      ['POST', `/v1/teams/${teamId}/grants`],
      ['DELETE', `/v1/teams/${teamId}/grants/${grant.grant_id}`],
      ['DELETE', `/v1/teams/${otherId}/grants/${grant.grant_id}`],
      ['POST', `/v1/teams/${otherId}/nodes/${target.node_id}/suspend`],
    ] as const;
    for (const [method, path] of paths) {
      const res = await call(method, path, headers, { to_team: otherId });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: { code: 'not_team_member' } });
      expect(registry.directoryEpoch).toBe(before);
      expect(registry.grants.size).toBe(1);
      expect(registry.grants.has(grant.grant_id)).toBe(true);
      expect(registry.getNode(target.node_id)?.status).toBe('active');
    }
  });

  it('普通 user 仅凭当前 owner_user_id 匹配可读取和管理自己的团队', async () => {
    const headers = login('test-owner', 'user');
    expect((await call('GET', '/v1/teams', headers)).status).toBe(403);
    for (const resource of ['overview', 'nodes', 'tasks', 'audit', 'grants']) {
      expect((await call('GET', `/v1/teams/${teamId}/${resource}`, headers)).status).toBe(200);
    }
    expect((await call('POST', `/v1/nodes/${target.node_id}/suspend`, headers)).status).toBe(200);
    expect((await call('POST', `/v1/teams/${teamId}/nodes/${target.node_id}/resume`, headers)).status).toBe(200);
    expect((await call('POST', `/v1/teams/${teamId}/enroll-tokens`, headers)).status).toBe(200);
    const grant = await call('POST', `/v1/teams/${teamId}/grants`, headers, { to_team: otherId });
    expect(grant.status).toBe(200);
    const grantId = (grant.body as { grant_id: string }).grant_id;
    expect((await call('DELETE', `/v1/teams/${teamId}/grants/${grantId}`, headers)).status).toBe(200);
    registry.teams.get(teamId)!.owner_user_id = 'other-owner';
    expect((await call('GET', `/v1/teams/${teamId}/overview`, headers)).status).toBe(403);
    expect((await call('POST', `/v1/nodes/${target.node_id}/suspend`, headers)).status).toBe(403);
    expect(registry.getNode(target.node_id)?.status).toBe('active');
  });

  it('global_owner 显式跨团队授权;当前用户降级后旧管理员会话立即失去全局权限', async () => {
    const headers = login();
    const orphanId = registry.createTeam().team_id;
    expect((await call('GET', '/v1/teams', headers)).status).toBe(200);
    for (const team of [otherId, orphanId]) {
      expect((await call('GET', `/v1/teams/${team}/overview`, headers)).status).toBe(200);
      expect((await call('POST', `/v1/teams/${team}/enroll-tokens`, headers)).status).toBe(200);
    }
    opts.auth!.users.get('test-owner')!.role = 'user';
    expect((await call('GET', '/v1/auth/me', headers)).status).toBe(200);
    expect((await call('GET', '/v1/teams', headers)).status).toBe(403);
    expect((await call('GET', `/v1/teams/${teamId}/overview`, headers)).status).toBe(200);
    for (const team of [otherId, orphanId]) {
      expect((await call('GET', `/v1/teams/${team}/overview`, headers)).status).toBe(403);
      expect((await call('POST', `/v1/teams/${team}/enroll-tokens`, headers)).status).toBe(403);
    }
  });

  it.each(['user', 'session'] as const)('未知 %s 角色即使用户名匹配团队 owner 也拒绝,AuthError 映射 403', async (record) => {
    const headers = login();
    const invalid = record === 'user' ? opts.auth!.users.get('test-owner')! : [...opts.auth!.sessions.values()][0]!;
    Object.assign(invalid, { role: 'unrecognized' });
    const before = registry.directoryEpoch;
    for (const [method, path] of [
      ['GET', '/v1/auth/me'], ['GET', '/v1/teams'],
      ['GET', `/v1/teams/${teamId}/overview`], ['POST', `/v1/nodes/${target.node_id}/suspend`],
    ] as const) {
      const res = await call(method, path, headers);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: { code: 'auth_error' } });
      expect(registry.directoryEpoch).toBe(before);
    }
  });

  it('正确密码也不能为未知角色签发会话,登录 AuthError 映射 403 而不是 500', async () => {
    opts.auth = new AuthService();
    const body = { username: 'test-owner', password: randomUUID() };
    opts.auth.register(body.username, body.password);
    Object.assign(opts.auth.users.get(body.username)!, { role: 'unrecognized' });
    const res = await call('POST', '/v1/auth/login', {}, body);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: 'auth_failed' } });
    expect(res.cookie === null).toBe(true);
    expect(opts.auth.sessions.size).toBe(0);
  });

  it('没有任何资源所有权的普通会话可以 CSRF 安全登出,匿名/失效会话不能登出', async () => {
    const headers = login('unaffiliated-user', 'user');
    expect((await call('GET', '/v1/teams', headers)).status).toBe(403);
    expect((await call('POST', '/v1/auth/logout')).status).toBe(401);
    for (const csrf of [undefined, 'incorrect']) {
      const res = await call('POST', '/v1/auth/logout', {
        Cookie: headers.Cookie, ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: { code: 'csrf_mismatch' } });
      expect((await call('GET', '/v1/auth/me', headers)).status).toBe(200);
    }
    const res = await call('POST', '/v1/auth/logout', headers);
    expect(res.status).toBe(200);
    expect(res.cookie?.includes('Max-Age=0')).toBe(true);
    expect(opts.auth!.sessions.size).toBe(0);
    expect((await call('GET', '/v1/auth/me', headers)).status).toBe(401);
    expect((await call('POST', '/v1/auth/logout', headers)).status).toBe(401);
  });

  it.each(['suspend', 'resume'])('team %s 是 owner-only,普通成员/匿名/异队 owner 都不得操作', async (action) => {
    if (action === 'resume') registry.suspend(target.node_id);
    const before = registry.directoryEpoch;
    const path = `/v1/teams/${teamId}/nodes/${target.node_id}/${action}`;
    const deniedHeaders: Array<Record<string, string>> = [{}, { Authorization: `Bearer ${member.node_token}` }, { 'X-Test-Owner-Team': otherId }];
    for (const headers of deniedHeaders) {
      expect((await call('POST', path, headers)).status).toBe(403);
      expect(registry.directoryEpoch).toBe(before);
    }
    expect((await call('POST', path, { 'X-Test-Owner-Team': teamId })).status).toBe(200);
    expect(registry.getNode(target.node_id)?.status).toBe(action === 'resume' ? 'active' : 'suspended');
  });

  it.each(['suspend', 'resume'])('team %s 必须验证目标属于 URL team,即使有 URL team owner 权也拒绝', async (action) => {
    if (action === 'resume') registry.suspend(target.node_id);
    const before = registry.directoryEpoch;
    const res = await call('POST', `/v1/teams/${otherId}/nodes/${target.node_id}/${action}`, { 'X-Test-Owner-Team': otherId });
    expect(res.status).toBe(403);
    expect(registry.directoryEpoch).toBe(before);
  });

  it.each(['suspend', 'revoke'])('节点 %s 管理只要求 owner,不提前要求 node token', async (action) => {
    expect((await call('POST', `/v1/nodes/${target.node_id}/${action}`, { 'X-Test-Owner-Team': teamId })).status).toBe(200);
    expect(registry.getNode(target.node_id)?.status).toBe(action === 'suspend' ? 'suspended' : 'revoked');
  });

  it('owner 检查期间目标换队也不能沿用旧团队授权', async () => {
    opts.ownerAuth = async () => {
      registry.joinTeam(target.node_token, registry.issueEnrollToken(otherId));
      return true;
    };
    expect((await call('POST', `/v1/nodes/${target.node_id}/suspend`)).status).toBe(403);
    expect(registry.getNode(target.node_id)?.status).toBe('active');
  });

  it('owner 未配置时 team 与 node 管理均失败关闭', async () => {
    opts.ownerAuth = undefined;
    for (const path of [`/v1/nodes/${target.node_id}/suspend`, `/v1/teams/${teamId}/nodes/${target.node_id}/resume`]) {
      const res = await call('POST', path, { Authorization: `Bearer ${member.node_token}` });
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ error: { code: 'owner_auth_unconfigured' } });
    }
  });

  it('外部 Cookie owner 回调无会话 CSRF 验证时不得放行', async () => {
    opts.ownerAuth = () => true;
    const before = registry.directoryEpoch;
    expect((await call('POST', `/v1/nodes/${target.node_id}/suspend`, { Cookie: 'external-session=test-fixture' })).status).toBe(403);
    expect(registry.directoryEpoch).toBe(before);
  });

  it('grant 删除只允许来源 team owner;接收方和无关 URL team 均不能删除', async () => {
    const grant = registry.createGrant({ from_team: teamId, to_team: otherId });
    const unrelated = registry.createTeam({ owner_user_id: 'unrelated' }).team_id;
    const before = registry.directoryEpoch;
    for (const team of [otherId, unrelated]) {
      expect((await call('DELETE', `/v1/teams/${team}/grants/${grant.grant_id}`, { 'X-Test-Owner-Team': team })).status).toBe(403);
      expect(registry.grants.has(grant.grant_id)).toBe(true);
      expect(registry.directoryEpoch).toBe(before);
    }
    expect((await call('DELETE', `/v1/teams/${teamId}/grants/${grant.grant_id}`, { Authorization: `Bearer ${member.node_token}` })).status).toBe(403);
    expect((await call('DELETE', `/v1/teams/${teamId}/grants/${grant.grant_id}`, { 'X-Test-Owner-Team': teamId })).status).toBe(200);
    expect(registry.grants.has(grant.grant_id)).toBe(false);
  });

  it('Cookie 写操作统一检查 CSRF,包括 team 管理、节点管理、grant、enroll-token 和 logout', async () => {
    const headers = login();
    const grant = registry.createGrant({ from_team: teamId, to_team: otherId });
    const paths = [
      ['POST', `/v1/teams/${teamId}/nodes/${target.node_id}/suspend`],
      ['POST', `/v1/teams/${teamId}/nodes/${target.node_id}/resume`],
      ['POST', `/v1/nodes/${target.node_id}/suspend`],
      ['POST', `/v1/nodes/${target.node_id}/revoke`],
      ['POST', `/v1/teams/${teamId}/enroll-tokens`],
      ['POST', `/v1/teams/${teamId}/grants`],
      ['DELETE', `/v1/teams/${teamId}/grants/${grant.grant_id}`],
      ['POST', '/v1/auth/logout'],
      ['PATCH', '/v1/nodes/me'],
      ['PUT', '/v1/nodes/me/caps'],
      ['PUT', '/v1/nodes/me/load'],
      ['POST', '/v1/nodes/me/keys'],
      ['POST', '/v1/enroll'],
      ['POST', '/v1/auth/login'],
      ['POST', '/v1/auth/register'],
    ] as const;
    const before = registry.directoryEpoch;
    for (const [method, path] of paths) {
      for (const csrf of [undefined, 'incorrect']) {
        const res = await call(method, path, {
          Cookie: headers.Cookie, Authorization: `Bearer ${target.node_token}`,
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        }, {});
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ error: { code: 'csrf_mismatch' } });
        expect(registry.directoryEpoch).toBe(before);
      }
    }
    expect((await call('GET', '/v1/auth/me', { Cookie: headers.Cookie })).status).toBe(200);
    expect((await call('POST', `/v1/nodes/${target.node_id}/suspend`, headers)).status).toBe(200);
    expect((await call('POST', `/v1/teams/${teamId}/nodes/${target.node_id}/resume`, headers)).status).toBe(200);
    expect((await call('POST', '/v1/auth/logout', headers)).status).toBe(200);
    expect((await call('GET', '/v1/auth/me', { Cookie: headers.Cookie })).status).toBe(401);
  });

  it.each(['register', 'login'])('公开 %s 的 Cookie 签发拒绝简单表单请求和跨站请求', async (route) => {
    opts.auth = new AuthService();
    const body = { username: 'test-owner', password: randomUUID() };
    if (route === 'login') opts.auth.register(body.username, body.password);
    const simple = await call('POST', `/v1/auth/${route}`, { 'Content-Type': 'text/plain' }, body);
    expect(simple.status).toBe(400);
    expect(simple.cookie).toBeNull();
    const crossSite = await call('POST', `/v1/auth/${route}`, { 'Sec-Fetch-Site': 'cross-site' }, body);
    expect(crossSite.status).toBe(403);
    expect(crossSite.cookie).toBeNull();
    expect(opts.auth.sessions.size).toBe(0);
  });

  it('过期 Cookie 不阻止经 JSON 保护的密码重登,也不能授权其他写操作', async () => {
    opts.auth = new AuthService();
    const body = { username: 'test-owner', password: randomUUID() };
    opts.auth.register(body.username, body.password);
    const expired = opts.auth.login(body.username, body.password);
    opts.auth.logout(expired.sessionId);
    const headers = { Cookie: `${SESSION_COOKIE}=${expired.sessionId}` };
    expect((await call('POST', `/v1/nodes/${target.node_id}/suspend`, headers)).status).toBe(401);
    expect((await call('POST', '/v1/auth/login', { ...headers, 'Content-Type': 'text/plain' }, body)).status).toBe(400);
    expect((await call('POST', '/v1/auth/login', headers, body)).status).toBe(200);
  });

  it('注册写入失败返回 503,不签发 Cookie/会话,不重新开放初始化', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlong-http-auth-security-'));
    try {
      opts.auth = new AuthService({ persistDir: dir });
      mkdirSync(join(dir, 'users.json'));
      const body = { username: 'test-owner', password: randomUUID() };
      const res = await call('POST', '/v1/auth/register', {}, body);
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ error: { code: 'auth_error' } });
      expect(res.cookie).toBeNull();
      expect(opts.auth.users.size).toBe(0);
      expect(opts.auth.sessions.size).toBe(0);
      expect((await call('GET', '/v1/auth/status')).body).toEqual({ needs_init: false });
      expect((await call('POST', '/v1/auth/login', {}, body)).status).toBe(503);
      // AuthError 也可能从路由公共会话检查直接抛出,不得变成 internal_error/500。
      for (const path of ['/v1/auth/me', '/v1/teams', `/v1/teams/${teamId}/overview`]) {
        const unavailable = await call('GET', path);
        expect(unavailable.status).toBe(503);
        expect(unavailable.body).toMatchObject({ error: { code: 'auth_error' } });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('me 使用字段白名单,空公钥纪元不能返回不明确的成功身份', async () => {
    const node = registry.getNode(target.node_id)!;
    Object.assign(node, { internalCredential: 'test-only-field' });
    Object.assign(node.keys[0]!, { internalCredential: 'test-only-field' });
    const headers = { Authorization: `Bearer ${target.node_token}` };
    const res = await call('GET', '/v1/nodes/me', headers);
    expect(res.body).not.toHaveProperty('internalCredential');
    expect(res.body).toMatchObject({
      pubkeys: [{ epoch: 1, pubkey: PUB }], keys: [{ epoch: 1, pubkey: PUB }],
    });
    node.keys = [];
    expect((await call('GET', '/v1/nodes/me', headers)).status).toBe(503);
  });

  it('轮换缺省拒绝;显式验证器仍不可绕过 token 或缺失签名', async () => {
    const path = '/v1/nodes/me/keys';
    const headers = { Authorization: `Bearer ${target.node_token}` };
    const before = registry.directoryEpoch;
    expect((await call('POST', path, headers, { pubkey: PUB, sig: 'test-signature' })).status).toBe(503);
    opts.verifyRotationSig = () => true;
    expect((await call('POST', path, headers, { pubkey: PUB })).status).toBe(401);
    expect((await call('POST', path, {}, { pubkey: PUB, sig: 'test-signature' })).status).toBe(401);
    opts.verifyRotationSig = () => false;
    expect((await call('POST', path, headers, { pubkey: PUB, sig: 'test-signature' })).status).toBe(401);
    expect(registry.directoryEpoch).toBe(before);
  });

  it('验证器使用当前公钥和纪元:有效 token + 当前私钥才可轮换;篡改/重放均拒绝', async () => {
    const old = generateKeyPairSync('ed25519');
    const next = generateKeyPairSync('ed25519');
    const oldPub = old.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    const nextPub = next.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    const node = registry.enroll({ token: registry.issueEnrollToken(teamId), pubkey: oldPub });
    // 仅测试接入点,不是新增生产签名协议;绑定 node + 当前 epoch + 替换公钥。
    const payload = (nodeId: string, epoch: number, pubkey: string) => Buffer.from(JSON.stringify({ nodeId, epoch, pubkey }));
    opts.verifyRotationSig = (current, input) => {
      const key = current.pubkey === oldPub ? old.publicKey : next.publicKey;
      return verify(null, payload(current.node_id, current.key_epoch, input.pubkey), key, Buffer.from(input.sig!, 'base64'));
    };
    const sig = sign(null, payload(node.node_id, 1, nextPub), old.privateKey).toString('base64');
    const headers = { Authorization: `Bearer ${node.node_token}` };
    expect((await call('POST', '/v1/nodes/me/keys', headers, { pubkey: PUB, sig })).status).toBe(401);
    expect((await call('POST', '/v1/nodes/me/keys', headers, { pubkey: nextPub, sig })).status).toBe(200);
    expect((await call('POST', '/v1/nodes/me/keys', headers, { pubkey: nextPub, sig })).status).toBe(401);
    const me = await call('GET', '/v1/nodes/me', headers);
    expect(me.body).toMatchObject({ key_epoch: 2, pubkeys: [{ epoch: 1, pubkey: oldPub }, { epoch: 2, pubkey: nextPub }] });
    expect(me.body).not.toHaveProperty('tokenHash');
    expect(me.body).not.toHaveProperty('node_token');
  });
});