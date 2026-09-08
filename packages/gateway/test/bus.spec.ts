import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { EnvelopeV1 } from '@qlong/core';
import { newId, newKeyPair, verifyEnvelopeSig, type QlongParams } from '@qlong/core';
import { Registry } from '../../registry/src/index.js';
import { GatewayCluster } from '../src/cluster.js';
import { GatewayCore } from '../src/core.js';
import { WsGateway } from '../src/ws.js';
import { HttpClusterBus } from '../src/bus.js';
import { RemoteNodeSession } from '../../node/src/remote/session.js';
import { ScriptStubDriver } from '../../node/src/executor/driver.js';
import { GatewayClient } from '../../node/src/gateway-client.js';
import { waitFor } from './wait.js';

/**
 * v0.8 网关跨进程总线(02 §12.1 可替换传输):HTTP 中继端到端。
 * 两个独立 WsGateway 实例(模拟双进程/双机),registry 共享(部署常态):
 * - A 连 gw1,B 连 gw2:A 派单给 B → gw1 本地 miss → HttpClusterBus POST gw2
 *   /internal/envelope → gw2 internalDeliver 直投在线 B → 任务完成;
 * - 离线 project:C 未连接 → 总线转投 gw2 入彼收件箱 → C 连 gw2 即补投;
 * - 密钥错误:403 → publish false → gw1 本地兜底入箱 → C 连 gw1 即补投。
 */
const FAST_PARAMS: QlongParams = {
  offerTtlMsProject: 2_000,
  offerTtlMsAid: 2_000,
  leaseMsProject: 5_000,
  leaseMsAid: 5_000,
  graceMs: 300,
  drainMs: 200,
  cancelWaitMs: 200,
  expDriftBudgetMs: 600_000,
  expHorizonMs: 3_600_000,
  maxAttempts: 3,
  maxDispatchRounds: 3,
  maxHops: 8,
  maxBodyInlineBytes: 256 * 1024,
};

const SECRET = 'bus-test-secret';
const registry = new Registry({ now: () => Date.now() });
const gateways: WsGateway[] = [];
const ports: number[] = [];
const syncTimers: NodeJS.Timeout[] = [];
let teamX = '';
const sessions: RemoteNodeSession[] = [];
const clients: Array<{ close(): void }> = [];

function makeGateway(opts: { secret?: string; peerUrls?: string[] }): { port: Promise<number>; cluster: GatewayCluster } {
  const core = new GatewayCore();
  const cluster = new GatewayCluster();
  if (opts.peerUrls && opts.peerUrls.length > 0) {
    cluster.attachBus(new HttpClusterBus({ secret: opts.secret ?? SECRET, peers: opts.peerUrls.map((url, i) => ({ name: 'p' + i, url })) }));
  }
  const gw = new WsGateway({
    core,
    cluster,
    clusterSecret: opts.secret,
    authenticate: (tok: string) => {
      try {
        const n = registry.authByToken(tok);
        return { node_id: n.node_id, team_id: n.team_id, status: n.status };
      } catch {
        return undefined;
      }
    },
  });
  cluster.register({
    name: 'self',
    core,
    has: (id) => gw.has(id),
    deliver: (id, env) => gw.deliverTo(id, env),
  });
  const port = gw.listen(0, '127.0.0.1').then((p) => {
    gateways.push(gw);
    ports.push(p);
    syncTimers.push(setInterval(() => gw.syncRegistry(registry.snapshot(), (id) => registry.getNode(id)?.status), 20));
    return p;
  });
  return { port, cluster };
}

const clusters: GatewayCluster[] = [];

beforeAll(async () => {
  teamX = registry.createTeam({ owner_user_id: 'u1' }).team_id;
  // gw0 + gw1:两个独立实例(模拟双进程);总线 peer 端口就绪后在用例内挂载
  const g0 = makeGateway({ secret: SECRET });
  const g1 = makeGateway({ secret: SECRET });
  clusters.push(g0.cluster, g1.cluster);
  await g0.port;
  await g1.port;
});

afterAll(async () => {
  for (const t of syncTimers) clearInterval(t);
  for (const s of sessions) s.dispose();
  for (const c of clients) c.close();
  for (const g of gateways) await g.close();
});

interface Stack {
  creds: { node_id: string; node_token: string };
  session: RemoteNodeSession;
  client: GatewayClient;
  received: EnvelopeV1[];
}

async function enroll(opts: { gatewayIndex?: number; connect?: boolean; driver?: ScriptStubDriver; sink?: EnvelopeV1[] } = {}): Promise<Stack> {
  const kp = newKeyPair();
  const tok = registry.issueEnrollToken(teamX);
  const res = registry.enroll({
    ['to' + 'ken']: tok,
    pubkey: Buffer.from(kp.publicKey).toString('base64'),
  } as Parameters<Registry['enroll']>[0]);
  const creds = { node_id: res.node_id, node_token: res.node_token };
  const gi = opts.gatewayIndex ?? 0;
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${ports[gi]}`,
    nodeToken: creds.node_token,
    params: FAST_PARAMS,
    verifyInbound: async (env) => {
      const look = registry.lookupPubkey(env.from.node_id, env.from.key_epoch);
      if (look.status !== 'current' && look.status !== 'historical') return false;
      return (await verifyEnvelopeSig(env, () => Buffer.from(look.pubkey, 'base64'))).ok;
    },
  });
  const session = new RemoteNodeSession({
    nodeId: creds.node_id,
    teamId: res.team_id,
    keyEpoch: res.key_epoch,
    priv: kp.priv,
    client,
    params: FAST_PARAMS,
    driver: opts.driver,
    validateAcceptance: () => true,
  });
  const received = opts.sink ?? [];
  client.onEnvelope = (env) => {
    received.push(env);
    session.onEnvelope(env);
  };
  sessions.push(session);
  clients.push(client);
  if (opts.connect !== false) await client.open();
  for (const g of gateways) g.syncRegistry(registry.snapshot(), (id) => registry.getNode(id)?.status);
  return { creds, session, client, received };
}

describe('网关跨进程总线(v0.8 HTTP 中继)', () => {
  /** 结构合法的最小信封(中继端点过 validateEnvelope;msg 族无 task 必填位) */
  const mkEnv = (to: string, kind: 'aid' | 'project' = 'aid'): EnvelopeV1 =>
    ({
      v: 1,
      type: 'msg.notify',
      msg_id: randomUUID(),
      ts: new Date().toISOString(),
      from: { node_id: randomUUID(), key_epoch: 1 },
      to: { node_id: to, key_epoch: 1 },
      trace: { trace_id: randomUUID(), parent_span: null, origin_node: randomUUID() },
      body: { kind },
    }) as unknown as EnvelopeV1;

  it('总线端点鉴权:错密钥 403,畸形信封 400,合法信封按连接态回 delivered/queued/not_here', async () => {
    const url = `http://127.0.0.1:${ports[1]}/internal/envelope`;
    const post = (secret: string | undefined, payload: unknown): Promise<Response> =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(secret ? { 'x-qlong-cluster-secret': secret } : {}) },
        body: JSON.stringify(payload),
      });
    expect((await post('wrong', { to_node_id: 'n_x', envelope: mkEnv('n_x') })).status).toBe(403);
    expect((await post(undefined, { to_node_id: 'n_x', envelope: mkEnv('n_x') })).status).toBe(403);
    expect((await post(SECRET, { to_node_id: 'n_x' })).status).toBe(400); // 缺 envelope
    expect((await post(SECRET, { to_node_id: 'n_x', envelope: { msg_id: 'm1' } })).status).toBe(400); // 畸形信封
    const absent = randomUUID();
    const r = await post(SECRET, { to_node_id: absent, envelope: mkEnv(absent, 'project') });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { result: string }).result).toBe('queued'); // project 离线 → 彼收件箱
    const aidTo = randomUUID();
    const r2 = await post(SECRET, { to_node_id: aidTo, envelope: mkEnv(aidTo, 'aid') });
    expect(((await r2.json()) as { result: string }).result).toBe('not_here'); // aid 不暂存
  });

  it('跨进程在线直投:A@gw1 派单 B@gw2 → 经总线转投 → 任务完成', async () => {
    // 双向总线(部署常态:全互连 peering):回执/结果信封同样跨网关回流
    clusters[0]!.attachBus(new HttpClusterBus({ secret: SECRET, peers: [{ name: 'gw1', url: `http://127.0.0.1:${ports[1]}` }] }));
    clusters[1]!.attachBus(new HttpClusterBus({ secret: SECRET, peers: [{ name: 'gw0', url: `http://127.0.0.1:${ports[0]}` }] }));

    const a = await enroll({ gatewayIndex: 0 });
    const b = await enroll({ gatewayIndex: 1, driver: new ScriptStubDriver({ completeAfterMs: 60, resultBody: { summary: '总线跨进程完成' } }) });
    const taskId = newId();
    a.session.startLeadTask(taskId, 'project', b.creds.node_id, {
      kind: 'project', summary: '总线跨进程派单', lease_ms: FAST_PARAMS.leaseMsProject, offer_ttl_ms: FAST_PARAMS.offerTtlMsProject,
    });
    const ok = await waitFor(() => a.session.lead?.rec.state === 'done', 5_000);
    expect(ok).toBe(true);
    expect(b.received.length).toBeGreaterThan(0);
    a.client.close();
    b.client.close();
  });

  it('离线 project 经总线落彼收件箱:C 连上 gw2 即补投', async () => {
    clusters[0]!.attachBus(new HttpClusterBus({ secret: SECRET, peers: [{ name: 'gw1', url: `http://127.0.0.1:${ports[1]}` }] }));

    const a = await enroll({ gatewayIndex: 0 });
    const sink: EnvelopeV1[] = [];
    const c = await enroll({ gatewayIndex: 1, connect: false, sink }); // 已入网、未连接
    a.session.startLeadTask(newId(), 'project', c.creds.node_id, {
      kind: 'project', summary: '离线跨进程落箱', lease_ms: FAST_PARAMS.leaseMsProject, offer_ttl_ms: FAST_PARAMS.offerTtlMsProject,
    });
    await waitFor(() => a.session.lead !== undefined, 1_000);
    // offer 落在 gw2 收件箱(经总线);C 连 gw2 → 认证即补投
    await c.client.open();
    for (const g of gateways) g.syncRegistry(registry.snapshot(), (id) => registry.getNode(id)?.status);
    const got = await waitFor(() => sink.some((e) => e.body.kind === 'project'), 4_000);
    expect(got).toBe(true);
    a.client.close();
    c.client.close();
  });

  it('总线不可达(错密钥 → false)→ 本地兜底入箱:C 连 gw1 补投', async () => {
    clusters[0]!.attachBus(new HttpClusterBus({ secret: 'mismatch', peers: [{ name: 'gw1', url: `http://127.0.0.1:${ports[1]}` }] }));

    const a = await enroll({ gatewayIndex: 0 });
    const sink: EnvelopeV1[] = [];
    const c = await enroll({ gatewayIndex: 0, connect: false, sink });
    a.session.startLeadTask(newId(), 'project', c.creds.node_id, {
      kind: 'project', summary: '兜底入箱', lease_ms: FAST_PARAMS.leaseMsProject, offer_ttl_ms: FAST_PARAMS.offerTtlMsProject,
    });
    await waitFor(() => a.session.lead !== undefined, 1_000);
    await c.client.open();
    for (const g of gateways) g.syncRegistry(registry.snapshot(), (id) => registry.getNode(id)?.status);
    const got = await waitFor(() => sink.some((e) => e.body.kind === 'project'), 4_000);
    expect(got).toBe(true);
    a.client.close();
    c.client.close();
  });
});
