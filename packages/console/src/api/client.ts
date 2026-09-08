const BASE = import.meta.env.VITE_QLONG_API ?? 'http://127.0.0.1:3200';
let csrfToken = '';
export function setCsrf(t: string) { csrfToken = t; }
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'include' });
  if (res.status === 401) { window.location.hash = '#/login'; throw new Error('未认证'); }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}
export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b),
  del: <T>(p: string) => request<T>('DELETE', p),
  patch: <T>(p: string, b?: unknown) => request<T>('PATCH', p, b),
};