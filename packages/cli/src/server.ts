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
}

export async function startQlongServer(
  opts: { registryPort?: number; gatewayPort?: number; host?: string; enrollRatePerMinPerIp?: number } = {},
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
  });
  const registryPort = await new Promise<number>((resolve) => {
    httpServer.listen(opts.registryPort ?? 3200, host, () => {
      resolve((httpServer.address() as { port: number }).port);
    });
  });
  // 目录快照 → 网关(02 §7.1:epoch 推进的简化实现——周期全量同步;增量推送列 v0.3)
  const syncTimer = setInterval(() => {
    gw.syncRegistry(registry.snapshot(), (id) => registry.getNode(id)?.status);
  }, 5_000);
  return {
    registryPort,
    gatewayPort,
    close: async () => {
      clearInterval(syncTimer);
      await gw.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
