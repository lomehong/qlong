import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runSolo, stubSoloDriver } from '../src/solo.js';

/**
 * qlong solo(单机形态,愿景:一条龙独立干活):零令牌、零入网、零外部中心。
 * 全链 = 回环中心(进程内 ephemeral)→ 自动身份并入网 → 持久 v2 节点 →
 * 自派单(本机 lead→executor 闭环)→ 驱动执行 → 验收 done。
 * 测试以注入桩驱动收口(驱动本身的真实性由 fenced-driver/dsh 联调覆盖)。
 */
const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('qlong solo(单机形态)', () => {
  it('零令牌独立执行:originate→自派单→执行→done,数据目录跨次复用(open)', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'qlong-solo-')));
    roots.push(base);
    const dataDir = join(base, 'data');

    const first = await runSolo({
      kind: 'aid',
      summary: '【目标】打印 pong',
      dataDir,
      timeoutMs: 30_000,
      driver: stubSoloDriver({ summary: 'pong' }),
    });
    expect(first.state).toBe('done');
    expect(first.attempt).toBe(1);
    expect(first.resultBody?.summary).toBe('pong');

    // 第二次:同一数据目录(open 模式)再次独立执行
    const second = await runSolo({
      kind: 'aid',
      summary: '【目标】再来一次',
      dataDir,
      timeoutMs: 30_000,
      driver: stubSoloDriver({ summary: 'pong-2' }),
    });
    expect(second.state).toBe('done');
    expect(second.resultBody?.summary).toBe('pong-2');
    // 同一条龙:跨次身份不变(node.json + identity.json 持久)
    expect(second.nodeId).toBe(first.nodeId);
  });

  it('空 summary 拒绝(用法错误)', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'qlong-solo-')));
    roots.push(base);
    await expect(
      runSolo({ kind: 'aid', summary: '  ', dataDir: join(base, 'data'), driver: stubSoloDriver() }),
    ).rejects.toThrow(/非空 summary/);
  });
});
