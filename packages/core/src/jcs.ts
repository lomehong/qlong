/**
 * JCS(RFC 8785)规范序列化 —— D23。
 * signature_input = JCS(envelope \ {sig}),跨实现字节级一致是互操作生命线(01 §3.3.2)。
 * 黄金样本:packages/testing/golden/jcs.json 与 test/jcs.spec.ts。
 */
import * as canonicalizeModule from 'canonicalize';

type Serialize = (input: unknown) => string | undefined;

const mod = canonicalizeModule as unknown as Record<string, unknown>;
const impl = (typeof mod === 'function'
  ? mod
  : (mod.default ?? mod.canonicalize ?? mod)) as Serialize;

export function jcs(input: unknown): string {
  const out = impl(input);
  if (typeof out !== 'string') throw new TypeError('JCS: 输入不可序列化');
  return out;
}