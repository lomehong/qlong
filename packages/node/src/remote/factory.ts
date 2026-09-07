/**
 * 生产便捷工厂(v0.3):一行代码组装节点全栈。
 * FileOutbox + DeepSeekHarnessDriver + weak-net 重连 + WorkspaceManager + 身份存档 + caps/load 上报。
 *
 * 用法:
 *   const node = await createProductionNode({
 *     registryUrl: 'http://127.0.0.1:3200',
 *     gatewayUrl: 'ws://127.0.0.1:3100',
 *     nodeToken: 'node_xxx',
 *     dataDir: '/var/lib/qlong',
 *     capabilities: () => ['tool:node@20'],
 *   });
 *   await node.start();
 */
import { GatewayClient } from '../gateway-client.js';
import { FileOutbox } from '../outbox/file-outbox.js';
import { DeepSeekHarnessDriver } from '../driver/harness-driver.js';
import { RemoteNodeSession } from './session.js';
import { loadOrCreateIdentity } from '../identity.js';
import { DEFAULT_PARAMS, type QlongParams } from '@qlong/core';
import type { LoadSnapshot } from '../executor/gates.js';

export interface ProductionNodeOptions {
  registryUrl: string;
  gatewayUrl: string;
  nodeToken: string;
  /** 持久化目录(FileOutbox + workspace + identity 存档);不传则用内存 outbox */
  dataDir?: string;
  params?: QlongParams;
  /** 覆盖默认 harness driver */
  driver?: import('../executor/driver.js').ExecutorDriver;
  /** 身份私钥(02 §3.2);缺省从 dataDir/identity.json 恢复或创建 */
  privKey?: Uint8Array;
  /** 静态能力标签(03 篇):启动时上报 /v1/nodes/me/caps,闸3 亦使用 */
  capabilities?: () => string[];
  /** 负载快照来源:随 reportIntervalMs 周期上报 /v1/nodes/me/load */
  load?: () => LoadSnapshot | undefined;
  /** 上报周期,默认 60s(03 §4 动态刷新);0 = 关闭周期上报 */
  reportIntervalMs?: number;
}

export interface ProductionNode {
  session: RemoteNodeSession;
  client: GatewayClient;
  start(): Promise<void>;
  stop(): void;
}

export async function createProductionNode(opts: ProductionNodeOptions): Promise<ProductionNode> {
  // 1) 用 node_token 向 registry 查自身身份(/v1/nodes/me)
  const res = await fetch(`${opts.registryUrl}/v1/nodes/me`, {
    headers: { Authorization: `Bearer ${opts.nodeToken}` },
  });
  if (!res.ok) throw new Error(`registry /v1/nodes/me 返回 ${res.status}:无法获取节点身份`);
  const me = (await res.json()) as { node_id: string; team_id: string; key_epoch: number };

  // 1.5) 身份私钥:显式传入 > dataDir 存档(02 §3.2;空私钥会导致全部出站签名无效)
  const identity = opts.privKey
    ? { priv: opts.privKey, pubkeyB64: '' }
    : opts.dataDir
      ? loadOrCreateIdentity(opts.dataDir)
      : { priv: new Uint8Array(0), pubkeyB64: '' };

  // 2) 构建 GatewayClient(FileOutbox 持久化 + weak-net 重连已内置)
  const client = new GatewayClient({
    url: opts.gatewayUrl,
    nodeToken: opts.nodeToken,
    params: opts.params ?? DEFAULT_PARAMS,
    dataDir: opts.dataDir,
  });

  // 3) 组装 session(harness driver 或自定义)
  const session = new RemoteNodeSession({
    nodeId: me.node_id,
    teamId: me.team_id,
    keyEpoch: me.key_epoch,
    priv: identity.priv,
    client,
    params: opts.params ?? DEFAULT_PARAMS,
    driver: opts.driver ?? new DeepSeekHarnessDriver(),
    capabilities: opts.capabilities,
    load: opts.load,
  });

  const putRegistry = (path: string, body: unknown): void => {
    fetch(opts.registryUrl + path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + opts.nodeToken },
      body: JSON.stringify(body),
    }).catch(() => {});
  };

  // 4) caps/load 上报(03 §4):静态启动即报 + 动态周期刷新
  const reportIntervalMs = opts.reportIntervalMs ?? 60_000;
  const reportCaps = (): void => {
    putRegistry('/v1/nodes/me/caps', { caps: opts.capabilities?.() ?? [] });
  };
  const reportLoad = (): void => {
    const l = opts.load?.();
    if (!l) return;
    putRegistry('/v1/nodes/me/load', {
      queue_depth: l.queueDepth,
      running: l.running,
      accepting: true,
      ts: new Date().toISOString(),
      ttl_ms: 60_000,
    });
  };

  // 5) taskStatusReporter:lead 终态时自动上报到 registry
  session.opts.taskStatusReporter = (t) => {
    fetch(opts.registryUrl + '/v1/teams/' + t.team_id + '/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + opts.nodeToken },
      body: JSON.stringify(t),
    }).catch(() => {});
  };

  let reportTimer: NodeJS.Timeout | undefined;

  return {
    session,
    client,
    start: async () => {
      await client.open().catch(() => {}); // weak-net 后台重连兜底
      reportCaps();
      if (reportIntervalMs > 0) reportTimer = setInterval(reportLoad, reportIntervalMs);
    },
    stop: () => {
      if (reportTimer) clearInterval(reportTimer);
      client.close();
    },
  };
}
