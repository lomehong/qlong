/**
 * qlong server(中心三件套 v0.2 单进程形态):registry HTTP + 通讯网关 ws,同进程同步目录快照。
 * 网关是有状态组件(连接表 + 收件箱)——单实例为 v0.2 形态,集群化见 02 §12.1 开放问题。
 */
import { Registry, createRegistryServer } from '../../registry/src/index.js';
import { AuthService } from '../../registry/src/auth.js';
import { GatewayCore } from '../../gateway/src/core.js';
import { InboxStore } from '../../gateway/src/mailbox.js';
import type { EnvelopeV1 } from '@qlong/core';
import { validateEnvelope } from '@qlong/core';
import { WsGateway } from '../../gateway/src/ws.js';
import { GatewayCluster, type ClusterMember } from '../../gateway/src/cluster.js';
import { HttpClusterBus } from '../../gateway/src/bus.js';

export interface ServerHandles {
  close(): Promise<void>;
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

export async function startQlongServer(
  opts: {
    registryPort?: number;
    gatewayPort?: number;
    host?: string;
    enrollRatePerMinPerIp?: number;
    /** GC 周期(默认 6h;0 = 关闭) */
    gcIntervalMs?: number;
    /** 书坊分发目录(纪要 §3):提供 /install.sh、/install.ps1、/install、/releases/<版本>/<文件> */
    distDir?: string;
    /** 账号持久化目录(设置后重启不丢账号);缺省内存态 */
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
  } = {},
): Promise<ServerHandles> {
  const host = opts.host ?? '0.0.0.0';
  const registry = new Registry({ now: () => Date.now() });
  // 人类账号与会话(02 §3.1):owner 端点经登录会话 Cookie 鉴权
  const auth = new AuthService({ now: () => Date.now(), persistDir: opts.authPersistDir });
  if (opts.seedTeam !== false && registry.teams.size === 0) {
    const t = registry.createTeam({ name: opts.seedTeam?.name ?? '默认团队', owner_user_id: 'owner' });
    console.log('种子团队已创建: team_id =', t.team_id);
  }
  const core = new GatewayCore({
    inbox: opts.inboxPersistFile
      ? new InboxStore<EnvelopeV1>({ capacity: 200, persistFile: opts.inboxPersistFile })
      : undefined,
  });
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
  const gw = new WsGateway({
    core,
    cluster,
    clusterSecret,
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
  });

  // 单端口 vs 双端口:gatewayPath 设置 → 网关挂到 HTTP 同端口(/gateway upgrade)
  let gatewayPort = 0;
  if (opts.gatewayPath) {
    gw.attach(httpServer, opts.gatewayPath);
  } else {
    gatewayPort = await gw.listen(opts.gatewayPort ?? 3100, host);
  }
  const registryPort = await new Promise<number>((resolve) => {
    httpServer.listen(opts.registryPort ?? Number(process.env.PORT ?? 3200), host, () => {
      resolve((httpServer.address() as { port: number }).port);
    });
  });
  const sync = (): void => {
    gw.syncRegistry(registry.snapshot(), (id) => registry.getNode(id)?.status);
  };
  // §7.1:目录变更即时推送(join/suspend/revoke/轮换经 onDirectoryChange 触发)
  const offChange = registry.onDirectoryChange(sync);
  // 60s 兜底全量同步 + 启动首推
  sync();
  const syncTimer = setInterval(sync, 60_000);
  // GC(评审 I-16/I-48):启动跑一次 + 每 6 小时周期
  const gcIntervalMs = opts.gcIntervalMs ?? 6 * 3_600_000;
  let gcResult = registry.gc();
  const gcTimer = gcIntervalMs > 0 ? setInterval(() => (gcResult = registry.gc()), gcIntervalMs) : undefined;
  return {
    registryPort,
    gatewayPort,
    gatewayPath: opts.gatewayPath,
    auth,
    cluster,
    get lastGc(): { removedOrphanTeams: number; revokedOfflineNodes: number } {
      return gcResult;
    },
    close: async () => {
      offChange();
      clearInterval(syncTimer);
      if (gcTimer) clearInterval(gcTimer);
      await gw.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
