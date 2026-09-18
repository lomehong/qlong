import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { newId } from '@qlong/core';
import { defineMigration, SqliteStore, type SqliteStoreOptions } from '../../storage/src/index.js';
import { GatewayCore } from '../src/core.js';
import { AUTH_KEY, WsGateway } from '../src/ws.js';
import { CLAIM_SQL, SqliteClaimStore } from '../src/claim-store.js';
import { waitFor } from './wait.js';

/**
 * D1c:跨进程 claim 收敛——两个**独立** WsGateway 实例(各自的 GatewayCore/端口/socket 表)
 * **仅**通过一个共享的持久 SqliteClaimStore 相互可见。这正是两进程共享中心 claim 表的忠实模型:
 * 若把两者换成各自的内存 LocalClaimRegistry,分裂脑将永不收敛(见变异检验)。
 *
 * 验证设计 §4.2「generation = fencing token,高者恒胜」在真实网关续租/fence-drop 路径上跨进程成立:
 * 节点重连到对端网关 → 共享 seq 单调 +1 → 旧 authority 下次 renew 被 fence(false)→ 丢弃本地僵尸连接。
 */
const NODE = { node_id: newId(), team_id: newId(), status: 'active' };
const schema = {
  id: 'qlong.cluster-claim-test',
  migrations: [defineMigration({ version: 1, name: 'claim', sql: CLAIM_SQL })],
};

const gateways: WsGateway[] = [];
const clients: WebSocket[] = [];
const stores = new Set<SqliteStore>();
const tempBase = realpathSync(tmpdir());
const roots = new Set<string>();

/** 打开一个共享持久注册表:两个网关将注入同一个 SqliteClaimStore(跨进程的唯一共享介质)。 */
function openShared(): SqliteClaimStore {
  const root = mkdtempSync(join(tempBase, 'qlong-cluster-claim-'));
  roots.add(root);
  const options: SqliteStoreOptions = {
    allowedBase: root, dataDir: join(root, 'data'), mode: 'create', schema,
    localFilesystemConfirmed: true, windowsAclConfirmed: true, busyTimeoutMs: 25,
  };
  const storage = SqliteStore.open(options);
  stores.add(storage);
  // leaseTtl 远大于 renew 周期:收敛靠 renew 被 fence(false),而非租约过期被 reap。
  return new SqliteClaimStore(storage, { leaseTtlMs: 5_000 });
}

function makeGateway(claims: SqliteClaimStore, authorityId: string): WsGateway {
  const gateway = new WsGateway({
    core: new GatewayCore(),
    authenticate: () => NODE,
    claimRegistry: claims,
    authorityId,
    claimRenewIntervalMs: 30,
  });
  gateways.push(gateway);
  return gateway;
}

/** 持久收集器在 auth 前装好,close/message 竞态不会丢事件(同 presence-lifecycle)。 */
async function connect(gateway: WsGateway, port: number) {
  const accepted = new Promise<WebSocket>((resolve) => gateway.wss.once('connection', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  clients.push(ws);
  const opened = once(ws, 'open');
  ws.on('error', () => { /* 连接失败 reject opened;teardown 不得抛未捕获错误。 */ });
  const frames: Array<Record<string, unknown>> = [];
  ws.on('message', (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  await opened;
  const serverWs = await accepted;
  return {
    ws, serverWs, frames, closed,
    sendAuth() { ws.send(JSON.stringify({ frame: 'auth', [AUTH_KEY]: 'cluster-claim-fixture' })); },
    async waitForFrame(frame: string) {
      expect(await waitFor(() => frames.some((f) => f.frame === frame))).toBe(true);
      return frames.find((f) => f.frame === frame)!;
    },
  };
}

afterEach(async () => {
  for (const ws of clients.splice(0)) ws.terminate();
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  for (const storage of [...stores].reverse()) storage.close();
  stores.clear();
  for (const root of roots) {
    if (dirname(root) !== tempBase || !basename(root).startsWith('qlong-cluster-claim-')) {
      throw new Error('Unsafe cluster-claim test cleanup target');
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  roots.clear();
});

describe('Cross-process claim convergence (D1c: two WsGateway sharing one SqliteClaimStore)', () => {
  it('fence-drops the stale authority when the node reconnects to a peer via the shared registry (§4.2 split-brain)', async () => {
    const claims = openShared();
    const gwA = makeGateway(claims, 'gwA');
    const gwB = makeGateway(claims, 'gwB');
    const portA = await gwA.listen();
    const portB = await gwB.listen();

    // 节点先连 gwA:共享注册表登记 gen1/gwA。
    const connA = await connect(gwA, portA);
    connA.sendAuth();
    await connA.waitForFrame('auth_ok');
    expect(gwA.has(NODE.node_id)).toBe(true);
    expect(claims.lookup(NODE.node_id)).toMatchObject({ authorityId: 'gwA', generation: 1 });

    // 分裂脑:同一节点经共享持久注册表重连到 gwB → gen2/gwB(跨进程单调,共享 seq 高水位)。
    const connB = await connect(gwB, portB);
    connB.sendAuth();
    await connB.waitForFrame('auth_ok');
    expect(gwB.has(NODE.node_id)).toBe(true);
    expect(claims.lookup(NODE.node_id)).toMatchObject({ authorityId: 'gwB', generation: 2 });

    // gwA 的续租定时器发现 renew(gwA, gen1) 被更高 generation fence(false)→ 丢弃本地僵尸连接(自愈)。
    expect(await waitFor(() => !gwA.has(NODE.node_id), 1_000)).toBe(true);
    expect((await connA.closed).code).toBe(4000); // superseded
    // 新主 gwB 不受损:gwA 的 release(gwA, gen1) 被 fence 拒绝,未误删 gwB gen2。
    expect(gwB.has(NODE.node_id)).toBe(true);
    expect(claims.lookup(NODE.node_id)).toMatchObject({ authorityId: 'gwB', generation: 2 });
    expect(connB.frames.some((f) => f.frame === 'closing')).toBe(false); // gwB 连接未被误关
  });

  it('arbitrates symmetrically: a later reconnect to the first authority reclaims a higher generation and flips the fence', async () => {
    const claims = openShared();
    const gwA = makeGateway(claims, 'gwA');
    const gwB = makeGateway(claims, 'gwB');
    const portA = await gwA.listen();
    const portB = await gwB.listen();

    const connA1 = await connect(gwA, portA);
    connA1.sendAuth();
    await connA1.waitForFrame('auth_ok'); // gen1/gwA
    const connB = await connect(gwB, portB);
    connB.sendAuth();
    await connB.waitForFrame('auth_ok'); // gen2/gwB → gwA 被 fence-drop
    expect(await waitFor(() => !gwA.has(NODE.node_id), 1_000)).toBe(true);

    // 节点再连回 gwA:经共享 seq 得 gen3(跨进程高水位单调,绝不复用)→ 现在轮到 gwB 被 fence。
    const connA2 = await connect(gwA, portA);
    connA2.sendAuth();
    await connA2.waitForFrame('auth_ok');
    expect(claims.lookup(NODE.node_id)).toMatchObject({ authorityId: 'gwA', generation: 3 });
    expect(await waitFor(() => !gwB.has(NODE.node_id), 1_000)).toBe(true);
    expect((await connB.closed).code).toBe(4000); // gwB 的僵尸连接被丢弃
    expect(gwA.has(NODE.node_id)).toBe(true); // 现主 gwA(gen3)在线
    expect(claims.lookup(NODE.node_id)).toMatchObject({ authorityId: 'gwA', generation: 3 });
  });
});
