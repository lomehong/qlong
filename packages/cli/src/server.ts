/**
 * qlong server(中心三件套 v0.2 单进程形态):registry HTTP + 通讯网关 ws,同进程同步目录快照。
 * 网关是有状态组件(连接表 + 收件箱)——单实例为 v0.2 形态,集群化见 02 §12.1 开放问题。
 */
import { Registry, createRegistryServer } from '../../registry/src/index.js';
import { GatewayCore } from '../../gateway/src/core.js';
import { WsGateway } from '../../gateway/src/ws.js';

export interface ServerHandles {
  close(): Promise<void>;
  registryPort: number;
  gatewayPort: number;
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
  } = {},
): Promise<ServerHandles> {
  const host = opts.host ?? '127.0.0.1';
  const registry = new Registry({ now: () => Date.now() });
  const core = new GatewayCore();
  const gw = new WsGateway({
    core,
    authenticate: (tok: string) => {
      try {
        const n = registry.authByToken(tok);
        return { node_id: n.node_id, team_id: n.team_id, status: n.status };
      } catch {
        return undefined;
      }
    },
  });
  const gatewayPort = await gw.listen(opts.gatewayPort ?? 3100, host);
  const httpServer = createRegistryServer({
    registry,
    enrollRatePerMinPerIp: opts.enrollRatePerMinPerIp ?? 60,
    distDir: opts.distDir,
  });
  const registryPort = await new Promise<number>((resolve) => {
    httpServer.listen(opts.registryPort ?? 3200, host, () => {
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
