/**
 * qlong solo —— 单机形态(愿景:一条龙独立干活):零令牌、零入网、零外部中心。
 *
 * 进程内自动装配:回环中心(进程内持久 SQLite,仅 127.0.0.1)→ 自动出生并入网的持久身份
 * (用户不可见)→ 持久 v2 节点 → 自派单(lead→executor 同进程闭环,见 runtime/node.ts
 * drain 路由)→ 真实驱动执行(dsh / DSH_HARNESS_CMD 覆盖)→ 结果打印。
 *
 * 身份与令牌在 solo 模式下是纯内部实现细节:它们只为复用同一条任务协议与执行器,
 * 对用户不存在"入网"概念 —— 单机即独立整机;同一条龙跨次复用(identity.json + node.json 持久)。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newKeyPair, toBase64 } from '@qlong/core';
import { createDurableNode } from '../../node/src/runtime/node.js';
import { FencedProcessDriver } from '../../node/src/driver/fenced-driver.js';
import { PersistentRunHandleStore } from '../../node/src/runtime/run-handles.js';
import { loadOrCreateIdentity } from '../../node/src/identity.js';
import type { FencedDriver, RunHandle, RunOutcome } from '../../node/src/driver/run-handle.js';
import type { NodeRuntimeStore } from '../../node/src/runtime/store.js';
import { startQlongServer } from './server.js';

export interface SoloOptions {
  kind: 'aid' | 'project';
  summary: string;
  /** solo 根目录:identity.json/节点凭证/中心库/运行库都在此,同一条龙跨次复用;缺省 ~/.qlong/solo */
  dataDir: string;
  /** 等待任务收口的超时 ms(默认 600_000;真实 dsh 任务通常 30s 量级) */
  timeoutMs?: number;
  /** 驱动注入(测试桩);缺省真实 FencedProcessDriver(工厂形式接持久 run handle) */
  driver?: (runtime: NodeRuntimeStore) => FencedDriver;
}

export interface SoloResult {
  state: string;
  attempt: number;
  resultBody?: Record<string, unknown>;
  taskId: string;
  /** 本次执行使用的龙身份(跨次不变;solo 根目录内 identity.json 持久) */
  nodeId: string;
}

interface SoloNodeCreds {
  node_id: string;
  team_id: string;
  node_token: string;
}

function readNodeCreds(path: string): SoloNodeCreds | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const j = JSON.parse(readFileSync(path, 'utf8')) as Partial<SoloNodeCreds>;
    if (typeof j.node_id === 'string' && typeof j.team_id === 'string' && typeof j.node_token === 'string') {
      return { node_id: j.node_id, team_id: j.team_id, node_token: j.node_token };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function runSolo(opts: SoloOptions): Promise<SoloResult> {
  if (typeof opts.summary !== 'string' || opts.summary.trim().length === 0) {
    throw new TypeError('solo 需要非空 summary');
  }
  mkdirSync(opts.dataDir, { recursive: true });

  // 1) 回环中心:进程内持久 SQLite(仅 127.0.0.1),复用同一条 v2 任务协议,用户无感。
  //    必须是持久 custody 中心(ephemeral 是 legacy 协议,v2 节点会被 4004 拒)。
  const centerDir = join(opts.dataDir, 'center');
  mkdirSync(centerDir, { recursive: true });
  const centerDb = join(centerDir, 'center.sqlite');
  const handles = await startQlongServer({
    storage: {
      allowedBase: opts.dataDir,
      dataDir: centerDir,
      mode: existsSync(centerDb) ? 'open' : 'create',
      localFilesystemConfirmed: true,
      windowsAclConfirmed: true,
    },
    registryPort: 0,
    gatewayPath: '/gateway',
    seedTeam: {},
  });

  try {
    // 2) 持久龙身份:首次自动出生,之后一直是同一条龙
    const identityRec = loadOrCreateIdentity(opts.dataDir);
    const nodeJsonPath = join(opts.dataDir, 'node.json');
    const team = handles.registry.listTeams()[0];
    if (!team) throw new Error('solo 内部中心未产出种子团队');

    const stored = readNodeCreds(nodeJsonPath);
    const storedKnown = stored !== undefined && (() => {
      try { handles.registry.authByToken(stored.node_token); return true; } catch { return false; }
    })();
    let nodeId: string;
    let teamId: string;
    let nodeToken: string;
    if (stored && storedKnown) {
      ({ node_id: nodeId, team_id: teamId, node_token: nodeToken } = stored);
    } else {
      const token = handles.registry.issueEnrollToken(team.team_id);
      const res = handles.registry.enroll({
        token,
        pubkey: identityRec.pubkeyB64,
        platform: `solo/${process.platform}`,
      });
      nodeId = res.node_id;
      teamId = res.team_id;
      nodeToken = res.node_token;
      writeFileSync(nodeJsonPath, JSON.stringify({ node_id: nodeId, team_id: teamId, node_token: nodeToken }, null, 2), { mode: 0o600 });
    }

    // 3) 持久 v2 节点(运行库在 solo 根下 data/,首次 create 其后 open)
    const runDataDir = join(opts.dataDir, 'data');
    mkdirSync(runDataDir, { recursive: true });
    const mode = existsSync(join(runDataDir, 'runtime.sqlite')) ? 'open' : 'create';
    const node = await createDurableNode({
      registryUrl: `http://127.0.0.1:${handles.registryPort}`,
      gatewayUrl: `ws://127.0.0.1:${handles.registryPort}/gateway`,
      nodeToken,
      privKey: identityRec.priv,
      identity: {
        node_id: nodeId,
        team_id: teamId,
        key_epoch: 1,
        pubkey: identityRec.pubkeyB64,
      },
      storage: {
        dataDir: runDataDir,
        mode,
        localFilesystemConfirmed: true,
        windowsAclConfirmed: true,
      },
      driver: opts.driver ?? ((runtime: NodeRuntimeStore) => new FencedProcessDriver({ runHandles: new PersistentRunHandleStore(runtime) })),
      validateAcceptance: () => true, // 单机自验收:owner 的机器,owner 判定
      reportIntervalMs: 0,
      tickIntervalMs: 100,
      driverTimeoutMs: 15_000,
    });
    await node.start();

    // 4) 自派单(单机形态):本机牵头 → 本机执行
    const taskId = randomUUID();
    node.lead.originate(taskId, opts.kind);
    node.lead.dispatch(taskId, nodeId, {
      kind: opts.kind,
      summary: opts.summary,
      lease_ms: 300_000,
      offer_ttl_ms: 60_000,
    });

    // 5) 等收口
    const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
    let snap = node.lead.snapshot(taskId);
    while (snap && snap.state !== 'done' && snap.state !== 'failed' && snap.state !== 'escalated' && snap.state !== 'closed' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      snap = node.lead.snapshot(taskId);
    }
    const result: SoloResult = {
      state: snap?.state ?? 'unknown',
      attempt: snap?.attempt ?? 0,
      resultBody: (snap?.resultBody as Record<string, unknown> | undefined) ?? undefined,
      taskId,
      nodeId,
    };
    await node.stop();
    return result;
  } finally {
    await handles.close();
  }
}

/** 测试桩驱动:立即以固定结果收口(校验 solo 全链路由,不验证驱动本身)。 */
export function stubSoloDriver(resultBody: Record<string, unknown> = { summary: 'pong' }): (runtime: NodeRuntimeStore) => FencedDriver {
  return () => ({
    start: async (fence: Parameters<FencedDriver['start']>[0]): Promise<RunHandle> => {
      return Object.freeze({
        fence,
        closed: Promise.resolve({ kind: 'result', body: resultBody } as RunOutcome),
        stop: async () => {},
      });
    },
    recover: async () => 'unknown',
  });
}
