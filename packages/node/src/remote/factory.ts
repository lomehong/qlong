/**
 * 生产便捷工厂(v0.2):一行代码组装节点全栈。
 * 将 FileOutbox + DeepSeekHarnessDriver + weak-net 重连 + WorkspaceManager 组装到 RemoteNodeSession。
 *
 * 用法:
 *   const node = await createProductionNode({
 *     registryUrl: 'http://127.0.0.1:3200',
 *     gatewayUrl: 'ws://127.0.0.1:3100',
 *     nodeToken: 'node_xxx',
 *     dataDir: '/var/lib/qlong',
 *   });
 *   await node.start();
 */
import { GatewayClient } from '../gateway-client.js';
import { FileOutbox } from '../outbox/file-outbox.js';
import { DeepSeekHarnessDriver } from '../driver/harness-driver.js';
import { RemoteNodeSession } from './session.js';
import { DEFAULT_PARAMS, type QlongParams } from '@qlong/core';

export interface ProductionNodeOptions {
  registryUrl: string;
  gatewayUrl: string;
  nodeToken: string;
  /** 持久化目录(FileOutbox + workspace);不传则用内存 outbox */
  dataDir?: string;
  params?: QlongParams;
  /** 覆盖默认 harness driver */
  driver?: import('../executor/driver.js').ExecutorDriver;
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
    priv: new Uint8Array(0), // 实际由 enrollment 存档恢复;此处占位,完整流程见 install.sh
    client,
    params: opts.params ?? DEFAULT_PARAMS,
    driver: opts.driver ?? new DeepSeekHarnessDriver(),
  });

  // 5) taskStatusReporter:lead 终态时自动上报到 registry
  session.opts.taskStatusReporter = (t) => {
    fetch(opts.registryUrl + '/v1/teams/' + t.team_id + '/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + opts.nodeToken },
      body: JSON.stringify(t),
    }).catch(() => {});
  };

  return {
    session,
    client,
    start: () => client.open(),
    stop: () => client.close(),
  };
}