/**
 * payload_ref 临时拉取器(M3.4/R10,评审 I-18):
 * scheme 白名单(https + 本地测试用 http-回环白名单模式)、私网/环回默认禁止、
 * size 上限预检(超限拒绝不预取)、sha256 校验。存储选型定稿后由 §8.4 方案替换。
 */
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

export interface PayloadRef {
  ref_uri?: string;
  repo?: string;
  path?: string;
  sha256: string;
  size: number;
}

export interface FetchPolicy {
  /** scheme 白名单,默认仅 https(R10;测试可加 http-回环) */
  allowedSchemes?: string[];
  /** 节点策略显式放行的主机(默认禁止环回/link-local/私网,R10) */
  allowHosts?: string[];
  /** 单负载字节上限(默认 256MB) */
  maxBytes?: number;
}

export interface FetchCheck {
  ok: boolean;
  reason?: string;
}

const DEFAULT_SCHEMES = ['https'];

export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  const ip = isIP(h);
  if (ip === 4) {
    const parts = h.split('.').map(Number);
    const [a, b] = [parts[0] ?? 0, parts[1] ?? 0];
    if (a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
  }
  if (ip === 6) {
    if (h === '::1' || h === '::') return true;
    if (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true;
  }
  return false;
}

/** 上取前静态校验(不发起网络请求):scheme 白名单/私网拒绝/size 预检 */
export function checkPayloadRef(ref: PayloadRef, policy: FetchPolicy = {}): FetchCheck {
  const schemes = policy.allowedSchemes ?? DEFAULT_SCHEMES;
  if (!ref.ref_uri && !ref.repo) return { ok: false, reason: 'payload_ref: ref_uri 与 repo 至少其一' };
  if (ref.repo) {
    if (!ref.repo.startsWith('https://')) return { ok: false, reason: 'repo 仅允许 https(R10)' };
  }
  if (ref.ref_uri) {
    let u: URL;
    try {
      u = new URL(ref.ref_uri);
    } catch {
      return { ok: false, reason: 'ref_uri 不可解析' };
    }
    if (!schemes.includes(u.protocol.replace(':', ''))) {
      return { ok: false, reason: `scheme 不在白名单(${schemes.join('/')})` };
    }
    const host = u.hostname.toLowerCase();
    const norm = (h: string): string => (h.split(':')[0] ?? '');
    const allowed = policy.allowHosts?.some((a) => norm(a) === norm(host)) ?? false;
    if (!allowed && isPrivateHost(host)) {
      return { ok: false, reason: `目标 ${host} 属环回/私网,默认禁止(R10;例外须节点策略白名单)` };
    }
  }
  if (!Number.isSafeInteger(ref.size) || ref.size < 0) return { ok: false, reason: 'size 非法' };
  if (policy.maxBytes !== undefined && ref.size > policy.maxBytes) {
    return { ok: false, reason: `size ${ref.size} 超过上限 ${policy.maxBytes}` };
  }
  return { ok: true };
}

export interface FetchResult {
  ok: boolean;
  reason?: string;
  data?: Buffer;
}

/**
 * 拉取 + sha256/size 校验(R10)。调用方:执行方驱动在启动任务前取负载;
 * 本函数不感知任务语义(P3/P11)。
 */
export async function fetchPayload(
  ref: PayloadRef,
  policy: FetchPolicy = {},
  fetchImpl: (uri: string) => Promise<{ ok: boolean; status: number; body: Buffer }> = defaultFetch,
): Promise<FetchResult> {
  const check = checkPayloadRef(ref, policy);
  if (!check.ok) return { ok: false, reason: check.reason };
  if (!ref.ref_uri) return { ok: false, reason: 'v0.1 临时拉取器仅支持 ref_uri(repo 拉取随 §8.4 定稿)' };
  let res: { ok: boolean; status: number; body: Buffer };
  try {
    res = await fetchImpl(ref.ref_uri);
  } catch (e) {
    return { ok: false, reason: 'payload 拉取失败:' + String(e) };
  }
  if (!res.ok || res.status !== 200) {
    return { ok: false, reason: `payload 拉取 HTTP ${res.status}` };
  }
  if (ref.size !== undefined && res.body.length !== ref.size) {
    return { ok: false, reason: `size 不符:声明 ${ref.size},实际 ${res.body.length}` };
  }
  const digest = createHash('sha256').update(res.body).digest('hex');
  if (digest !== ref.sha256.toLowerCase()) {
    return { ok: false, reason: 'sha256 校验失败(payload_corrupt)' };
  }
  return { ok: true, data: res.body };
}

async function defaultFetch(uri: string): Promise<{ ok: boolean; status: number; body: Buffer }> {
  const res = await fetch(uri);
  const body = Buffer.from(await res.arrayBuffer());
  return { ok: res.ok, status: res.status, body };
}
