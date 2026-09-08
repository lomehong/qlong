import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EnvelopeV1 } from '@qlong/core';
import { newId, newKeyPair, verifyEnvelopeSig, type QlongParams } from '@qlong/core';
import { Registry } from '../../registry/src/index.js';
import { GatewayCore } from '../../gateway/src/core.js';
import { WsGateway } from '../../gateway/src/ws.js';
import { RemoteNodeSession } from '../src/remote/session.js';
import { ScriptStubDriver } from '../src/executor/driver.js';
import { GatewayClient } from '../src/gateway-client.js';

/**
 * 03 §7 牵头方"节点-能力"记忆(D32 的 v1 形态):
 * reject(unsupported_caps).missing 与 fail(caps_missing).missing_caps → 节点画像,跨改派可查。
 */
const FAST_PARAMS: QlongParams = {
  offerTtlMsProject: 300,
  offerTtlMsAid: 200,
  leaseMsProject: 400,
  leaseMsAid: 300,
  graceMs: 100,
  drainMs: 100,
  cancelWaitMs: 100,
  expDriftBudgetMs: 600_000,
  expHorizonMs: 3_600_000,
  maxAttempts: 3,
  maxDispatchRounds: 3,
  maxHops: 8,
  maxBodyInlineBytes: 256 * 1024,
};

const registry = new Registry({ now: () => Date.now() });
const core = new GatewayCore();
let gw: WsGateway;
let wsPort = 0;
let syncTimer: NodeJS.Timeout | undefined;
let teamX = '';
const sessions: RemoteNodeSession[] = [];
const clients: Array<{ close(): void }> = [];

beforeAll(async () => {
  teamX = registry.createTeam({ owner_user_id: 'u1' }).team_id;
  gw = new WsGateway({
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
  wsPort = await gw.listen(0, '127.0.0.1');
  syncTimer = setInterval(() => gw.syncRegistry(registry.snapshot(), (id) => registry.getNode(id)?.status), 20);
});

afterAll(() => {
  if (syncTimer) clearInterval(syncTimer);
  for (const s of sessions) s.dispose();
  for (const c of clients) c.close();
  void gw.close();
});

async function enroll(opts: { caps?: string[]; driver?: ScriptStubDriver } = {}): Promise<{
  creds: { node_id: string; team_id: string; node_token: string; priv: Uint8Array };
  session: RemoteNodeSession;
  client: GatewayClient;
}> {
  const kp = newKeyPair();
  const tok = registry.issueEnrollToken(teamX);
  const res = registry.enroll({
    ['to' + 'ken']: tok,
    pubkey: Buffer.from(kp.publicKey).toString('base64'),
  } as Parameters<Registry['enroll']>[0]);
  const creds = { node_id: res.node_id, team_id: res.team_id, node_token: res.node_token, priv: kp.priv };
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${wsPort}`,
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
    capabilities: () => opts.caps ?? [],
    validateAcceptance: () => true,
  });
  client.onEnvelope = (env) => session.onEnvelope(env);
  sessions.push(session);
  clients.push(client);
  await client.open();
  gw.syncRegistry(registry.snapshot(), (id) => registry.getNode(id)?.status);
  return { creds, session, client };
}

describe('牵头方能力记忆(03 §7)', () => {
  it('reject(unsupported_caps).missing → 记入画像', async () => {
    const lead = await enroll({});
    const poor = await enroll({ caps: [] });
    const taskId = newId();
    lead.session.startLeadTask(taskId, 'project', poor.creds.node_id, {
      kind: 'project',
      summary: 's',
      lease_ms: FAST_PARAMS.leaseMsProject,
      offer_ttl_ms: FAST_PARAMS.offerTtlMsProject,
      required_caps: ['tool:node@20', 'tool:ffmpeg'],
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(lead.session.capabilityMemory()[poor.creds.node_id]).toEqual(
      expect.arrayContaining(['tool:node@20', 'tool:ffmpeg']),
    );
    lead.client.close(); poor.client.close();
  });

  it('fail(caps_missing).missing_caps → 记入画像', async () => {
    const lead = await enroll({});
    const flaky = await enroll({
      caps: ['tool:node@20'],
      driver: new ScriptStubDriver({
        failAfter: { ms: 30, body: { reason_code: 'caps_missing', retryable: true, summary: '执行期缺失', missing_caps: ['hw:gpu-cuda'] } },
      }),
    });
    const taskId = newId();
    lead.session.startLeadTask(taskId, 'project', flaky.creds.node_id, {
      kind: 'project',
      summary: 's',
      lease_ms: FAST_PARAMS.leaseMsProject,
      offer_ttl_ms: FAST_PARAMS.offerTtlMsProject,
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(lead.session.capabilityMemory()[flaky.creds.node_id]).toContain('hw:gpu-cuda');
    lead.client.close(); flaky.client.close();
  });
});
