import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authApi } from '../api/auth';
import { api, setCsrf } from '../api/client';

const fetchMock = vi.fn<typeof fetch>();
const locationStub = { hash: '#/teams' };

beforeEach(() => {
  setCsrf('');
  fetchMock.mockReset();
  locationStub.hash = '#/teams';
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('window', { location: locationStub });
});

afterEach(() => {
  setCsrf('');
  vi.unstubAllGlobals();
});

describe('authApi logout', () => {
  it.each([
    { status: 200, body: '{}' },
    { status: 200, body: '' },
    { status: 204, body: null },
  ])('通过 api 发送 CSRF，$status 成功后清理且返回 void', async ({ status, body }) => {
    setCsrf('unit-test-session-csrf');
    fetchMock.mockResolvedValueOnce(new Response(body, { status }));

    await expect(authApi.logout()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/v1/auth/logout'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-Token': 'unit-test-session-csrf',
      },
      body: undefined,
      credentials: 'include',
    });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.post<void>('/v1/example');
    expect(fetchMock.mock.calls[1]?.[1]?.headers).not.toHaveProperty('X-CSRF-Token');
  });

  it.each(['login', 'register'] as const)('%s 后无需刷新，logout 即可使用新 CSRF', async (action) => {
    setCsrf('unit-test-old-csrf');
    const result = { username: 'unit-test-user', csrf: 'unit-test-new-csrf' };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(result), { status: 200 }));
    await expect(authApi[action]('unit-test-user', '')).resolves.toEqual(result);

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await authApi.logout();
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toHaveProperty('X-CSRF-Token', result.csrf);
  });

  it.each(['login', 'register'] as const)('%s 失败不会注入响应中的 CSRF 或全局跳登录', async (action) => {
    setCsrf('unit-test-existing-csrf');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      error: { message: '认证失败' }, csrf: 'unit-test-rejected-csrf',
    }), { status: 401 }));

    await expect(authApi[action]('unit-test-user', '')).rejects.toThrow('认证失败');
    expect(locationStub.hash).toBe('#/teams');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await authApi.logout();
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toHaveProperty('X-CSRF-Token', 'unit-test-existing-csrf');
  });

  it.each([
    { status: 403, message: 'CSRF 校验失败' },
    { status: 500, message: '暂时无法登出' },
  ])('logout $status 拒绝并保留具体错误，不清理 CSRF 或跳登录', async ({ status, message }) => {
    setCsrf('unit-test-session-csrf');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message } }), { status }));

    await expect(authApi.logout()).rejects.toThrow(message);
    expect(locationStub.hash).toBe('#/teams');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await authApi.logout();
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toHaveProperty('X-CSRF-Token', 'unit-test-session-csrf');
  });

  it('logout 401 走统一未认证处理，清理 CSRF 并跳登录', async () => {
    setCsrf('unit-test-expired-csrf');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));

    await expect(authApi.logout()).rejects.toThrow('未认证');
    expect(locationStub.hash).toBe('#/login');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.post<void>('/v1/example');
    expect(fetchMock.mock.calls[1]?.[1]?.headers).not.toHaveProperty('X-CSRF-Token');
  });
});