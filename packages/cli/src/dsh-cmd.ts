/**
 * 本地 dsh 运行时探测(单机的龙 = 完整 dsh 运行时):安装器写入 ~/.qlong/dsh.json
 * ({"cmd":"dsh","version":"..."})后,qlong run/solo 优先使用本地运行时,
 * 不再走 npx 临时通道(离线可用、版本固定、启动快)。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function readLocalDshCmd(home: string): string | undefined {
  try {
    const j = JSON.parse(readFileSync(join(home, 'dsh.json'), 'utf8')) as { cmd?: string; version?: string };
    return typeof j.cmd === 'string' && j.cmd.length > 0 ? j.cmd : undefined;
  } catch {
    return undefined;
  }
}
