/**
 * dsh 运行时版本目录(单机的龙 = 完整 dsh 运行时):
 * 浏览器直读 npm registry(支持 CORS;失败回退 npmmirror 国内镜像),
 * 解析 dist-tags(latest/alpha)与全部版本号,供安装页下拉选择。
 * 选中值经安装命令以 QLONG_DSH_VERSION 传给安装器,固定版本落客户端。
 */

const PRIMARY = 'https://registry.npmjs.org/@deepseek-ai/dsh';
const MIRROR = 'https://registry.npmmirror.com/@deepseek-ai/dsh';

export interface DshVersionInfo {
  /** npm dist-tags(如 { latest: '0.1.5-rc.2', alpha: '0.1.6-alpha.2' }) */
  tags: Record<string, string>;
  /** 全部版本号,新→旧 */
  versions: string[];
}

/** 版本号降序比较:逐段数值优先,其余字符串;prerelease 后缀(-rc.1/-alpha.2)视作独立段 */
export function versionCompareDesc(a: string, b: string): number {
  const seg = (v: string): (number | string)[] =>
    v.replace(/^v/, '').split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const sa = seg(a);
  const sb = seg(b);
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const x = sa[i];
    const y = sb[i];
    if (x === undefined) return 1;  // 短者更新(1.0 > 1.0.0?约定:短段在前)
    if (y === undefined) return -1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return y - x;
    return String(x) < String(y) ? 1 : -1;
  }
  return 0;
}

export function parsePackument(raw: unknown): DshVersionInfo {
  const doc = (raw ?? {}) as { 'dist-tags'?: Record<string, unknown>; versions?: Record<string, unknown> };
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(doc['dist-tags'] ?? {})) {
    if (typeof v === 'string') tags[k] = v;
  }
  const versions = Object.keys(doc.versions ?? {}).sort(versionCompareDesc);
  return { tags, versions };
}

export async function fetchDshVersions(): Promise<DshVersionInfo> {
  let lastError: unknown;
  for (const base of [PRIMARY, MIRROR]) {
    try {
      const res = await fetch(base, {
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 qlong-console' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        lastError = new Error(`${base} → ${res.status}`);
        continue;
      }
      return parsePackument(await res.json());
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('npm registry 不可达');
}
