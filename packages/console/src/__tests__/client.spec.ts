import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('api request', () => {
  it.each([
    { method: 'GET', send: () => api.get('/v1/example'), body: undefined },
    { method: 'POST', send: () => api.post('/v1/example', { name: 'test' }), body: '{"name":"test"}' },
    { method: 'PATCH', send: () => api.patch('/v1/example', { name: 'test' }), body: '{"name":"test"}' },
    { method: 'DELETE', send: () => api.del('/v1/example'), body: undefined },
  ])('$method 保持请求签名、JSON 结果、Cookie 和 CSRF 头', async ({ method, send, body }) => {
    setCsrf('unit-test-csrf');
    fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

    await expect(send()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/v1/example'), {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-Token': 'unit-test-csrf',
      },
      body,
      credentials: 'include',
    });
  });

  it.each([
    { status: 204, body: null },
    { status: 200, body: '' },
    { status: 200, body: ' \n\t' },
  ])('成功响应 $status / "$body" 返回 undefined', async ({ status, body }) => {
    fetchMock.mockResolvedValueOnce(new Response(body, { status }));
    await expect(api.post<void>('/v1/example')).resolves.toBeUndefined();
  });

  it('非空的损坏 JSON 不会被当作空响应吞掉', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{broken', { status: 200 }));
    await expect(api.get('/v1/example')).rejects.toBeInstanceOf(SyntaxError);
  });

  it.each([
    { body: '{"error":{"message":"具体错误"}}', message: '具体错误' },
    { body: '{"error":{"message":"嵌套错误"},"message":"旧错误"}', message: '嵌套错误' },
    { body: '{"message":"旧格式错误"}', message: '旧格式错误' },
    { body: '{}', message: 'HTTP 422' },
    { body: 'null', message: 'HTTP 422' },
    { body: '{"error":{"message":123}}', message: 'HTTP 422' },
    { body: '', message: 'HTTP 422' },
    { body: '<html>error</html>', message: 'HTTP 422' },
  ])('错误响应 "$body" 提取 message 或回退状态码', async ({ body, message }) => {
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 422 }));
    await expect(api.post('/v1/example')).rejects.toThrow(message);
    expect(locationStub.hash).toBe('#/teams');
  });

  it.each([true, false])('401 清理 CSRF，存在 window 时跳登录 (window=%s)', async (hasWindow) => {
    if (!hasWindow) vi.stubGlobal('window', undefined);
    setCsrf('unit-test-expired-csrf');
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 401 }));

    await expect(api.get('/v1/example')).rejects.toThrow('未认证');
    expect(locationStub.hash).toBe(hasWindow ? '#/login' : '#/teams');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.post<void>('/v1/example');
    expect(fetchMock.mock.calls[1]?.[1]?.headers).not.toHaveProperty('X-CSRF-Token');
  });

  it.each([
    { code: 'csrf_mismatch', message: 'CSRF 校验失败' },
    { code: 'forbidden', message: '当前账号没有此团队权限' },
  ])('403 $code 保留具体错误、CSRF 和当前路由', async (error) => {
    setCsrf('unit-test-valid-csrf');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error }), { status: 403 }));

    await expect(api.post('/v1/example')).rejects.toThrow(error.message);
    expect(locationStub.hash).toBe('#/teams');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.post<void>('/v1/example');
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toHaveProperty('X-CSRF-Token', 'unit-test-valid-csrf');
  });

  it('网络错误原样拒绝，不伪装成成功或未认证', async () => {
    const error = new TypeError('mock network failure');
    fetchMock.mockRejectedValueOnce(error);
    await expect(api.get('/v1/example')).rejects.toBe(error);
    expect(locationStub.hash).toBe('#/teams');
  });
});