/**
 * 节点身份存档(02 §3.2 双凭证之"身份"半边)。
 * 私钥 = Ed25519 seed(32 字节); enroll 时以 pubkey 注册,此后 factory 从同一存档恢复。
 * 权限 0600:私钥落盘最小暴露面(评审 I-16)。
 */
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newKeyPair, publicKeyFromPrivate, toBase64 } from '@qlong/core';

export interface NodeIdentity {
  priv: Uint8Array;
  pubkeyB64: string;
}

/** Enrolled nodes must restore their original identity, never generate a replacement. */
export function loadIdentity(dataDir: string): NodeIdentity {
  const file = join(dataDir, 'identity.json');
  try {
    if (!lstatSync(file).isFile()) throw new Error('not a regular identity file');
    const j: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('invalid identity');
    const doc = j as Record<string, unknown>;
    if (typeof doc.priv_b64 !== 'string' || typeof doc.pubkey_b64 !== 'string') throw new Error('invalid identity');
    const priv = new Uint8Array(Buffer.from(doc.priv_b64, 'base64'));
    if (priv.length !== 32 || toBase64(priv) !== doc.priv_b64 ||
        toBase64(publicKeyFromPrivate(priv)) !== doc.pubkey_b64) throw new Error('identity mismatch');
    return { priv, pubkeyB64: doc.pubkey_b64 };
  } catch {
    // Parser errors can contain key material: never propagate file contents.
    throw new Error('节点身份缺失或损坏:请恢复原身份存档,不会自动生成替代密钥');
  }
}

/** Enrollment only: exclusive creation, never overwrite an existing identity. */
export function loadOrCreateIdentity(dataDir: string): NodeIdentity {
  const file = join(dataDir, 'identity.json');
  try {
    lstatSync(file);
    return loadIdentity(dataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const kp = newKeyPair();
  const doc = {
    pubkey_b64: Buffer.from(kp.publicKey).toString('base64'),
    priv_b64: Buffer.from(kp.priv).toString('base64'),
  };
  writeFileSync(file, JSON.stringify(doc, null, 2), { mode: 0o600, flag: 'wx' });
  return { priv: kp.priv, pubkeyB64: doc.pubkey_b64 };
}
