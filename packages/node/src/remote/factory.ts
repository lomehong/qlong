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
import { CapsHealth } from '../caps-health.js';
import { makeAudit } from '@qlong/core';
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
  /** 审计事件出口(含能力自愈 cap_tag_* 事件,01 §11) */
  onAudit?: (a: import('@qlong/core').AuditRecord) => void;
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
  // 能力自愈两段式(03 §7):健康视图 = 静态声明 − 软摘 − 硬摘;fail(caps_missing) 回流驱动
  const health = opts.capabilities
    ? new CapsHealth({
        staticCaps: opts.capabilities,
        onEvent: (event, tag) =>
          opts.onAudit?.(makeAudit(event, { node_id: me.node_id, reason: tag }, () => new Date().toISOString())),
      })
    : undefined;
  const session = new RemoteNodeSession({
    nodeId: me.node_id,
    teamId: me.team_id,
    keyEpoch: me.key_epoch,
    priv: identity.priv,
    client,
    params: opts.params ?? DEFAULT_PARAMS,
    driver: opts.driver ?? new DeepSeekHarnessDriver(),
    onAudit: opts.onAudit,
    capabilities: () => (health ? health.effectiveCaps() : (opts.capabilities?.() ?? [])),
    load: opts.load,
    onOutboundFail: (body) => {
      const missing = (body as { missing_caps?: unknown }).missing_caps;
      if (!health || !Array.isArray(missing)) return;
      const tags = missing.filter((t): t is string => typeof t === 'string');
      if (tags.length === 0) return;
      const delta = health.onCapsMissing(tags);
      if (delta.suspected.length > 0 || delta.removed.length > 0) reportCaps(); // 档案与健康视图对齐
    },
  });

  const putRegistry = (path: string, body: unknown): void => {
    fetch(opts.registryUrl + path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + opts.nodeToken },
      body: JSON.stringify(body),
    }).catch(() => {});
  };

  // 4) caps/load 上报(03 §4):静态启动即报 + 动态周期刷新 + 变更检测即报
  const reportIntervalMs = opts.reportIntervalMs ?? 60_000;
  let lastCapsJson = '';
  const reportCaps = (): void => {
    const caps = session.opts.capabilities?.() ?? [];
    const json = JSON.stringify(caps);
    if (json === lastCapsJson) return; // 变更检测:未变化不重报(评审 I-59 语义)
    lastCapsJson = json;
    putRegistry('/v1/nodes/me/caps', { caps });
  };
  const reportLoad = (): void => {
    const l = opts.load?.();
    if (l) {
      putRegistry('/v1/nodes/me/load', {
        queue_depth: l.queueDepth,
        running: l.running,
        accepting: true,
        ts: new Date().toISOString(),
        ttl_ms: 60_000,
      });
    }
    reportCaps(); // 周期内顺带做变更检测(自愈/静态变更即报,03 §4)
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
      lastCapsJson = '';
      reportCaps();
      if (reportIntervalMs > 0) reportTimer = setInterval(reportLoad, reportIntervalMs);
    },
    stop: () => {
      if (reportTimer) clearInterval(reportTimer);
      client.close();
    },
  };
}
