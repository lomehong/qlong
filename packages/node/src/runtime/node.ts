/**
 * DurableNode 装配(v2):显式 SQLite 准入 + NodeRuntimeStore + GatewayClient(transport v2)+
 * DurableExecutor + 任务 pump(收件箱重授权消费 / 租约计时 / 关停 flush)。
 *
 * 这是 docs/repair/PROTOCOL-V2.md 指出的"生产节点工厂/任务 pump 接线"缺口:
 *  - 事务边界:executor.consume 在同一短事务内提交 inbox 决议、状态 CAS、签名 outbox 与 effect;
 *    pump 只在提交之后驱动 driver(effect intent fenced),失败全回滚,绝不先执行后记账。
 *  - 重启 pending:auth_ok 通知的持久收件由 pump 逐条重新授权(验证失败则留在 pending 重试,
 *    绝不猜测性拒绝或静默丢弃)。
 *  - 关停:executor.close 静默在跑 run 并把终态写入签名 outbox,随后有界 flush 等 stored,
 *    最后断连关库;不伪造成功。
 * 旧 createProductionNode(FileOutbox/v1 会话)保持原样;两者不可互替,见 PROTOCOL-V2.md。
 */
import { dirname } from 'node:path';
import {
  DEFAULT_PARAMS, newId, newTraceContext, publicKeyFromPrivate, signEnvelope, toBase64, validateEnvelope,
  type EnvelopeV1, type QlongParams,
} from '@qlong/core';
import { SqliteStore } from '../../../storage/src/index.js';
import type { FencedDriver } from '../driver/run-handle.js';
import { GatewayClient } from '../gateway-client.js';
import type { LocalPolicy, LoadSnapshot } from '../executor/gates.js';
import { DurableExecutor } from './executor.js';
import { DurableLead, leadStateKey, type TargetSelector } from './lead.js';
import { DurableTaskReporter, type TaskReportSink } from './report.js';
import { NODE_SCHEMA } from './schema.js';
import { NodeRuntimeStore } from './store.js';
import { createRegistryVerifier, loadRegistryIdentity, type RegistryIdentity } from '../remote/registry-verifier.js';
import type { Outbound } from '../wire.js';

/** 每次 pump 批量上限(与传输层在投票据窗口一致) */
const PUMP_BATCH = 16;

export interface DurableNodeStorageOptions {
  /** 专用绝对路径(runtime.sqlite + ownership 锁所在目录);严格位于 allowedBase 内 */
  dataDir: string;
  /** 准入父目录;默认 dataDir 的父目录 */
  allowedBase?: string;
  /** 显式 create/open:丢失的库必须显式恢复,绝不 open-or-create */
  mode: 'create' | 'open';
  /** 默认 runtime.sqlite */
  filename?: string;
  busyTimeoutMs?: number;
}

export interface DurableNodeOptions {
  registryUrl: string;
  gatewayUrl: string;
  nodeToken: string;
  /** 已登记身份私钥(32 字节);缺失/与 registry 纪元公钥不匹配即拒绝,绝不自动生成 */
  privKey: Uint8Array;
  /** 显式本地存储准入;与中心同一套 create/open/确认语义 */
  storage: DurableNodeStorageOptions & { localFilesystemConfirmed: true; windowsAclConfirmed?: true };
  params?: QlongParams;
  /** fence 精确驱动;缺省 = 不执行(offer 一律 policy_denied) */
  driver?: FencedDriver;
  /** 有界 driver 等待(默认 5s;CLI spawn 建议放宽) */
  driverTimeoutMs?: number;
  /** 静态能力标签(闸3 与 caps 上报共用) */
  capabilities?: () => string[];
  /** 负载快照来源(load 周期上报) */
  load?: () => LoadSnapshot | undefined;
  /** 本地策略闸(闸2) */
  policy?: LocalPolicy;
  /** lease/心跳/重试 pump 周期 ms,默认 1000,边界 [50, 60000] */
  tickIntervalMs?: number;
  /** pending 重授权失败的重试间隔 ms,默认 5000,边界 [100, 600000] */
  verifyRetryMs?: number;
  /** 关停 flush 上限 ms,默认 5000,边界 [0, 600000] */
  shutdownFlushMs?: number;
  /** caps/load 周期上报 ms(03 §4),0 = 关闭;默认 60000 */
  reportIntervalMs?: number;
  /**
   * 持久投递墓碑保留窗口 ms:终态 'stored' 投递记录超过该窗口由 GC 周期回收;
   * 缺省 undefined = 关闭(墓碑永久保留),0 = 立即回收。pending 投递与未投递载荷永不回收。
   */
  custodyRetentionMs?: number;
  /** 投递墓碑 GC 周期 ms(默认 6h;0 = 关闭);仅在 custodyRetentionMs 配置后生效 */
  gcIntervalMs?: number;
  /** 显式身份注入(默认经 registry /v1/nodes/me 发现;测试/替代信任根用) */
  identity?: RegistryIdentity;
  /** 入站授权钩子注入(默认 registry 验签;测试/替代信任根用) */
  verifyInbound?: (env: EnvelopeV1) => Promise<boolean>;
  /** 牵头方改派目标选择器(响应 reclaim 后的 requestDispatch);缺省则任务停留 drafting 等注入 */
  selectTarget?: TargetSelector;
  /** PROJECT 验收判据注入(牵头方判定 task.result);缺省用机器默认(project 拒绝、aid 兼容规则) */
  validateAcceptance?: (resultBody: Record<string, unknown>) => boolean;
  /** 持久任务上报投递汇注入(默认 POST /v1/teams/:id/tasks);测试/替代中心用 */
  taskReportSink?: TaskReportSink;
  /** 存储或执行器故障:节点已停止接入,保留现场等待显式恢复 */
  onFault?: () => void;
}

export interface DurableNode {
  readonly identity: RegistryIdentity;
  readonly runtime: NodeRuntimeStore;
  readonly executor: DurableExecutor;
  /** v2 牵头方角色:显式 originate/dispatch 触发;选举/归属仲裁延后 C2 */
  readonly lead: DurableLead;
  readonly client: GatewayClient;
  /** 恢复孤儿 → 消费重启 pending → v2 建连 → 启动 pump */
  start(): Promise<void>;
  /** 停 pump → executor.close(静默在跑 run,终态入 outbox)→ 有界 flush → 断连 → 关库 */
  stop(): Promise<void>;
  /** 手动泵动:重授权并消费 pending 收件,推进 executor(测试/宿主用) */
  drain(): Promise<void>;
  /** 底层 SQLite 句柄(宿主显式重开/诊断用;close 由 stop 负责) */
  readonly store: SqliteStore;
}

function bounded(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const n = value ?? fallback;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new TypeError(`${name} must be an integer in [${min}, ${max}]`);
  }
  return n;
}

export async function createDurableNode(opts: DurableNodeOptions): Promise<DurableNode> {
  // 1) 身份:只接受已登记身份;不匹配直接拒绝(02 §3.2 / CENTER-STORAGE)。
  if (!(opts.privKey instanceof Uint8Array) || opts.privKey.length !== 32) {
    throw new Error('节点身份缺失或损坏:请提供已登记的 32 字节私钥,不会自动生成替代密钥');
  }
  const me = opts.identity ?? await loadRegistryIdentity(opts);
  if (me.pubkey !== toBase64(publicKeyFromPrivate(opts.privKey))) {
    throw new Error('节点身份不匹配:本地私钥不对应 registry 当前纪元公钥');
  }

  // 2) 显式 SQLite 准入(qlong.node schema);create/open 语义由 storage 包强制。
  const store = SqliteStore.open({
    schema: NODE_SCHEMA,
    dataDir: opts.storage.dataDir,
    allowedBase: opts.storage.allowedBase ?? dirname(opts.storage.dataDir),
    mode: opts.storage.mode,
    filename: opts.storage.filename ?? 'runtime.sqlite',
    localFilesystemConfirmed: true,
    windowsAclConfirmed: opts.storage.windowsAclConfirmed,
    busyTimeoutMs: opts.storage.busyTimeoutMs,
  });
  const runtime = new NodeRuntimeStore(store, me.node_id, { retentionMs: opts.custodyRetentionMs });

  const params: QlongParams = { ...(opts.params ?? DEFAULT_PARAMS) };
  const tickIntervalMs = bounded(opts.tickIntervalMs, 1_000, 50, 60_000, 'tickIntervalMs');
  const verifyRetryMs = bounded(opts.verifyRetryMs, 5_000, 100, 600_000, 'verifyRetryMs');
  const shutdownFlushMs = bounded(opts.shutdownFlushMs, 5_000, 0, 600_000, 'shutdownFlushMs');
  const reportIntervalMs = bounded(opts.reportIntervalMs, 60_000, 0, 2_147_483_647, 'reportIntervalMs');
  const gcIntervalMs = bounded(opts.gcIntervalMs, 6 * 3_600_000, 0, 2_147_483_647, 'gcIntervalMs');

  // 3) 出站签名(与旧 session 同一信封装配);executor 事务内不签名——这里预先闭包。
  const seal = (out: Outbound): EnvelopeV1 => {
    const now = Date.now();
    const base = {
      v: 1,
      type: out.type,
      msg_id: newId(),
      ts: new Date(now).toISOString(),
      exp: new Date(now + params.expHorizonMs).toISOString(),
      from: { node_id: me.node_id, team_id: me.team_id, key_epoch: me.key_epoch },
      to: { node_id: out.to_node, team_id: me.team_id },
      trace: newTraceContext(me.node_id),
      ...(out.reply_to !== undefined ? { reply_to: out.reply_to } : {}),
      ...(out.task_id !== undefined ? { hops: 0, task_id: out.task_id, attempt: out.attempt ?? 1 } : {}),
      body: out.body,
    };
    const chk = validateEnvelope(base as EnvelopeV1, params, { allowMissingSig: true });
    if (!chk.ok) throw new Error('出站信封校验失败:' + chk.errors.join(';'));
    return signEnvelope(chk.value, opts.privKey);
  };

  // 4) pump 状态与故障闭环。
  let started = false;
  let stopped = false;
  let faulted = false;
  let stopping: Promise<void> | undefined;
  let draining = false;
  let flushing = false;
  let nextVerifyRetryAt = 0;
  let tickTimer: NodeJS.Timeout | undefined;
  let reportTimer: NodeJS.Timeout | undefined;
  let gcTimer: NodeJS.Timeout | undefined;

  const stopTimers = (): void => {
    if (tickTimer !== undefined) { clearInterval(tickTimer); tickTimer = undefined; }
    if (reportTimer !== undefined) { clearInterval(reportTimer); reportTimer = undefined; }
    if (gcTimer !== undefined) { clearInterval(gcTimer); gcTimer = undefined; }
  };

  const failClosed = (): void => {
    if (faulted) return;
    faulted = true;
    stopTimers();
    // 停止自动接入;数据库文件保留,等待显式恢复(绝不删除/重置)。
    try { client.close(); } catch { /* client 已停止 */ }
    try { opts.onFault?.(); } catch { /* 观察者不得掩盖故障 */ }
  };

  // 5) 传输客户端:custody 语义(v2);其自身存储故障同样触发节点级 fail-closed。
  const verify = opts.verifyInbound ?? createRegistryVerifier(opts, me);
  const client = new GatewayClient({
    url: opts.gatewayUrl,
    nodeToken: opts.nodeToken,
    runtime,
    verifyInbound: verify,
    onInboxReady: () => { void drain(); },
    onFault: failClosed,
  });

  // 6) 事务执行器(单 slot;effect 在提交后由 settle 驱动)。
  const executor = new DurableExecutor({
    store: runtime,
    nodeId: me.node_id,
    teamId: me.team_id,
    params,
    seal,
    driver: opts.driver,
    driverTimeoutMs: opts.driverTimeoutMs,
    capabilities: opts.capabilities,
    policy: opts.policy,
    onFault: failClosed,
  });

  // 6b) v2 牵头方角色(生产半)+ 持久上报消费半(B1d)。
  // 牵头方与执行方共享同一 runtime/seal;lead 状态键前缀隔离,绝不与本机执行槽混淆。
  // 触发是显式的(调用方 node.lead.originate/dispatch);自动选举/归属仲裁延后 C2。
  const lead = new DurableLead({
    store: runtime,
    nodeId: me.node_id,
    teamId: me.team_id,
    params,
    seal,
    selectTarget: opts.selectTarget,
    validateAcceptance: opts.validateAcceptance,
    onFault: failClosed,
  });

  // 默认上报汇:POST /v1/teams/:id/tasks(Bearer nodeToken)。传输失败按可重试处理(status 0),
  // 绝不伪造状态码;中心 409(已达该/更高修订)由 reporter 视为完成而非无限重试。
  const defaultTaskReportSink: TaskReportSink = async (report) => {
    try {
      const res = await fetch(
        opts.registryUrl.replace(/\/+$/, '') + `/v1/teams/${encodeURIComponent(report.team_id)}/tasks`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + opts.nodeToken },
          body: JSON.stringify(report),
          signal: AbortSignal.timeout(5_000),
          redirect: 'error',
        },
      );
      return { ok: res.ok, status: res.status };
    } catch {
      return { ok: false, status: 0 };
    }
  };
  const reporter = new DurableTaskReporter({ store: runtime, post: opts.taskReportSink ?? defaultTaskReportSink });

  const verifySafely = async (env: EnvelopeV1): Promise<boolean> => {
    try { return (await verify(env)) === true; } catch { return false; }
  };

  /**
   * 收件箱 pump:逐条重新授权后消费。授权失败留在 pending(定时重试),
   * 因为 registry 瞬断绝不能被放大成对合法信封的永久拒绝。
   */
  async function drain(): Promise<void> {
    if (draining || stopped) return;
    draining = true;
    try {
      for (;;) {
        if (stopped || faulted) return;
        const batch = runtime.pending(PUMP_BATCH);
        let skipped = false;
        for (const env of batch) {
          if (stopped || faulted) return;
          if (!(await verifySafely(env))) { skipped = true; continue; }
          // 路由:本节点牵头该任务 → 回执走牵头方(绝不落入本机执行槽);否则 → 执行方消费。
          const ledByUs = env.task_id !== undefined && runtime.state(leadStateKey(env.task_id)) !== undefined;
          if (ledByUs) {
            lead.consume(env, true); // 故障在牵头方内闭锁并回调;错误向调用方传播
          } else {
            executor.consume(env, true); // 故障在执行器内闭锁并回调;错误向调用方传播
            await executor.settle();
          }
        }
        nextVerifyRetryAt = skipped ? Date.now() + verifyRetryMs : 0;
        if (batch.length < PUMP_BATCH) return;
      }
    } finally { draining = false; }
  }

  /** 单所有者、带重入守卫的持久上报泵送:传输失败留在 pending 等下次;损坏/存储故障 fail-closed。 */
  const flushReports = (): void => {
    if (flushing) return;
    flushing = true;
    void reporter.flush()
      .catch(() => { failClosed(); }) // 仅畸形 intent/存储故障会 reject;传输失败已被 reporter 内部吞掉
      .finally(() => { flushing = false; });
  };

  const pumpTick = (): void => {
    if (stopped || faulted) return;
    try { executor.tick(); } catch { /* 故障已闭锁 */ }
    try { lead.tick(); } catch { /* 故障已闭锁:牵头方内部已 fail-closed 并回调 */ }
    void executor.settle().catch(() => { /* 故障已闭锁 */ });
    client.flush(); // 执行方/牵头方事务内密封的 outbox 一并发出
    flushReports();
    if (nextVerifyRetryAt !== 0 && Date.now() >= nextVerifyRetryAt) {
      nextVerifyRetryAt = 0;
      void drain().catch(() => { /* 故障已闭锁 */ });
    }
  };

  // 7) caps/load 上报(03 §4;与旧 factory 同语义:变更检测 + 周期刷新)。
  let lastCapsJson = '';
  const putRegistry = (path: string, body: unknown): void => {
    fetch(opts.registryUrl.replace(/\/+$/, '') + path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + opts.nodeToken },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
      redirect: 'error',
    }).catch(() => {});
  };
  const reportCaps = (): void => {
    const caps = opts.capabilities?.() ?? [];
    const json = JSON.stringify(caps);
    if (json === lastCapsJson) return;
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
    reportCaps();
  };

  return {
    identity: me,
    runtime,
    executor,
    lead,
    client,
    store,
    drain,
    start: async (): Promise<void> => {
      if (started) throw new Error('durable node already started');
      if (stopped) throw new Error('durable node is stopped');
      started = true;
      await executor.recover(); // 孤儿对账;不确定 → recovery_required + onFault
      if (faulted) throw new Error('durable node faulted during recovery');
      await drain(); // 重启 pending:先授权消费,再开放接入
      if (faulted) throw new Error('durable node faulted while consuming pending inbox');
      await client.open().catch(() => {
        if (client.state === 'closed') throw new Error('gateway rejected this node; no reconnect will follow');
      });
      tickTimer = setInterval(pumpTick, tickIntervalMs);
      tickTimer.unref();
      lastCapsJson = '';
      reportCaps();
      if (reportIntervalMs > 0) {
        reportLoad();
        reportTimer = setInterval(reportLoad, reportIntervalMs);
        reportTimer.unref();
      }
      // Retention GC reclaims terminal 'stored' delivery tombstones; a corrupt tombstone faults the store,
      // which must fail the node closed rather than be concealed by the sweep.
      if (opts.custodyRetentionMs !== undefined && gcIntervalMs > 0) {
        gcTimer = setInterval(() => {
          if (stopped || faulted) return;
          try { runtime.prune(); } catch { failClosed(); }
        }, gcIntervalMs);
        gcTimer.unref();
      }
    },
    stop: (): Promise<void> => {
      if (stopping) return stopping;
      stopped = true;
      stopTimers();
      stopping = (async (): Promise<void> => {
        let failure: unknown;
        try { await executor.close(); } catch (error) { failure = error; }
        // 有界关停 flush:终态消息(在跑任务的 fail/cancel.ack)必须先落中心再断连。
        const deadline = Date.now() + shutdownFlushMs;
        while (!faulted && Date.now() < deadline) {
          client.flush();
          let outstanding: number;
          try {
            const now = Date.now();
            outstanding = runtime.all().filter((e) => !e.envelope.exp || Date.parse(e.envelope.exp) > now).length;
          } catch { break; }
          if (outstanding === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        client.close();
        // 有界排空持久上报:未投递的 task.report 修订须在关库前尽力送达;超时也绝不丢弃(留待下次进程)。
        try { await reporter.close(shutdownFlushMs); } catch (error) { failure = failure ?? error; }
        try { store.close(); } catch (error) { failure = failure ?? error; }
        if (failure !== undefined) throw failure;
      })();
      return stopping;
    },
  };
}
