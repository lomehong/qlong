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
  DEFAULT_PARAMS, isUuid, newId, newTraceContext, publicKeyFromPrivate, signEnvelope, toBase64, validateEnvelope,
  type EnvelopeV1, type QlongParams,
} from '@qlong/core';
import { SqliteStore } from '../../../storage/src/index.js';
import type { ExecutorWorkspace, FencedDriver } from '../driver/run-handle.js';
import { GitArtifactPublisher } from '../collab/artifact-publisher.js';
import { createGitArtifactCollector } from '../collab/artifact-collector.js';
import { GatewayClient } from '../gateway-client.js';
import type { LocalPolicy, LoadSnapshot } from '../executor/gates.js';
import { DurableExecutor } from './executor.js';
import {
  DurableLead, leadStateKey,
  type DurableLeadImportResult, type DurableLeadTakeoverBundle, type TargetSelector,
} from './lead.js';
import { DurableTaskReporter, type TaskReportSink } from './report.js';
import { NODE_SCHEMA } from './schema.js';
import { NodeRuntimeStore } from './store.js';
import { createPubkeyResolver, createRegistryVerifier, loadRegistryIdentity, type RegistryIdentity } from '../remote/registry-verifier.js';
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
  /**
   * fence 精确驱动;缺省 = 不执行(offer 一律 policy_denied)。
   * 亦可传工厂 (runtime) => FencedDriver:由 createDurableNode 用其持久 NodeRuntimeStore
   * 解析,便于装配 run-handle 持久化背书(C1c,见 PersistentRunHandleStore)。
   */
  driver?: FencedDriver | ((runtime: NodeRuntimeStore) => FencedDriver);
  /**
   * e2d-1: 执行器拥有的 per-fence 工作区端口;缺省 = 驱动退回静态 workdir。
   * 亦可传工厂 (runtime) => ExecutorWorkspace,与 driver 工厂同一解析时机。
   */
  workspace?: ExecutorWorkspace | ((runtime: NodeRuntimeStore) => ExecutorWorkspace);
  /**
   * e2d-2: 节点级共享产物仓(git remote URL 或本地路径)。配置后 createDurableNode 装配
   * GitArtifactPublisher(携登记私钥 + 身份纪元,与 task.result 信封 from 同源)并透传执行器——
   * PROJECT offer 仅当此仓已配置时准入,否则 policy_denied fail-closed(执行器门控 supportedOffer/offer)。
   * 缺省 undefined = 不发布产物(aid 不受影响)。
   */
  artifactRepo?: string;
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
  /** owner 命令 PULL 周期 ms(E3,OWNER-COMMAND §4.3;0 = 关闭周期泵,仍可手动 pullCommands);默认 2000,边界 [0, 600000] */
  commandIntervalMs?: number;
  /** 显式身份注入(默认经 registry /v1/nodes/me 发现;测试/替代信任根用) */
  identity?: RegistryIdentity;
  /** 入站授权钩子注入(默认 registry 验签;测试/替代信任根用) */
  verifyInbound?: (env: EnvelopeV1) => Promise<boolean>;
  /** 牵头方改派目标选择器(响应 reclaim 后的 requestDispatch);缺省则任务停留 drafting 等注入 */
  selectTarget?: TargetSelector;
  /** PROJECT 验收判据注入(牵头方判定 task.result);缺省用机器默认(project 拒绝、aid 兼容规则) */
  validateAcceptance?: (resultBody: Record<string, unknown>) => boolean;
  /**
   * e2d-3: 牵头侧产物收取端口注入(测试/替代信任根用);缺省 = createGitArtifactCollector() 真实 git 收取。
   * 无条件装配(不 gate on artifactRepo):纯牵头节点(不执行、无产物仓)仍需验收 PROJECT 产物,repo 来自信封 inlineRepo。
   */
  collectArtifacts?: (repo: string, taskId: string, branch?: string) => Promise<{ ok: boolean; files?: ReadonlyArray<{ path: string; bytes: Uint8Array }>; reason?: string }>;
  /** e2d-3: 牵头侧验签公钥解析端口注入(测试/替代信任根用);缺省 = createPubkeyResolver(registry HTTP GET /v1/nodes/{id}/pubkey)。 */
  resolvePubkey?: (nodeId: string, keyEpoch: number) => Promise<Uint8Array | undefined>;
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
  /**
   * owner 命令 PULL(E3,OWNER-COMMAND §4.3):从中心取回路由到本机(lead=me)的 pending 命令,逐条经
   * lead.cancel/redispatch 事务化应用后 ack(at-least-once + 幂等)。命令指向非本机牵头的任务时 ack 丢弃,
   * 绝不让陈旧命令 fail-closed 整节点;传输失败可重试(留 pending 下轮续拉)。暴露供测试/手动驱动,亦由
   * start() 的 commandTimer 周期调用。
   */
  pullCommands(): Promise<void>;
  /**
   * 跨机牵头接管(C2d):导入 origin 导出的 bundle 并按 attempt 高水位 fence(禁双主/终态归档),
   * 随即驱动一次重派——归位 drafting 的在途任务经注入的 selectTarget 立即改派并 flush 新 offer 与
   * 首条上报修订,无需等待下个周期泵。等价 v1 lead/takeover.ts importCheckpoints 的 onNeedDispatch
   * 回调,但接线到持久泵。损坏 bundle/本地状态由 importTasks fail-closed;停机/故障时不触发重派/flush
   * (导入已持久化,重派留待恢复后的周期泵)。
   */
  takeover(bundle: DurableLeadTakeoverBundle): DurableLeadImportResult;
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

/**
 * owner 命令的节点侧最小投影(E3,OWNER-COMMAND §4.3):pullCommands 只需 id/task_id/kind 即可应用与 ack;
 * 完整 CommandRecord 由中心 command-store 校验并投影,节点侧只做防御性解析(绝不盲信网络字节)。
 */
interface NodeCommand { id: string; task_id: string; kind: 'cancel' | 'redispatch' }

function isNodeCommand(value: unknown): value is NodeCommand {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && isUuid(v.task_id) && (v.kind === 'cancel' || v.kind === 'redispatch');
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
  // C1c:driver 可为工厂,用刚装配的持久 runtime 解析(如注入 NodeRuntimeStore 背书的 RunHandleStore)。
  const driver = typeof opts.driver === 'function' ? opts.driver(runtime) : opts.driver;
  // e2d-1:workspace 与 driver 同一解析时机(均事务外、由执行器拥有生命周期)。
  const workspace = typeof opts.workspace === 'function' ? opts.workspace(runtime) : opts.workspace;
  // e2d-2:节点级产物仓配置 → 装配 GitArtifactPublisher(登记私钥 + me.node_id/key_epoch,与信封 from 同源,
  // 使牵头方防线①"清单钥标识 == 署名者"成立)。未配置 → publisher 缺省 → PROJECT offer 被门控拒绝。
  const publisher = opts.artifactRepo !== undefined
    ? new GitArtifactPublisher({ repo: opts.artifactRepo, privKey: opts.privKey, nodeId: me.node_id, keyEpoch: me.key_epoch })
    : undefined;

  const params: QlongParams = { ...(opts.params ?? DEFAULT_PARAMS) };
  const tickIntervalMs = bounded(opts.tickIntervalMs, 1_000, 50, 60_000, 'tickIntervalMs');
  const verifyRetryMs = bounded(opts.verifyRetryMs, 5_000, 100, 600_000, 'verifyRetryMs');
  const shutdownFlushMs = bounded(opts.shutdownFlushMs, 5_000, 0, 600_000, 'shutdownFlushMs');
  const reportIntervalMs = bounded(opts.reportIntervalMs, 60_000, 0, 2_147_483_647, 'reportIntervalMs');
  const gcIntervalMs = bounded(opts.gcIntervalMs, 6 * 3_600_000, 0, 2_147_483_647, 'gcIntervalMs');
  const commandIntervalMs = bounded(opts.commandIntervalMs, 2_000, 0, 600_000, 'commandIntervalMs');

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
  let pullingCommands = false;
  let nextVerifyRetryAt = 0;
  let tickTimer: NodeJS.Timeout | undefined;
  let reportTimer: NodeJS.Timeout | undefined;
  let gcTimer: NodeJS.Timeout | undefined;
  let commandTimer: NodeJS.Timeout | undefined;

  const stopTimers = (): void => {
    if (tickTimer !== undefined) { clearInterval(tickTimer); tickTimer = undefined; }
    if (reportTimer !== undefined) { clearInterval(reportTimer); reportTimer = undefined; }
    if (gcTimer !== undefined) { clearInterval(gcTimer); gcTimer = undefined; }
    if (commandTimer !== undefined) { clearInterval(commandTimer); commandTimer = undefined; }
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
  // drain 不可重入;入账触发在 drain 进行中到达时计数,排空后补跑一轮(否则触发被 guard
  // 吞掉且 batch<批量 即返回,信封会滞留 pending 直到下一次重连/重试 —— 单龙自派单回环稳定复现)。
  let drainTriggers = 0;
  const client = new GatewayClient({
    url: opts.gatewayUrl,
    nodeToken: opts.nodeToken,
    runtime,
    verifyInbound: verify,
    onInboxReady: () => { drainTriggers += 1; void drain(); },
    onFault: failClosed,
  });

  // 6) 事务执行器(单 slot;effect 在提交后由 settle 驱动)。
  const executor = new DurableExecutor({
    store: runtime,
    nodeId: me.node_id,
    teamId: me.team_id,
    params,
    seal,
    driver,
    workspace,
    publisher,
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
    // e2d-3: 牵头侧 E2 验收端口无条件装配(不 gate on artifactRepo)——纯牵头节点(不执行、无产物仓)仍需验收
    // PROJECT 产物:collect 的 repo 来自信封 inlineRepo、resolve 用 {registryUrl,nodeToken}+me 恒可用。缺省走真实
    // git 收取 + registry HTTP 回源公钥;测试/替代信任根可注入。端口缺席 → stageArtifactVerification 短路 → fail-closed。
    collectArtifacts: opts.collectArtifacts ?? createGitArtifactCollector(),
    resolvePubkey: opts.resolvePubkey ?? createPubkeyResolver(opts, me),
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
          // 单机形态(愿景:一条龙独立干活):本机牵头的任务可以自派单(target=本机),全部任务信封
          // 自寻址回环 —— 必须按"收件角色"而非"本机是否牵头"路由:执行半绑定类型(offer 启动 /
          // lease.renew 续租 / cancel 停止)恒进执行器;其余(accept/progress/result/fail/reject/
          // cancel.ack 等)才是发给牵头半的回执。跨节点形态不受影响(那些类型本就不会发给本机牵头)。
          const executorBound =
            env.type === 'task.offer' || env.type === 'task.lease.renew' || env.type === 'task.cancel';
          if (ledByUs && !executorBound) {
            // e2d-3: PROJECT task.result 在 consume 前异步预置验收判定(collect+验签+重新哈希+契约核对)。
            // best-effort——方法内部 try/catch 全吞:预置异常/端口缺席 → 判定缺席 → 机器 fail-closed,绝不放大为节点 fault。
            await lead.stageArtifactVerification(env);
            lead.consume(env, true); // 故障在牵头方内闭锁并回调;错误向调用方传播
          } else {
            executor.consume(env, true); // 故障在执行器内闭锁并回调;错误向调用方传播
            await executor.settle();
          }
        }
        nextVerifyRetryAt = skipped ? Date.now() + verifyRetryMs : 0;
        if (batch.length < PUMP_BATCH) return;
      }
    } finally {
      draining = false;
      // 排空期间有新入账触发 → 补跑一轮(幂等:pending 空则立即返回)
      if (!stopped && !faulted && drainTriggers > 0) {
        drainTriggers = 0;
        void drain().catch(() => { /* 故障已闭锁 */ });
      }
    }
  }

  /** 单所有者、带重入守卫的持久上报泵送:传输失败留在 pending 等下次;损坏/存储故障 fail-closed。 */
  const flushReports = (): void => {
    if (flushing) return;
    flushing = true;
    void reporter.flush()
      .catch(() => { failClosed(); }) // 仅畸形 intent/存储故障会 reject;传输失败已被 reporter 内部吞掉
      .finally(() => { flushing = false; });
  };

  /** 命令 ack(best-effort):POST /v1/nodes/me/commands/:id/ack。丢失 → 命令重拉重应用,幂等兜底(§1.7)。 */
  const ackCommand = async (base: string, id: string): Promise<void> => {
    try {
      await fetch(`${base}/v1/nodes/me/commands/${encodeURIComponent(id)}/ack`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + opts.nodeToken },
        signal: AbortSignal.timeout(5_000),
        redirect: 'error',
      });
    } catch { /* best-effort:ack 丢失不影响正确性,命令留 pending 下轮重拉重应用(幂等) */ }
  };

  /**
   * owner 命令 PULL(E3,OWNER-COMMAND §4.3):GET 中心 pending 命令 → 逐条事务化应用 → ack。at-least-once +
   * 幂等:ack 前崩溃/丢失则命令重拉重应用,由机器守卫(cancelByUser/redispatchByOwner 对终态/cancelling/
   * reclaiming no-op)保证无重复副作用。
   *
   * 关键(§7):命令可能指向本机从未 originate / 已 GC 的任务——lead.cancel/redispatch 对未 originate 任务会抛出,
   * 经 checked 触发整节点 fail-closed。故先以 runtime.state(leadStateKey) 预检 ledByUs(镜像 drain):非本机牵头
   * → ack 丢弃(陈旧命令重拉无益),绝不让它 fault 节点。ledByUs 为真却仍抛出 = 真实存储/损坏故障 → 已 fail-closed,
   * 不 ack(留 pending 待恢复)。传输失败(GET/ack)可重试:GET 失败本轮放弃,下轮 commandTimer 续拉,绝不伪称“无命令”。
   */
  async function pullCommands(): Promise<void> {
    if (stopped || faulted || pullingCommands) return;
    pullingCommands = true;
    try {
      const base = opts.registryUrl.replace(/\/+$/, '');
      let commands: unknown[];
      try {
        const res = await fetch(`${base}/v1/nodes/me/commands`, {
          method: 'GET',
          headers: { Authorization: 'Bearer ' + opts.nodeToken },
          signal: AbortSignal.timeout(5_000),
          redirect: 'error',
        });
        if (!res.ok) return; // 中心瞬断/503:本轮放弃,下轮重拉(绝不当成“无命令”而漏掉 pending)
        const json = await res.json() as { commands?: unknown };
        commands = Array.isArray(json.commands) ? json.commands : [];
      } catch {
        return; // 网络/解析失败:可重试,下轮 commandTimer 续拉
      }
      for (const raw of commands) {
        if (stopped || faulted) return;
        if (!isNodeCommand(raw)) continue; // 畸形命令:跳过(中心已 shape 校验;无有效 id 无法 ack)
        // ledByUs 预检(§7):非本机牵头 → 陈旧命令,ack 丢弃;否则 lead.cancel/redispatch 会抛 → 整节点 fail-closed。
        if (runtime.state(leadStateKey(raw.task_id)) === undefined) { await ackCommand(base, raw.id); continue; }
        try {
          if (raw.kind === 'cancel') lead.cancel(raw.task_id);
          else lead.redispatch(raw.task_id);
        } catch {
          // lead 事务故障(存储/损坏):已 fail-closed 并回调;不 ack,命令留 pending 待恢复后续拉。
          return;
        }
        await ackCommand(base, raw.id); // 应用成功(或幂等 no-op)→ ack;丢失则重拉重应用(幂等兜底)
      }
    } finally {
      pullingCommands = false;
    }
  }

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
    pullCommands,
    takeover: (bundle: DurableLeadTakeoverBundle): DurableLeadImportResult => {
      // importTasks 内部对损坏 bundle / 本地状态 fail-closed(抛出并回调 onFault),绝不静默接管。
      const result = lead.importTasks(bundle);
      // 立即驱动一次重派(在途任务经 selectTarget 改派)+ flush 新 offer/上报,无需等待周期泵。
      if (!stopped && !faulted) {
        try { lead.tick(); } catch { /* 故障已闭锁:tick 内已 fail-closed 并回调 */ }
        client.flush();
        flushReports();
      }
      return result;
    },
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
      // owner 命令泵(E3):周期 PULL 中心命令并事务化应用。重启后 pending 命令由中心续存,首次触发即续拉(§1.1)。
      if (commandIntervalMs > 0) {
        commandTimer = setInterval(() => { void pullCommands().catch(() => { /* 故障已由 store/lead 闭锁 */ }); }, commandIntervalMs);
        commandTimer.unref();
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
