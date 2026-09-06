/**
 * Ed25519 签名/验签(D23)。
 * signature_input = JCS(信封剔除整个 sig 对象);算法白名单 v1 仅 ed25519;
 * 密钥选择只依赖被签名的 from.key_epoch,不依赖任何自报密钥标识。
 */
import { etc, getPublicKey, sign, verify } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import type { EnvelopeV1 } from './envelope.js';
import { jcs } from './jcs.js';

export type Bytes = Uint8Array;

// @noble/ed25519 v2:同步/异步计算均需注入 sha512(README 标准接法)
etc.sha512Sync = (...m: Bytes[]) => sha512(etc.concatBytes(...m));
etc.sha512Async = (...m: Bytes[]) => Promise.all(m).then((i) => sha512(etc.concatBytes(...i)));

const te = new TextEncoder();

export const SUPPORTED_ALGS = ['ed25519'] as const;

export type SigVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_sig' | 'alg_not_allowed' | 'unknown_key' | 'bad_sig' };

export function signatureInput(env: EnvelopeV1): string {
  const { sig: _sig, ...rest } = env;
  return jcs(rest);
}

export function signEnvelope(env: EnvelopeV1, priv: Bytes): EnvelopeV1 {
  const value = sign(te.encode(signatureInput(env)), priv);
  return { ...env, sig: { alg: 'ed25519', value: toBase64(value) } };
}

/**
 * 验签。getPublicKeyByEpoch 由调用方提供(注册中心目录/本地缓存,02 §6.2):
 * 查无 (node_id, key_epoch) → unknown_key;缓存/目录由上层按现势性规则复核。
 */
export function verifyEnvelopeSig(
  env: EnvelopeV1,
  getPublicKeyByEpoch: (nodeId: string, keyEpoch: number) => Bytes | null | Promise<Bytes | null>,
): Promise<SigVerifyResult> {
  const sig = env.sig;
  if (!sig) return Promise.resolve({ ok: false, reason: 'missing_sig' });
  if (!(SUPPORTED_ALGS as readonly string[]).includes(sig.alg)) {
    return Promise.resolve({ ok: false, reason: 'alg_not_allowed' });
  }
  return Promise.resolve(getPublicKeyByEpoch(env.from.node_id, env.from.key_epoch)).then((pub) => {
    if (!pub) return { ok: false, reason: 'unknown_key' };
    const okFlag = verify(fromBase64(sig.value), te.encode(signatureInput(env)), pub);
    return okFlag ? { ok: true } : { ok: false, reason: 'bad_sig' };
  });
}

/** 入网时生成密钥对:32 字节随机种子;公钥登记于注册中心(02 §3.2) */
export function newKeyPair(): { priv: Bytes; publicKey: Uint8Array } {
  const priv = new Uint8Array(32);
  globalThis.crypto.getRandomValues(priv);
  return { priv, publicKey: getPublicKey(priv) };
}

export function toBase64(b: Bytes): string {
  return Buffer.from(b).toString('base64');
}

export function fromBase64(s: string): Bytes {
  return new Uint8Array(Buffer.from(s, 'base64'));
}