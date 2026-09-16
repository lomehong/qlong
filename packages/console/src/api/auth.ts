/** 人类账号会话(02 §3.1):登录/登出/me;会话经 HttpOnly Cookie 携带 */
import { api, setCsrf } from './client';

export interface LoginResult {
  username: string;
  csrf: string;
}

/** 原始 fetch(需要读取 Set-Cookie 建立的会话;错误形状 {error:{code,message}}) */
async function authFetch<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { username?: string; csrf?: string; error?: { message?: string } };
  if (!res.ok) {
    throw new Error(data.error?.message ?? `HTTP ${res.status}`);
  }
  // 登录/注册后无需刷新页面即可发起带 CSRF 的会话变更请求(包括 logout)。
  if (typeof data.csrf === 'string') setCsrf(data.csrf);
  return data as T;
}

export const authApi = {
  status: async (): Promise<{ needs_init: boolean }> => {
    const res = await fetch('/v1/auth/status');
    return res.json() as Promise<{ needs_init: boolean }>;
  },
  register: (username: string, password: string): Promise<LoginResult> =>
    authFetch<LoginResult>('/v1/auth/register', { username, password }),
  login: (username: string, password: string): Promise<LoginResult> =>
    authFetch<LoginResult>('/v1/auth/login', { username, password }),
  logout: (): Promise<void> => api.post<void>('/v1/auth/logout').then(() => { setCsrf(''); }),
  /** 会话有效 → {username, csrf}(并把 csrf 注入 API 客户端);无效 → 401 */
  me: async (): Promise<{ username: string; csrf: string }> => api.get<{ username: string; csrf: string }>('/v1/auth/me'),
};
