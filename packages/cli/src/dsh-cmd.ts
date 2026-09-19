/**
 * 本地 dsh 运行时探测(单机的龙 = 完整 dsh 运行时):安装器写入 ~/.qlong/dsh.json
 * ({"cmd":"dsh","version":"..."})后,qlong run/solo/agent 优先使用本地运行时,
 * 不再走 npx 临时通道(离线可用、版本固定、启动快)。
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function readLocalDshCmd(home: string): string | undefined {
  try {
    // 兼容 PowerShell 5.1 Out-File utf8 写出的 BOM(首字节 EF BB BF 会噎死 JSON.parse)
    const raw = readFileSync(join(home, 'dsh.json'), 'utf8').replace(/^\uFEFF/, '');
    const j = JSON.parse(raw) as { cmd?: string; version?: string };
    return typeof j.cmd === 'string' && j.cmd.length > 0 ? j.cmd : undefined;
  } catch {
    return undefined;
  }
}

export interface LocalDshRuntime {
  /** 用 node 直接执行的真实入口(绕开 npm 的 .cmd 垫片 —— Windows 下无 shell spawn .cmd 会 EINVAL) */
  binJs: string;
  version?: string;
}

/** 定位 npm 全局 dsh 的真实 JS 入口(npm root -g,结果缓存)。找不到 → undefined。 */
export function resolveLocalDshRuntime(): LocalDshRuntime | undefined {
  let root: string;
  try {
    root = execSync('npm root -g', { encoding: 'utf8', timeout: 10_000 }).trim();
  } catch {
    return undefined;
  }
  const pkgDir = join(root, '@deepseek-ai', 'dsh');
  const pkgPath = join(pkgDir, 'package.json');
  if (!existsSync(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin?: Record<string, string> | string; version?: string };
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.dsh;
    const binJs = bin !== undefined ? join(pkgDir, bin) : '';
    if (!binJs || !existsSync(binJs)) return undefined;
    return { binJs, version: pkg.version };
  } catch {
    return undefined;
  }
}
