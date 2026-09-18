import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CUSTODY_FEATURES, TRANSPORT_VERSION, type EnvelopeV1 } from '@qlong/core';
import { defineMigration, SqliteStore, type SqliteStoreOptions } from '../../storage/src/index.js';
import { GatewayCore } from '../src/core.js';
import { WsGateway } from '../src/ws.js';
import { SqliteClaimStore } from '../src/claim-store.js';
import { CLAIM_SQL } from '../src/claim-store.js';
import { CUSTODY_SQL, SqliteCustodyStore } from '../src/custody-store.js';
import { AUTH_KEY } from '../src/ws.js';
import { makeEnvelope, nodes, source, target } from './transport-v2-helpers.js';
import { waitFor } from './wait.js';

/**
 * d1d:custody 集群路由解禁 —— 双 authority(独立 WsGateway 实例)**共享同一中心 SQLite**
 * (custody + claim 表),经 POST /internal/pump 中继做低延迟推送定向(设计 §4.4):
 * - admitCustody 落共享库 → 本端无目标连接 → 查 claim:他 authority 持现租约 → 通知其泵
 *   (只传 to_node_id + generation,不传 payload);
 * - fence 守卫:仅现主 (authorityId, generation) 才泵(防陈旧主双服务);
 * - 无 claim / 租约过期(离线)→ 不通知,静置共享库(认证补投/彼方周期泵兜底);
 * - 通知丢失不破坏正确性:peer 不可达仍 stored,彼方周期泵兜底。
 */
const schema = {
  id: 'qlong.custody-relay-test',
  migrations: [
    defineMigration({ version: 1, name: 'custody', sql: CUSTODY_SQL }),
    defineMigration({ version: 2, name: 'claim', sql: CLAIM_SQL }),
  ],
};
const SECRET = 'relay-secret';

const roots: string[] = [];
const storages: SqliteStore[] = [];
const gateways: WsGateway[] = [];
const sockets: WebSocket[] = [];
const httpServers: Server[] = [];

afterEach(async () => {
  for (const s of sockets) { try { s.close(); } catch { /* ignore */ } }
  sockets.length = 0;
  for (const g of gateways) await g.close();
  gateways.length = 0;
  for (const s of httpServers) await new Promise<void>((r) => s.close(() => r()));
  httpServers.length = 0;
  for (const s of storages) s.close();
  storages.length = 0;
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots.length = 0;
});

function openShared(): { storage: SqliteStore; custody: SqliteCustodyStore; claims: SqliteClaimStore } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qlong-custody-relay-')));
  roots.push(root);
  const options: SqliteStoreOptions = {
    mode: 'create', allowedBase: root, dataDir: join(root, 'data'), schema,
    localFilesystemConfirmed: true, windowsAclConfirmed: true, busyTimeoutMs: 25,
  };
  const storage = SqliteStore.open(options);
  storages.push(storage);
  const custody = new SqliteCustodyStore(storage);
  const claims = new SqliteClaimStore(storage, { leaseTtlMs: 60_000 });
  return { storage, custody, claims };
}

async function mkGateway(
  shared: ReturnType<typeof openShared>, authorityId: string, relayPeers?: string[],
): Promise<{ gw: WsGateway; port: number }> {
  const core = new GatewayCore();
  core.setDirectory({ epoch: 1, nodes });
  const gw = new WsGateway({
    core, custody: shared.custody, claimRegistry: shared.claims,
    authorityId,
    authenticate: (id) => nodes.find((n) => n.node_id === id),
    // 长重投间隔:周期泵 sweep 仍 ≤100ms 兜底,但 relay 即时泵是断言的主路径(通知内容另有 spy 断言)
    retryIntervalMs: 5_000,
    claimRenewIntervalMs: 25,
    relaySecret: SECRET,
    relayPeers,
  });
  gateways.push(gw);
  const port = await gw.listen();
  return { gw, port };
}

/** 认证过的原始对端(auth_ok 前 pre-auth 竞态不丢帧:先挂 message 监听再发 auth)。 */
async function peer(gw: WsGateway, port: number, node = source) {
  const accepted = new Promise<WebSocket>((resolve) => gw.wss.once('connection', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on('error', () => { /* close 竞态;断言走 frames */ });
  sockets.push(ws);
  const frames: Array<Record<string, unknown>> = [];
  ws.on('message', (d) => frames.push(JSON.parse(String(d)) as Record<string, unknown>));
  await opened(ws);
  await accepted;
  ws.send(JSON.stringify({ frame: 'auth', [AUTH_KEY]: node.node_id, transport_version: TRANSPORT_VERSION, features: CUSTODY_FEATURES }));
  expect(await waitFor(() => frames.some((f) => f.frame === 'auth_ok'))).toBe(true);
  return {
    ws, frames,
    send(envelope: EnvelopeV1): void { ws.send(JSON.stringify({ frame: 'envelope', envelope })); },
    async stored(after = 0): Promise<Record<string, unknown>> {
      expect(await waitFor(() => frames.slice(after).some((f) => f.frame === 'stored'))).toBe(true);
      return frames.slice(after).find((f) => f.frame === 'stored')!;
    },
  };
}

function opened(ws: WebSocket): Promise<void> {
  return once(ws, 'open').then(() => undefined);
}

/** 独立 spy HTTP server:记录 /internal/pump 通知内容(generation 断言用)。 */
async function spyRelay(): Promise<{ url: string; requests: Array<{ to: string; generation: number }>; hit: (path: string) => Promise<number> }> {
  const requests: Array<{ to: string; generation: number }> = [];
  let unknownPaths = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      if (req.method !== 'POST' || !(req.url ?? '').endsWith('/internal/pump')) {
        unknownPaths += 1;
        res.writeHead(404); res.end(); return;
      }
      const b = JSON.parse(raw) as { to_node_id: string; generation: number };
      requests.push({ to: b.to_node_id, generation: b.generation });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pumped: true }));
    });
  });
  httpServers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    hit: (path: string): Promise<number> => fetch(`http://127.0.0.1:${port}${path}`).then((r) => r.status),
  };
}

const post = (port: number, body: unknown, secret = SECRET): Promise<{ status: number; json: { pumped?: boolean } }> =>
  fetch(`http://127.0.0.1:${port}/internal/pump`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret ? { 'x-qlong-relay-secret': secret } : {}) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: (await r.json()) as { pumped?: boolean } }));

describe('d1d:custody 集群路由 —— /internal/pump 中继(双 authority 共享中心库)', () => {
  it('admitCustody 落共享库后按 claim 通知他 authority 泵;通知携带正确 (to_node_id, generation)', async () => {
    const shared = openShared();
    const gw2 = await mkGateway(shared, 'gw2');
    const spy = await spyRelay();
    const gw1 = await mkGateway(shared, 'gw1', [spy.url, `http://127.0.0.1:${gw2.port}`]);

    const tp = await peer(gw2.gw, gw2.port, target);   // 目标连在 gw2
    const sp = await peer(gw1.gw, gw1.port, source);   // 发送方连在 gw1
    sp.send(makeEnvelope());
    await sp.stored();                                  // store-then-push:先落共享库
    await waitFor(() => spy.requests.length >= 1);
    const claim = shared.claims.lookup(target.node_id);
    expect(spy.requests[0]).toEqual({ to: target.node_id, generation: claim!.generation });
    // 中继触发 gw2 泵 → 目标即时收到 delivery(不传 payload:请求体只有 to/generation,由 spy 断言)
    expect(await waitFor(() => tp.frames.some((f) => f.frame === 'delivery'))).toBe(true);
  });

  it('fence 守卫:非现主 / 陈旧 generation → pumped:false,不泵', async () => {
    const shared = openShared();
    const gw2 = await mkGateway(shared, 'gw2');
    const gw1 = await mkGateway(shared, 'gw1');
    await peer(gw2.gw, gw2.port, target);
    const real = shared.claims.lookup(target.node_id)!.generation;

    expect((await post(gw2.port, { to_node_id: target.node_id, generation: real })).json.pumped).toBe(true);
    expect((await post(gw2.port, { to_node_id: target.node_id, generation: real + 1 })).json.pumped).toBe(false);
    // 非 current claim 的 authority('gw1' 从未认领 target)持真实 generation 数值也不得泵
    expect((await post(gw1.port, { to_node_id: target.node_id, generation: real })).json.pumped).toBe(false);
  });

  it('离线(无 claim)→ 不通知;目标后来连上 → 认证补投送达(正确性不依赖通知)', async () => {
    const shared = openShared();
    const gw2 = await mkGateway(shared, 'gw2');
    const spy = await spyRelay();
    const gw1 = await mkGateway(shared, 'gw1', [spy.url, `http://127.0.0.1:${gw2.port}`]);

    const sp = await peer(gw1.gw, gw1.port, source);
    sp.send(makeEnvelope());
    await sp.stored();
    await waitFor(() => shared.custody.pending(target.node_id, Date.now(), 16).length > 0);
    await new Promise((r) => setTimeout(r, 200));
    expect(spy.requests.length).toBe(0);                // 无 claim → 不通知

    const tp = await peer(gw2.gw, gw2.port, target);    // 目标上线 → 认证即补投
    expect(await waitFor(() => tp.frames.some((f) => f.frame === 'delivery'))).toBe(true);
  });

  it('中继端点鉴权与畸形请求:错密钥 403 / 缺字段 400 / 非法 generation 400', async () => {
    const shared = openShared();
    const gw = await mkGateway(shared, 'gw1');
    expect((await post(gw.port, { to_node_id: target.node_id, generation: 1 }, 'wrong')).status).toBe(403);
    expect((await post(gw.port, { to_node_id: target.node_id, generation: 1 }, '')).status).toBe(403); // 空串 → 不带头
    expect((await post(gw.port, {})).status).toBe(400);
    expect((await post(gw.port, { to_node_id: target.node_id, generation: 0 })).status).toBe(400);
    expect((await post(gw.port, { to_node_id: 'not-a-uuid', generation: 1 })).status).toBe(400);
    expect(await spyRelayHit(gw.port)).toBe(426);       // 非 POST 落默认 426
  });

  it('peer 不可达不影响 stored(通知 best-effort;彼方周期泵兜底交付)', async () => {
    const shared = openShared();
    const gw2 = await mkGateway(shared, 'gw2');
    const gw1 = await mkGateway(shared, 'gw1', ['http://127.0.0.1:1']); // 关闭端口:notify 吞错

    const tp = await peer(gw2.gw, gw2.port, target);
    const sp = await peer(gw1.gw, gw1.port, source);
    sp.send(makeEnvelope());
    await sp.stored();                                  // 通知失败不阻断回执
    // peer 不可达 → 无即时泵;gw2 周期 sweep(≤100ms)兜底送达 —— 正确性锚点
    expect(await waitFor(() => tp.frames.some((f) => f.frame === 'delivery'), 3_000)).toBe(true);
  });
});

async function spyRelayHit(port: number): Promise<number> {
  return fetch(`http://127.0.0.1:${port}/internal/pump`, { method: 'GET' }).then((r) => r.status);
}
