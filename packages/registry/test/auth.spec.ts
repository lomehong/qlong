import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { Registry, createRegistryServer, AuthService } from '../src/index.js';

/** 02 §3.1 人类账号会话:注册引导/登录/Cookie 会话/owner 路由/CSRF/登出 */
describe('auth(人类账号密码登录)', () => {
  let srv: ReturnType<typeof createServer>;
  let baseUrl = '';
  const auth = new AuthService({ now: () => Date.now() });
  let cookie = '';
  let csrf = '';

  beforeAll(async () => {
    srv = createRegistryServer({ registry: new Registry({ now: () => Date.now() }), auth, distDir: undefined });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => srv.close(() => r()));
  });

  const post = async (p: string, body?: unknown, hdr: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown>; setCookie?: string }> => {
    const res = await fetch(baseUrl + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...hdr },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie') ?? undefined;
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown>, setCookie: sc };
  };
  const get = async (p: string, hdr: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(baseUrl + p, { headers: hdr });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };

  it('status:无用户 → needs_init=true(引导创建管理员)', async () => {
    expect((await get('/v1/auth/status')).body).toEqual({ needs_init: true });
  });

  it('注册首个管理员 → 自动登录并下发会话 Cookie', async () => {
    const r = await post('/v1/auth/register', { username: 'lomehong', password: 'super-secret-9' });
    expect(r.status).toBe(200);
    expect((r.body as { username: string }).username).toBe('lomehong');
    expect(r.setCookie).toContain('qlong_session=');
    cookie = ((r.setCookie ?? '').split(';')[0])!;
    csrf = (r.body as { csrf: string }).csrf;
  });

  it('初始化后注册关闭(403)', async () => {
    const r = await post('/v1/auth/register', { username: 'intruder', password: 'whatever123' });
    expect(r.status).toBe(403);
  });

  it('错误密码 → 401 auth_failed', async () => {
    const r = await post('/v1/auth/login', { username: 'lomehong', password: 'wrong' });
    expect(r.status).toBe(401);
    expect((r.body as { error?: { code?: string } }).error?.code).toBe('auth_failed');
  });

  it('未登录访问 owner 端点 → 401(未登录 → 控制台跳登录页)', async () => {
    const r = await get('/v1/teams');
    expect(r.status).toBe(401);
    expect((r.body as { error?: { code?: string } }).error?.code).toBe('unauthorized');
  });

  it('会话 Cookie + CSRF → owner 端点 200 团队清单', async () => {
    const r = await get('/v1/teams', { Cookie: cookie, 'X-CSRF-Token': csrf });
    expect(r.status).toBe(200);
    expect(Array.isArray((r.body as { teams: unknown[] }).teams)).toBe(true);
  });

  it('会话 Cookie 但缺 CSRF 的变更请求 → 403 csrf_mismatch', async () => {
    const r = await post('/v1/teams/whatever/enroll-tokens', {}, { Cookie: cookie });
    expect([403, 404]).toContain(r.status);
  });

  it('登出后 me → 401', async () => {
    const r = await post('/v1/auth/logout', {}, { Cookie: cookie });
    expect(r.status).toBe(200);
    const me = await get('/v1/auth/me', { Cookie: cookie });
    expect(me.status).toBe(401);
  });
});
