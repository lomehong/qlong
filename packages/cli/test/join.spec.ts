import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry, createRegistryServer } from '../../registry/src/index.js';
import { joinAndSave, readConfig } from '../src/join.js';

/**
 * 02 §4 enrollment 的 CLI 侧契约:join 生成身份 → enroll → 配置落盘(0600);
 * 错误路径输出可行动的人话(评审 I-23③)。
 */
describe('qlong join', () => {
  const registry = new Registry({ now: () => Date.now() });
  let srv: ReturnType<typeof createServer>;
  let baseUrl = '';
  let teamId = '';

  beforeAll(async () => {
    teamId = registry.createTeam({ owner_user_id: 'u1' }).team_id;
    srv = createRegistryServer({ registry, enrollRatePerMinPerIp: 1000 });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });

  it('有效邀请码:生成身份 → enroll → config.json 落盘且身份同源', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlong-join-'));
    try {
      const token = registry.issueEnrollToken(teamId);
      const cfg = await joinAndSave({ registryUrl: baseUrl, gatewayUrl: 'ws://127.0.0.1:3100', token, home });
      expect(cfg.node_id).toBeTruthy();
      expect(cfg.team_id).toBe(teamId);
      expect(cfg.node_token).toBeTruthy();
      expect(existsSync(join(home, 'config.json'))).toBe(true);
      expect(existsSync(join(home, 'identity.json'))).toBe(true);
      // readConfig 读回一致
      expect(readConfig(home).node_id).toBe(cfg.node_id);
      // identity.json 与 config 同目录:factory 以 dataDir=home 恢复同一私钥(02 §3.2)
      const identity = JSON.parse(readFileSync(join(home, 'identity.json'), 'utf8')) as { pubkey_b64: string };
      expect(identity.pubkey_b64).toBeTruthy();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('无效邀请码 → 明确报错(enroll_token_invalid 人话,评审 I-23③)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlong-join-bad-'));
    try {
      await expect(
        joinAndSave({ registryUrl: baseUrl, gatewayUrl: 'ws://x', token: 'not-a-real-token', home }),
      ).rejects.toThrow(/enroll 失败\(400\)/);
      expect(existsSync(join(home, 'config.json'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
