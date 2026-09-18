/**
 * 跨机接管 bundle 签名封套(第 2 步运维收口;01 §4.4 / C2a 的"人工导出/导入"最后一公里)。
 *
 * `DurableLeadTakeoverBundle` 本体是裸 JSON:`requires_origin_stopped: true` 只是声明性纪律,
 * 代码不强制 —— 能触到 `node.takeover()` 的任何一方持伪造高 attempt bundle 即可劫持任务。
 * 本封套为 bundle 提供 ed25519 签名(签名域 = JCS(bundle),与信封签名同一规范化与信任根):
 * 导出方以操作员持有的 32 字节种子签名,导入方验签后方可交给 `node.takeover()`。
 * 伪造/篡改(任何字段变动都会改变 JCS 字节)→ 验签失败,fail-closed 拒绝接管。
 */
import { fromBase64, jcs, signBytes, toBase64, verifyBytes } from '@qlong/core';
import type { DurableLeadTakeoverBundle } from './lead.js';

export interface SignedTakeoverBundle {
  v: 1;
  bundle: DurableLeadTakeoverBundle;
  sig: { alg: 'ed25519'; value: string };
}

const te = new TextEncoder();

export function signTakeoverBundle(bundle: DurableLeadTakeoverBundle, priv: Uint8Array): SignedTakeoverBundle {
  if (!(priv instanceof Uint8Array) || priv.length !== 32) {
    throw new TypeError('takeover signing key must be a 32-byte ed25519 seed');
  }
  return { v: 1, bundle, sig: { alg: 'ed25519', value: toBase64(signBytes(te.encode(jcs(bundle)), priv)) } };
}

export type TakeoverVerifyResult =
  | { ok: true; bundle: DurableLeadTakeoverBundle }
  | { ok: false; reason: 'malformed' | 'alg_not_allowed' | 'bad_sig' };

export function verifyTakeoverBundle(raw: unknown, pub: Uint8Array): TakeoverVerifyResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'malformed' };
  const w = raw as { v?: unknown; bundle?: unknown; sig?: { alg?: unknown; value?: unknown } };
  if (w.v !== 1 || typeof w.bundle !== 'object' || w.bundle === null) return { ok: false, reason: 'malformed' };
  if (!w.sig || typeof w.sig !== 'object' || w.sig.alg !== 'ed25519' || typeof w.sig.value !== 'string') {
    return { ok: false, reason: 'alg_not_allowed' };
  }
  let value: Uint8Array;
  try {
    value = fromBase64(w.sig.value);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  // 任何字段变动都会改变 JCS 字节 → 验签失败;JCS 与信封签名同一规范化(D23 单一实现)。
  return verifyBytes(value, te.encode(jcs(w.bundle)), pub)
    ? { ok: true, bundle: w.bundle as DurableLeadTakeoverBundle }
    : { ok: false, reason: 'bad_sig' };
}
