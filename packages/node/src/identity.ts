/**
 * 节点身份存档(02 §3.2 双凭证之"身份"半边)。
 * 私钥 = Ed25519 seed(32 字节); enroll 时以 pubkey 注册,此后 factory 从同一存档恢复。
 * 权限 0600:私钥落盘最小暴露面(评审 I-16)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newKeyPair } from '@qlong/core';

export interface NodeIdentity {
  priv: Uint8Array;
  pubkeyB64: string;
}

export function loadOrCreateIdentity(dataDir: string): NodeIdentity {
  const file = join(dataDir, 'identity.json');
  if (existsSync(file)) {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { pubkey_b64: string; priv_b64: string };
    return { priv: new Uint8Array(Buffer.from(j.priv_b64, 'base64')), pubkeyB64: j.pubkey_b64 };
  }
  mkdirSync(dataDir, { recursive: true });
  const kp = newKeyPair();
  const doc = {
    pubkey_b64: Buffer.from(kp.publicKey).toString('base64'),
    priv_b64: Buffer.from(kp.priv).toString('base64'),
  };
  writeFileSync(file, JSON.stringify(doc, null, 2), { mode: 0o600 });
  return { priv: kp.priv, pubkeyB64: doc.pubkey_b64 };
}
