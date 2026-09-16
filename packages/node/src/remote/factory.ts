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
import { DeepSeekHarnessDriver } from '../driver/harness-driver.js';
import { RemoteNodeSession } from './session.js';
import { loadIdentity } from '../identity.js';
import { createRegistryVerifier, loadRegistryIdentity, REGISTRY_TIMEOUT_MS } from './registry-verifier.js';
import { CapsHealth } from '../caps-health.js';
import { makeAudit, publicKeyFromPrivate, toBase64 } from '@qlong/core';
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
  /** 身份私钥(02 §3.2);缺省仅恢复已 enroll 的 dataDir/identity.json,绝不自动创建 */
  privKey?: Uint8Array;
  /** 静态能力标签(03 篇):启动时上报 /v1/nodes/me/caps,闸3 亦使用 */
  capabilities?: () => string[];
  /** 负载快照来源:随 reportIntervalMs 周期上报 /v1/nodes/me/load */
  load?: () => LoadSnapshot | undefined;
  /** 上报周期,默认 60s(03 §4 动态刷新);0 = 关闭周期上报 */
  reportIntervalMs?: number;
  /** 审计事件出口(含能力自愈 cap_tag_* 事件,01 §11) */
  onAudit?: (a: import('@qlong/core').AuditRecord) => void;
  /** Best-effort terminal POST failure; no raw response/network error is exposed. */
  onTaskReportError?: (failure: { task_id: string; status?: number }) => void | Promise<void>;
}

export interface ProductionNode {
  session: RemoteNodeSession;
  client: GatewayClient;
  start(): Promise<void>;
  stop(): void;
}

export async function createProductionNode(opts: ProductionNodeOptions): Promise<ProductionNode> {
  // 1) 只恢复已登记身份;失败不得生成替代密钥或创建 outbox/workspace。
  let priv: Uint8Array;
  let pubkey: string;
  try {
    const seed = opts.privKey !== undefined ? opts.privKey : opts.dataDir ? loadIdentity(opts.dataDir).priv : undefined;
    if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('missing identity');
    priv = new Uint8Array(seed);
    pubkey = toBase64(publicKeyFromPrivate(priv));
  } catch {
    throw new Error('节点身份缺失或损坏:请恢复已登记身份,不会自动生成替代密钥');
  }
  const me = await loadRegistryIdentity(opts);
  if (me.pubkey !== pubkey) throw new Error('节点身份不匹配:本地私钥不对应 registry 当前纪元公钥');

  // 2) 构建 GatewayClient(FileOutbox 持久化 + weak-net 重连已内置)
  const client = new GatewayClient({
    url: opts.gatewayUrl,
    nodeToken: opts.nodeToken,
    params: opts.params ?? DEFAULT_PARAMS,
    dataDir: opts.dataDir,
    verifyInbound: createRegistryVerifier(opts, me),
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
    priv,
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
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      redirect: 'error',
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

  const reportTaskError = async (failure: { task_id: string; status?: number }): Promise<void> => {
    if (opts.onTaskReportError) {
      try {
        await opts.onTaskReportError(failure);
        return;
      } catch {
        // Callback failures are contained too; never log their potentially sensitive errors.
      }
    }
    console.error('任务终态上报失败');
  };

  // 5) Best-effort terminal POST only; no durable intent, retry, or shutdown flush yet.
  // Reliable reporting remains pending node transactional intents (stages 4/8).
  session.opts.taskStatusReporter = (t) => {
    void fetch(opts.registryUrl + '/v1/teams/' + t.team_id + '/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + opts.nodeToken },
      body: JSON.stringify(t),
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      redirect: 'error',
    }).then(
      (response) => {
        if (!response.ok) return reportTaskError({ task_id: t.task_id, status: response.status });
      },
      () => reportTaskError({ task_id: t.task_id }),
    );
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
