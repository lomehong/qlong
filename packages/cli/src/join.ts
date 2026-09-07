/**
 * qlong join(02 §4 enrollment 协议侧):生成/恢复节点身份 → POST /v1/enroll → 写配置。
 * token 语义:入队加入签发方 team;无 token 调用 enroll = 单机 team(评审 I-48)。
 * 身份存档沿用 identity.json(home 目录),与 `qlong run` 的 factory dataDir 同源。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadOrCreateIdentity } from '../../node/src/identity.js';

export interface QlongConfig {
  registry_url: string;
  gateway_url: string;
  node_id: string;
  team_id: string;
  node_token: string;
  key_epoch: number;
  caps: string[];
}

export function qlongHome(): string {
  return process.env.QLONG_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.qlong');
}

export async function joinAndSave(
  opts: { registryUrl: string; gatewayUrl: string; token?: string; caps?: string[]; home?: string },
): Promise<QlongConfig> {
  const home = opts.home ?? qlongHome();
  mkdirSync(home, { recursive: true });
  const identity = loadOrCreateIdentity(home);
  const res = await fetch(opts.registryUrl.replace(/\/$/, '') + '/v1/enroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(opts.token ? { token: opts.token } : {}),
      pubkey: identity.pubkeyB64,
      platform: `${process.platform}/${process.arch}`,
      qlong_version: '0.2.0',
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`enroll 失败(${res.status}):${text || '请检查邀请码是否有效并重新生成'}`);
  }
  const r = (await res.json()) as { node_id: string; team_id: string; node_token: string; key_epoch: number };
  const cfg: QlongConfig = {
    registry_url: opts.registryUrl,
    gateway_url: opts.gatewayUrl,
    node_id: r.node_id,
    team_id: r.team_id,
    node_token: r.node_token,
    key_epoch: r.key_epoch,
    caps: opts.caps ?? [],
  };
  const cfgPath = join(home, 'config.json');
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return cfg;
}

export function readConfig(home?: string): QlongConfig {
  const h = home ?? qlongHome();
  const cfgPath = join(h, 'config.json');
  if (!existsSync(cfgPath)) {
    throw new Error(`未找到配置 ${cfgPath} —— 先执行 qlong join <token> 入网`);
  }
  return JSON.parse(readFileSync(cfgPath, 'utf8')) as QlongConfig;
}
