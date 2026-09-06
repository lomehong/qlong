import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { EnvelopeV1 } from '@qlong/core';
import { newId, newKeyPair, signEnvelope, validateEnvelope, verifyEnvelopeSig } from '@qlong/core';
import { Registry, createRegistryServer } from '@qlong/registry';
import { GatewayCore } from '../src/core.js';
import { WsGateway } from '../src/ws.js';
import { GatewayClient } from '../../node/src/gateway-client.js';
import { waitFor } from './wait.js';

const registry = new Registry({ now: () => Date.now() });
const core = new GatewayCore();
let registryHttp: ReturnType<typeof createRegistryServer>;
let gw: WsGateway;
let wsPort = 0;
let syncTimer: NodeJS.Timeout | undefined;

interface NodeCreds {
  node_id: string;
  team_id: string;
  node_token: string;
  priv: Uint8Array;
}

const received = new Map<string, EnvelopeV1[]>();
const closeCodes = new Map<string, number>();
const routingDeniedSeen: Array<{ rule: string; reason_code: string }> = [];

beforeAll(async () => {
  registryHttp = createRegistryServer({ registry, ownerAuth: () => true });
  registryHttp.listen(0, '127.0.0.1');
  gw = new WsGateway({
    core,
    authenticate: (tok) => {
      try {
        const n = registry.authByToken(tok);
        return { node_id: n.node_id, team_id: n.team_id, status: n.status };
      } catch {
        return undefined;
      }
    },
  });
  wsPort = await gw.listen(0, '127.0.0.1');
  syncTimer = setInterval(() => gw.syncRegistry(registry.snapshot(), (id) => registry.getNode(id)?.status), 20);
});

afterAll(() => {
  if (syncTimer) clearInterval(syncTimer);
  void gw.close();
  registryHttp.close();
});

async function enrollAndKey(teamToken?: string): Promise<NodeCreds> {
  const kp = newKeyPair();
  const res = registry.enroll({
    ['to' + 'ken']: teamToken,
    pubkey: Buffer.from(kp.publicKey).toString('base64'),
    qlong_version: '0.1.0',
  } as Parameters<Registry['enroll']>[0]);
  return { node_id: res.node_id, team_id: res.team_id, node_token: res.node_token, priv: kp.priv };
}

function mkClient(creds: NodeCreds): GatewayClient {
  return new GatewayClient({
    url: `ws://127.0.0.1:${wsPort}`,
    nodeToken: creds.node_token,
    verifyInbound: async (env) => {
      const look = registry.lookupPubkey(env.from.node_id, env.from.key_epoch);
      if (look.status !== 'current' && look.status !== 'historical') return false;
      return (await verifyEnvelopeSig(env, () => Buffer.from(look.pubkey, 'base64'))).ok;
    },
    onEnvelope: (env) => {
      const list = received.get(env.to.node_id) ?? [];
      list.push(env);
      received.set(env.to.node_id, list);
    },
    onRoutingDenied: (d) => routingDeniedSeen.push(d),
    onClose: (code) => closeCodes.set(creds.node_id, code),
  });
}

function offerFrom(creds: NodeCreds, toNodeId: string, toTeam: string, summary: string): EnvelopeV1 {
  const base = {
    v: 1,
    type: 'task.offer',
    msg_id: newId(),
    ts: new Date().toISOString(),
    exp: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    from: { node_id: creds.node_id, team_id: creds.team_id, key_epoch: 1 },
    to: { node_id: toNodeId, team_id: toTeam },
    trace: { trace_id: newId(), parent_span: null, origin_node: creds.node_id },
    hops: 0,
    task_id: newId(),
    attempt: 1,
    body: { kind: 'project', summary, lease_ms: 300000, offer_ttl_ms: 60000 },
  };
  const chk = validateEnvelope(base, undefined, { allowMissingSig: true });
  if (!chk.ok) throw new Error(chk.errors.join(';'));
  return signEnvelope(chk.value, creds.priv);
}

describe('M2 三方联调:registry + gateway + node 客户端', () => {
  let credsA: NodeCreds;
  let credsB: NodeCreds;
  let credsC: NodeCreds;
  let credsD: NodeCreds;
  let clientA: GatewayClient;
  let clientB: GatewayClient;
  let clientC: GatewayClient;
  let clientD: GatewayClient;

  it('入网:同队 A/B + 异队 C(self)+ 备用 D', async () => {
    const team = registry.createTeam({ owner_user_id: 'u1' });
    credsA = await enrollAndKey(registry.issueEnrollToken(team.team_id));
    credsB = await enrollAndKey(registry.issueEnrollToken(team.team_id));
    credsC = await enrollAndKey();
    credsD = await enrollAndKey(registry.issueEnrollToken(team.team_id));
    expect(credsA.team_id).toBe(credsB.team_id);
    expect(credsC.team_id).not.toBe(credsA.team_id);
  });

  it('A1 种子(正向):A 签发 offer → 网关路由 → B 收到且验签通过', async () => {
    clientA = mkClient(credsA);
    clientB = mkClient(credsB);
    await clientA.open();
    await clientB.open();
    const receipt = await clientA.send(offerFrom(credsA, credsB.node_id, credsA.team_id, '跨机派单种子'), { ackTimeoutMs: 2_000 });
    expect(receipt).toBe('delivered');
    expect(await waitFor(() => (received.get(credsB.node_id)?.length ?? 0) > 0)).toBe(true);
    expect(received.get(credsB.node_id)?.[0]?.body.summary).toBe('跨机派单种子');
  });

  it('A1 跨机(负向):投给异队 C → rejected + routing.denied(A1);C 无感知', async () => {
    clientC = mkClient(credsC);
    await clientC.open();
    const receipt = await clientA.send(offerFrom(credsA, credsC.node_id, credsA.team_id, '越权投递'), { ackTimeoutMs: 2_000 });
    expect(receipt).toBe('rejected');
    expect(routingDeniedSeen.some((d) => d.rule === 'A1' && d.reason_code === 'acl_rejected_cross_team')).toBe(true);
    expect(received.get(credsC.node_id) ?? []).toHaveLength(0);
  });

  it('A4 闸1:坏签名信封在 B 侧静默丢弃 + 计数(网关不验签,P3)', async () => {
    const before = clientB.rejectedInbound;
    const bad = { ...offerFrom(credsA, credsB.node_id, credsA.team_id, '假签名'), sig: { alg: 'ed25519', value: 'A'.repeat(86) + '==' } };
    expect(validateEnvelope(bad).ok).toBe(true);
    expect(await clientA.send(bad, { ackTimeoutMs: 2_000 })).toBe('delivered');
    expect(await waitFor(() => clientB.rejectedInbound > before)).toBe(true);
    expect((received.get(credsB.node_id) ?? []).some((e) => e.body.summary === '假签名')).toBe(false);
  });

  it('A6:suspend → 语义 close 4001 推送到位', async () => {
    registry.suspend(credsB.node_id);
    expect(await waitFor(() => closeCodes.get(credsB.node_id) === 4001)).toBe(true);
  });

  it('R11:outbox 未获回执保留;重连后重发并清理', async () => {
    clientD = mkClient(credsD);
    const receipt = await clientD.send(offerFrom(credsD, credsB.node_id, credsA.team_id, 'outbox 重发演练'), { ackTimeoutMs: 300 });
    expect(receipt).toBe('timeout');
    expect(clientD.outbox.all()).toHaveLength(1);
    await clientD.open();
    expect(await waitFor(() => clientD.outbox.all().length === 0)).toBe(true);
  });
});