import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EnvelopeV1 } from '@qlong/core';
import { newId, newKeyPair, verifyEnvelopeSig, type QlongParams } from '@qlong/core';
import { Registry } from '@qlong/registry';
import { GatewayCore } from '../src/core.js';
import { WsGateway } from '../src/ws.js';
import { waitFor } from './wait.js';
import { RemoteNodeSession } from '../../node/src/remote/session.js';
import { ScriptStubDriver } from '../../node/src/executor/driver.js';

const TASK = '66666666-6666-4666-8666-666666666666';

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
const received = new Map<string, EnvelopeV1[]>();

beforeAll(async () => {
  const t = registry.createTeam({ owner_user_id: 'u1' });
  teamX = t.team_id;
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
  gw.syncRegistry(registry.snapshot(), (id) => registry.getNode(id)?.status);
});

afterAll(() => {
  if (syncTimer) clearInterval(syncTimer);
  for (const s of sessions) s.dispose();
  for (const c of clients) c.close();
  void gw.close();
});

interface Stack {
  creds: { node_id: string; team_id: string; node_token: string; priv: Uint8Array };
  session: RemoteNodeSession;
  client: { close(): void };
}

async function enroll(opts: {
  caps?: string[];
  driver?: ScriptStubDriver;
  confirmHandler?: (req: { cls: string; value: string; reason: string }, offer: Record<string, unknown>) => boolean;
} = {}): Promise<Stack> {
  const kp = newKeyPair();
  const tok = registry.issueEnrollToken(teamX);
  const res = registry.enroll({
    ['to' + 'ken']: tok,
    pubkey: Buffer.from(kp.publicKey).toString('base64'),
  } as Parameters<Registry['enroll']>[0]);
  const creds = { node_id: res.node_id, team_id: res.team_id, node_token: res.node_token, priv: kp.priv };
  const client = new (await import('../../node/src/gateway-client.js')).GatewayClient({
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
    confirmHandler: opts.confirmHandler,
    validateAcceptance: () => true,
  });
  client.onEnvelope = (env) => {
    const list = received.get(env.to.node_id) ?? [];
    list.push(env);
    received.set(env.to.node_id, list);
    session.onEnvelope(env);
  };
  sessions.push(session);
  clients.push(client);
  await client.open();
  gw.syncRegistry(registry.snapshot(), (id) => registry.getNode(id)?.status);
  return { creds, session, client };
}

function offerBody(summary: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'project', summary, lease_ms: FAST_PARAMS.leaseMsProject, offer_ttl_ms: FAST_PARAMS.offerTtlMsProject, ...extra };
}

describe('M4:能力感知派单与执行档案(A6/A7)', () => {
  it('W6/A6:required_caps 不满足 → reject(unsupported_caps)+missing → 改派有标签节点 → done', async () => {
    const lead = await enroll({}); // A 牵头(无标签也行,不参与闸)
    const poor = await enroll({ caps: [] }); // C:无 tool:node
    const rich = await enroll({ caps: ['tool:node@20'], driver: new ScriptStubDriver({ completeAfterMs: 50, resultBody: { summary: 'rich 完成' } }) }); // B:有
    const taskId = newId();
    lead.session.opts.pickTarget = (tid, nextAttempt, excluded) => {
      void tid;
      void nextAttempt;
      return excluded[poor.creds.node_id] !== undefined ? rich.creds.node_id : poor.creds.node_id;
    };
    lead.session.startLeadTask(taskId, 'project', poor.creds.node_id, offerBody('需要 node@20', { required_caps: ['tool:node@20'] }));
    const w6ok = await waitFor(() => lead.session.lead?.rec.state === 'done', 3_000);
    if (!w6ok) {
      console.log('DIAG state:', lead.session.lead?.rec.state);
      console.log('DIAG history:', JSON.stringify(lead.session.lead?.rec.history));
      console.log('DIAG excluded:', JSON.stringify(lead.session.lead?.rec.excluded));
      console.log('DIAG A.received:', JSON.stringify(received.get(lead.creds.node_id)?.map((e) => ({ t: e.type, b: e.body }))));
    }
    expect(w6ok).toBe(true);
    expect(lead.session.lead?.rec.attempt).toBe(2);
    expect(lead.session.lead?.rec.history.some((h) => h.outcome === 'rejected' && h.reason_code === 'unsupported_caps')).toBe(true);
    expect(poor.session.exec.rec.state).toBe('rejected');
    expect(rich.session.exec.rec.state).toBe('result_sent');
    // missing 明细回流(A 侧收到的 reject)
    const rej = received.get(lead.creds.node_id)?.find((e) => e.type === 'task.reject');
    expect((rej?.body as { missing?: string[] }).missing).toEqual(['tool:node@20']);
    lead.client.close(); poor.client.close(); rich.client.close();
  });

  it('caps_missing 反馈:执行期缺能力 fail → 改派 → done(attempt=2)', async () => {
    const lead = await enroll({});
    const flaky = await enroll({ caps: ['tool:node@20'], driver: new ScriptStubDriver({ failAfter: { ms: 30, body: { reason_code: 'caps_missing', retryable: true, summary: '执行期发现缺失' } } }) });
    const solid = await enroll({ caps: ['tool:node@20'], driver: new ScriptStubDriver({ completeAfterMs: 50, resultBody: { summary: 'solid 完成' } }) });
    const taskId = newId();
    lead.session.opts.pickTarget = (tid, nextAttempt, excluded) => {
      void tid; void nextAttempt; void excluded;
      return nextAttempt <= 1 ? flaky.creds.node_id : solid.creds.node_id;
    };
    lead.session.startLeadTask(taskId, 'project', flaky.creds.node_id, offerBody('caps_missing 反馈'));
    expect(await waitFor(() => lead.session.lead?.rec.state === 'done', 3_000)).toBe(true);
    expect(lead.session.lead?.rec.attempt).toBe(2);
    expect(lead.session.lead?.rec.history.some((h) => h.outcome === 'fail_retryable' && h.reason_code === 'caps_missing')).toBe(true);
  });

  it('闸5 三态:无确认通道 → 拒;确认 true → 接单;确认 false → 拒', async () => {
    // 三态 a:无通道
    const noChan = await enroll({ caps: [] });
    const offer = offerBody('需要确认', { requires: [{ cls: 'confirm', value: 'ssh-key', reason: '需要读取部署密钥' }] });
    noChan.session.onEnvelope({
      v: 1, type: 'task.offer', msg_id: newId(), ts: new Date().toISOString(),
      exp: new Date(Date.now() + 60_000).toISOString(),
      from: { node_id: newId(), team_id: teamX, key_epoch: 1 },
      to: { node_id: noChan.creds.node_id, team_id: teamX },
      trace: { trace_id: newId(), parent_span: null, origin_node: newId() },
      hops: 0, task_id: newId(), attempt: 1,
      sig: { alg: 'ed25519', value: 'x' },
      body: offer,
    } as EnvelopeV1);
    expect(noChan.session.exec.rec.state).toBe('rejected');
    // 三态 b:确认 true → 接单
    const yes = await enroll({ caps: [], confirmHandler: () => true });
    yes.session.onEnvelope({
      v: 1, type: 'task.offer', msg_id: newId(), ts: new Date().toISOString(),
      exp: new Date(Date.now() + 60_000).toISOString(),
      from: { node_id: newId(), team_id: teamX, key_epoch: 1 },
      to: { node_id: yes.creds.node_id, team_id: teamX },
      trace: { trace_id: newId(), parent_span: null, origin_node: newId() },
      hops: 0, task_id: newId(), attempt: 1,
      sig: { alg: 'ed25519', value: 'x' },
      body: { kind: 'aid', summary: 's', lease_ms: 1000, offer_ttl_ms: 1000, requires: [{ cls: 'confirm', value: 'x', reason: 'r' }] },
    } as EnvelopeV1);
    expect(yes.session.exec.rec.state).toBe('running');
    // 三态 c:确认 false → policy_denied
    const no2 = await enroll({ caps: [], confirmHandler: () => false });
    no2.session.onEnvelope({
      v: 1, type: 'task.offer', msg_id: newId(), ts: new Date().toISOString(),
      exp: new Date(Date.now() + 60_000).toISOString(),
      from: { node_id: newId(), team_id: teamX, key_epoch: 1 },
      to: { node_id: no2.creds.node_id, team_id: teamX },
      trace: { trace_id: newId(), parent_span: null, origin_node: newId() },
      hops: 0, task_id: newId(), attempt: 1,
      sig: { alg: 'ed25519', value: 'x' },
      body: { kind: 'aid', summary: 's', lease_ms: 1000, offer_ttl_ms: 1000, requires: [{ cls: 'confirm', value: 'x', reason: 'r' }] },
    } as EnvelopeV1);
    expect(no2.session.exec.rec.state).toBe('rejected');
  });
});