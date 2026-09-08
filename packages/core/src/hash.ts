import { sha256 } from '@noble/hashes/sha2.js';

const te = new TextEncoder();

export function sha256Hex(text: string): string {
  const digest = sha256(te.encode(text));
  let out = '';
  for (const b of digest) out += b.toString(16).padStart(2, '0');
  return out;
}