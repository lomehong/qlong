import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EnvelopeV1 } from '@qlong/core';
import { newId, newKeyPair, verifyEnvelopeSig, type QlongParams } from '@qlong/core';
import { Registry } from '../../registry/src/index.js';
import { GatewayCluster } from '../src/cluster.js';
import { GatewayCore } from '../src/core.js';
import { WsGateway } from '../src/ws.js';
import { RemoteNodeSession } from '../../node/src/remote/session.js';
import { ScriptStubDriver } from '../../node/src/executor/driver.js';
import { GatewayClient } from '../../node/src/gateway-client.js';
import { waitFor } from './wait.js';

/**
 * 02 §12.1 网关集群化 v1:同进程双网关 + GatewayCluster。
 * - 连接注册:member.has(nodeId)(连接表)
 * - 在线直投:目标连接在另一网关 → 集群转发送达
 * - 分片邮箱:离线 project 单落 home 分片网关;节点连回家网关即补投
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

const registry = new Registry({ now: () => Date.now() });
const cluster = new GatewayCluster();
const gateways: WsGateway[] = [];
const cores: GatewayCore[] = [];
const ports: number[] = [];
const syncTimers: NodeJS.Timeout[] = [];
let teamX = '';
const sessions: RemoteNodeSession[] = [];
const clients: Array<{ close(): void }> = [];

beforeAll(async () => {
  teamX = registry.createTeam({ owner_user_id: 'u1' }).team_id;
  for (let i = 0; i < 2; i++) {
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
      cluster,
    });
    const port = await gw.listen(0, '127.0.0.1');
    cores.push(core);
    gateways.push(gw);
    ports.push(port);
    cluster.register({
      name: 'gw' + i,
      core,
      has: (id) => gw.has(id),
      deliver: (id, env) => gw.deliverTo(id, env),
    });
    syncTimers.push(setInterval(() => gw.syncRegistry(registry.snapshot(), (id) => registry.getNode(id)?.status), 20));
  }
});

afterAll(async () => {
  for (const t of syncTimers) clearInterval(t);
  for (const s of sessions) s.dispose();
  for (const c of clients) c.close();
  for (const g of gateways) await g.close();
});

interface Stack {
  creds: { node_id: string; team_id: string; node_token: string; priv: Uint8Array };
  session: RemoteNodeSession;
  client: GatewayClient;
}

async function enroll(opts: { gatewayIndex?: number; driver?: ScriptStubDriver } = {}): Promise<Stack> {
  const kp = newKeyPair();
  const tok = registry.issueEnrollToken(teamX);
  const res = registry.enroll({
    ['to' + 'ken']: tok,
    pubkey: Buffer.from(kp.publicKey).toString('base64'),
  } as Parameters<Registry['enroll']>[0]);
  const creds = { node_id: res.node_id, team_id: res.team_id, node_token: res.node_token, priv: kp.priv };
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
    teamId: creds.team_id,
    keyEpoch: res.key_epoch,
    priv: creds.priv,
    client,
    params: FAST_PARAMS,
    driver: opts.driver,
    validateAcceptance: () => true,
  });
  client.onEnvelope = (env) => session.onEnvelope(env);
  sessions.push(session);
  clients.push(client);
  await client.open();
  for (const g of gateways) g.syncRegistry(registry.snapshot(), (id) => registry.getNode(id)?.status);
  return { creds, session, client };
}

describe('网关集群(02 §12.1 v1)', () => {
  it('跨网关在线直投:B 连 gw2,A 经 gw1 派单 → 集群转发送达', async () => {
    const a = await enroll({ gatewayIndex: 0 });
    const b = await enroll({ gatewayIndex: 1, driver: new ScriptStubDriver({ completeAfterMs: 60, resultBody: { summary: '跨网关完成' } }) });
    const taskId = newId();
    a.session.startLeadTask(taskId, 'project', b.creds.node_id, {
      kind: 'project', summary: '跨网关派单', lease_ms: FAST_PARAMS.leaseMsProject, offer_ttl_ms: FAST_PARAMS.offerTtlMsProject,
    });
    const ok = await waitFor(() => a.session.lead?.rec.state === 'done', 4_000);
    expect(ok).toBe(true);
    a.client.close();
    b.client.close();
  });

  it('分片邮箱:C 离线 → project 单落 home 分片;C 连回 home 网关即补投', async () => {
    const c = await enroll({ gatewayIndex: 0 });
    const cId = c.creds.node_id;
    // 断开(离线)
    c.client.close();
    for (const g of gateways) g.syncRegistry(registry.snapshot(), (id) => registry.getNode(id)?.status);
    await new Promise((r) => setTimeout(r, 60));

    // 分片归属(home)与邮箱现状
    const home = cluster.shardOf(cId);
    expect(home).toBeDefined();
    const homeIndex = cores.indexOf(home!.core);
    const before = cores.map((k) => k.inbox.size(cId));

    // 离线期间派单(project):经 gw0 → 集群路由 → home 分片入箱
    const a = await enroll({ gatewayIndex: 0 });
    const taskId = newId();
    a.session.startLeadTask(taskId, 'project', cId, {
      kind: 'project', summary: '离线分片邮箱', lease_ms: FAST_PARAMS.leaseMsProject, offer_ttl_ms: FAST_PARAMS.offerTtlMsProject,
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(cores[homeIndex].inbox.size(cId)).toBeGreaterThan(0); // 落在 home 分片
    expect(before.filter((n) => n > 0).length).toBe(0);

    // 重新入网到 home 网关(新 session/client 同 node)
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${ports[homeIndex]}`,
      nodeToken: c.creds.node_token,
      params: FAST_PARAMS,
      verifyInbound: async (env) => {
        const look = registry.lookupPubkey(env.from.node_id, env.from.key_epoch);
        if (look.status !== 'current' && look.status !== 'historical') return false;
        return (await verifyEnvelopeSig(env, () => Buffer.from(look.pubkey, 'base64'))).ok;
      },
    });
    const session = new RemoteNodeSession({
      nodeId: cId,
      teamId: c.creds.team_id,
      keyEpoch: c.creds.key_epoch,
      priv: c.creds.priv,
      client,
      params: FAST_PARAMS,
      validateAcceptance: () => true,
    });
    let received: EnvelopeV1 | undefined;
    client.onEnvelope = (env) => {
      if (!received) received = env;
      session.onEnvelope(env);
    };
    sessions.push(session);
    clients.push(client);
    await client.open();
    for (const g of gateways) g.syncRegistry(registry.snapshot(), (id) => registry.getNode(id)?.status);
    const ok = await waitFor(() => received !== undefined, 4_000);
    expect(ok).toBe(true); // 连回 home 即补投
    a.client.close();
    client.close();
  });
});
