/**
 * 能力标签匹配(03 篇 §3.2 定案 / D31,评审 I-30)。
 * 消费方:执行方闸3(packages/node)与注册中心目录过滤(packages/registry)——单一实现,防语义分叉。
 */
export const KNOWN_CAP_CLASSES = ['env', 'tool', 'hw', 'net', 'ext'] as const;
export type CapClass = (typeof KNOWN_CAP_CLASSES)[number];

export interface ParsedTag {
  cls: string;
  value: string;
  /** null = 未声明版本段;否则按 '.' 分段 */
  version: string[] | null;
}

export function parseTag(tag: string): ParsedTag | null {
  const i = tag.indexOf(':');
  if (i <= 0) return null;
  const cls = tag.slice(0, i);
  const rest = tag.slice(i + 1);
  const at = rest.indexOf('@');
  if (at < 0) return { cls, value: rest, version: null };
  return { cls, value: rest.slice(0, at), version: rest.slice(at + 1).split('.') };
}

function isNumeric(s: string): boolean {
  return /^\d+$/.test(s);
}

/** 带 @:按 offer 所写段数逐段比较,数字段按数值;档案段数不足 → 不满足 */
function versionMatch(req: string[], own: string[]): boolean {
  if (own.length < req.length) return false;
  for (let i = 0; i < req.length; i++) {
    const r = req[i] as string;
    const o = own[i] as string;
    if (isNumeric(r) && isNumeric(o)) {
      if (Number(r) !== Number(o)) return false;
    } else if (r !== o) {
      return false;
    }
  }
  return true;
}

/** 单条 required 是否被档案命中:无 @=类+值完全相等(忽略档案版本段,非前缀);带 @=逐段;未知类=整串精确 */
export function matchOne(required: string, owned: string[]): boolean {
  const r = parseTag(required);
  if (!r) return false;
  const known = (KNOWN_CAP_CLASSES as readonly string[]).includes(r.cls);
  for (const o of owned) {
    const p = parseTag(o);
    if (!p || p.cls !== r.cls) continue;
    if (!known) {
      if (o === required) return true;
      continue;
    }
    if (p.value !== r.value) continue;
    if (!r.version) return true;
    if (!p.version) continue;
    if (versionMatch(r.version, p.version)) return true;
  }
  return false;
}

export interface CapsMatch {
  ok: boolean;
  missing: string[];
}

/** AND 语义;missing 明细随 reject(unsupported_caps) 反哺改派(03 §6 闸3) */
export function matchCaps(required: string[], owned: string[]): CapsMatch {
  const missing = required.filter((r) => !matchOne(r, owned));
  return { ok: missing.length === 0, missing };
}