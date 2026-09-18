/**
 * qlong server(中心三件套 v0.2 单进程形态):registry HTTP + 通讯网关 ws,同进程同步目录快照。
 * 网关是有状态组件(连接表 + 收件箱)——单实例为 v0.2 形态,集群化见 02 §12.1 开放问题。
 */
import { Registry, createRegistryServer, CENTER_SCHEMA, type CenterStorageOptions } from '../../registry/src/index.js';
import { SqliteStore } from '../../storage/src/index.js';
import { AuthService } from '../../registry/src/auth.js';
import { GatewayCore } from '../../gateway/src/core.js';
import { InboxStore } from '../../gateway/src/mailbox.js';
import { SqliteCustodyStore } from '../../gateway/src/custody-store.js';
import type { EnvelopeV1 } from '@qlong/core';
import { validateEnvelope } from '@qlong/core';
import { WsGateway } from '../../gateway/src/ws.js';
import { GatewayCluster, type ClusterMember } from '../../gateway/src/cluster.js';
import { HttpClusterBus } from '../../gateway/src/bus.js';

export interface ServerHandles {
  close(): Promise<void>;
  /** SQLite includes v2 mailbox custody, not a durable task executor. */
  storageMode: 'sqlite' | 'ephemeral';
  registryPort: number;
  /** 双端口模式下的网关端口;单端口模式为 0(网关在 registryPort 的 gatewayPath 上) */
  gatewayPort: number;
  /** 单端口模式下的网关挂载路径 */
  gatewayPath?: string;
  /** 账号/会话服务(登录、登出、me) */
  auth: import('../../registry/src/auth.js').AuthService;
  /** 集群路由器(设置 clusterSecret 后存在;02 §12.1) */
  readonly cluster?: GatewayCluster;
  /** 最近一次 GC 结果(运营观测) */
  readonly lastGc: { removedOrphanTeams: number; revokedOfflineNodes: number };
}

export interface ServerOptions {
    storage?: CenterStorageOptions;
    /** Explicit local test/demo only. Never an automatic storage-failure fallback. */
    ephemeral?: boolean;
    registryPort?: number;
    gatewayPort?: number;
    host?: string;
    enrollRatePerMinPerIp?: number;
    /** GC 周期(默认 6h;0 = 关闭) */
    gcIntervalMs?: number;
    /**
     * 持久 custody 墓碑保留窗口 ms:终态(received/expired)记录超过该窗口由 GC 周期回收;
     * 缺省 undefined = 关闭回收(墓碑永久保留),0 = 立即回收。pending 载荷永不回收。
     */
    custodyRetentionMs?: number;
    /** 书坊分发目录(纪要 §3):提供 /install.sh、/install.ps1、/install、/releases/<版本>/<文件> */
    distDir?: string;
    /** Legacy test/migration option; forbidden alongside center SQLite. */
    authPersistDir?: string;
    /** 网关收件箱落盘文件(v0.8 FileMailboxStore:重启收件箱不丢);缺省内存态 */
    inboxPersistFile?: string;
    /**
     * 单端口部署(创空间/容器):网关挂到 HTTP 服务的该路径(ws upgrade),
     * registry/书坊/控制台/网关共用 registryPort。设置后忽略 gatewayPort。
     */
    gatewayPath?: string;
    /** 种子团队:目录为空时自动创建(创空间首启体验) */
    seedTeam?: { name?: string } | false;
    ownerAuth?: (req: import('node:http').IncomingMessage, teamId: string) => boolean | Promise<boolean>;
    /**
     * 网关集群(02 §12.1,v0.8):设置后开启集群路由 + POST /internal/envelope 中继端点。
     * peers 非空时跨进程转投(HTTP 总线);空 = 单实例集群形态(仅收件箱 deferOffline 语义)。
     */
    clusterSecret?: string;
    /** 集群成员名(默认 gw1;分片按成员序列稳定哈希,扩缩容前成员序列须一致) */
    clusterName?: string;
    /** 远端网关基地址列表(如 ['https://gw2:3100']) */
    clusterPeers?: string[];
}

export async function startQlongServer(opts: ServerOptions = {}): Promise<ServerHandles> {
  if (opts.ephemeral === true && opts.storage) throw new Error('Choose SQLite or explicit ephemeral mode, not both');
  if (!opts.storage && opts.ephemeral !== true) throw new Error('Center storage required: explicit create/open, or local --ephemeral demo');
  if (opts.ephemeral === true && opts.host !== undefined && !['127.0.0.1', '::1'].includes(opts.host)) {
    throw new Error('Ephemeral center is restricted to loopback');
  }
  if (opts.storage && (opts.authPersistDir !== undefined || opts.inboxPersistFile !== undefined)) {
    throw new Error('Legacy files require explicit migration; refusing mixed storage authorities');
  }
  if (opts.storage && (opts.clusterSecret !== undefined || (opts.clusterPeers?.length ?? 0) > 0)) {
    throw new Error('Durable center currently supports one authority only; gateway-only transport v2 is not ready');
  }
  const storage = opts.storage ? SqliteStore.open({ ...opts.storage, schema: CENTER_SCHEMA, filename: 'center.sqlite' }) : undefined;
  try {
    return await startServices(opts, storage);
  } catch (error) {
    storage?.close();
    throw error;
  }
}

async function startServices(opts: ServerOptions, storage?: SqliteStore): Promise<ServerHandles> {
  const host = opts.host ?? (opts.ephemeral ? '127.0.0.1' : '0.0.0.0');
  const registry = new Registry({ now: () => Date.now(), storage });
  // 人类账号与会话(02 §3.1):owner 端点经登录会话 Cookie 鉴权
  const auth = new AuthService({ now: () => Date.now(), storage, persistDir: opts.authPersistDir });
  if (opts.seedTeam !== false && registry.teams.size === 0) {
    const t = registry.createTeam({ name: opts.seedTeam?.name ?? '默认团队', owner_user_id: 'owner' });
    console.log('种子团队已创建: team_id =', t.team_id);
  }
  const core = new GatewayCore({
    inbox: opts.inboxPersistFile
      ? new InboxStore<EnvelopeV1>({ capacity: 200, persistFile: opts.inboxPersistFile })
      : undefined,
  });
  core.grantLookup = (from, to) => registry.grantCaps(from, to);
  // 集群形态(02 §12.1):clusterSecret 存在即注册自身成员;peers 存在再挂跨进程总线。
  // 顺序约束:member 闭包引用 gw,故 cluster 先建、gw 携带 cluster 构造、随后 register。
  const clusterSecret = opts.clusterSecret;
  let cluster: GatewayCluster | undefined;
  if (clusterSecret) {
    cluster = new GatewayCluster();
    const peers = (opts.clusterPeers ?? []).filter((u) => u.length > 0);
    if (peers.length > 0) {
      cluster.attachBus(
        new HttpClusterBus({
          secret: clusterSecret,
          peers: peers.map((url, i) => ({ name: `peer${i + 1}`, url })),
        }),
      );
    }
  }
  const custody = storage ? new SqliteCustodyStore(storage, { retentionMs: opts.custodyRetentionMs }) : undefined;
  const gw = new WsGateway({
    core,
    custody,
    cluster,
    clusterSecret,
    assertAuthorityAvailable: () => { if (storage) void storage.database; },
    onPresenceChange: (nodeId, online) => { registry.presence.set(nodeId, online); },
    authenticate: (tok: string) => {
      try {
        const n = registry.authByToken(tok);
        return { node_id: n.node_id, team_id: n.team_id, status: n.status };
      } catch {
        return undefined;
      }
    },
  });
  if (cluster) {
    const self: ClusterMember = {
      name: opts.clusterName ?? 'gw1',
      core,
      has: (nodeId) => gw.has(nodeId),
      deliver: (nodeId, envelope) => gw.deliverTo(nodeId, envelope),
    };
    cluster.register(self);
  }
  const httpServer = createRegistryServer({
    registry,
    auth,
    enrollRatePerMinPerIp: opts.enrollRatePerMinPerIp ?? 60,
    distDir: opts.distDir,
    // 单端口形态的集群中继(02 §12.1):与 ws.ts 独立端口中继语义一致
    clusterSecret,
    onInternalEnvelope: clusterSecret
      ? (toNodeId, envelope) => {
          // 信任域内仍校验结构(与 ws.ts 中继同源原则):畸形信封不入箱、不上连接
          if (!validateEnvelope(envelope).ok) throw new Error('bad envelope');
          return gw.internalDeliver(toNodeId, envelope as EnvelopeV1, Date.now());
        }
      : undefined,
    // 投递结果查询(A2):接线中心 custody outcome();无中心 SQLite(ephemeral)时保持 undefined → 路由 503 失败关闭。
    deliveryOutcome: custody ? (fromNode, msgId) => custody.outcome(fromNode, msgId) : undefined,
  });

  const sync = (): void => {
    gw.syncRegistry(registry.snapshot(), (id) => registry.getNode(id)?.status);
  };
  const offChange = registry.onDirectoryChange(sync);
  let syncTimer: NodeJS.Timeout | undefined;
  let gcTimer: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      offChange();
      clearInterval(syncTimer);
      clearInterval(gcTimer);
      // Stop listening before draining requests/WS, and release ownership LAST.
      const force = setTimeout(() => httpServer.closeAllConnections(), 1_000);
      force.unref();
      try {
        await Promise.all([
          new Promise<void>((resolve) => httpServer.close(() => resolve())),
          gw.close(),
        ]);
        storage?.close();
      } finally { clearTimeout(force); }
    })();
    return closing;
  };
  const guarded = (operation: () => void): (() => void) => () => {
    try { operation(); } catch {
      // A background storage fault must not keep stale authority online or escape a timer.
      console.error('Center storage/synchronization unavailable; stopping admission');
      void close().catch(() => { console.error('Center shutdown failed; recovery required'); });
    }
  };
  try {
    // Restore, GC, and synchronize BEFORE either listener admits authenticated traffic.
    let gcResult = registry.gc();
    sync();
    let gatewayPort = 0;
    if (opts.gatewayPath) gw.attach(httpServer, opts.gatewayPath);
    else gatewayPort = await gw.listen(opts.gatewayPort ?? 3100, host);
    const registryPort = await new Promise<number>((resolve, reject) => {
      const onError = (error: Error): void => { cleanup(); reject(error); };
      const onListening = (): void => { cleanup(); resolve((httpServer.address() as { port: number }).port); };
      const cleanup = (): void => { httpServer.off('error', onError); httpServer.off('listening', onListening); };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      try { httpServer.listen(opts.registryPort ?? Number(process.env.PORT ?? 3200), host); }
      catch (error) { cleanup(); reject(error); }
    });
    syncTimer = setInterval(guarded(sync), 60_000);
    const gcIntervalMs = opts.gcIntervalMs ?? 6 * 3_600_000;
    // One housekeeping cadence reclaims both directory orphans and terminal custody tombstones.
    // A corrupt tombstone faults prune(), which guarded() turns into a fail-closed shutdown.
    if (gcIntervalMs > 0) gcTimer = setInterval(guarded(() => { gcResult = registry.gc(); custody?.prune(Date.now()); }), gcIntervalMs);
    return {
      registryPort, gatewayPort, gatewayPath: opts.gatewayPath, auth, cluster, close,
      storageMode: storage ? 'sqlite' : 'ephemeral',
      get lastGc() { return gcResult; },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
