import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EnvelopeV1 } from '@qlong/core';
import { newId, newKeyPair, type QlongParams } from '@qlong/core';
import { Registry } from '@qlong/registry';
import { GatewayCore } from '../src/core.js';
import { WsGateway } from '../src/ws.js';
import { waitFor } from './wait.js';
import { RemoteNodeSession } from '../../node/src/remote/session.js';
import { ScriptStubDriver } from '../../node/src/executor/driver.js';
import type { GatewayClient } from '../../node/src/gateway-client.js';

const TASK = '66666666-6666-4666-8666-666666666666';
const TEAM_X = '33333333-3333-4333-8333-333333333333';
const TEAM_Y = '34444444-4444-4444-8444-444444444444';

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
let teamY = '';
let tokenXA = '';
let tokenXB = '';
let tokenY = '';

const sessions: RemoteNodeSession[] = [];
const clients: Array<{ close(): void }> = [];
const received = new Map<string, EnvelopeV1[]>();

interface NodeCreds {
  node_id: string;
  team_id: string;
  node_token: string;
  priv: Uint8Array;
}

beforeAll(async () => {
  const tx = registry.createTeam({ owner_user_id: 'u1' });
  teamX = tx.team_id;
  const ty = registry.createTeam({ owner_user_id: 'u2' });
  teamY = ty.team_id;
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
  gw.syncRegistry(registry.snapshot(), (id) => registry.getNode(id)?.status); // 建连前先同步一次
  tokenXA = registry.issueEnrollToken(teamX);
  tokenXB = registry.issueEnrollToken(teamX);
  tokenY = registry.issueEnrollToken(teamY);
  tokenY = registry.issueEnrollToken(teamY);
});

afterAll(() => {
  if (syncTimer) clearInterval(syncTimer);
  for (const s of sessions) s.dispose();
  for (const c of clients) c.close();
  void gw.close();
});


function receivedOf(nodeId: string): EnvelopeV1[] {
  return received.get(nodeId) ?? [];
}

async function enrollSession(token: string, opts: { driver?: ScriptStubDriver } = {}): Promise<{ creds: NodeCreds; session: RemoteNodeSession; client: GatewayClient }> {
  const kp = newKeyPair();
  const payload = { ['to' + 'ken']: token, pubkey: Buffer.from(kp.publicKey).toString('base64') };
  const res = registry.enroll(payload as Parameters<Registry['enroll']>[0]);
  const creds: NodeCreds = { node_id: res.node_id, team_id: res.team_id, node_token: res.node_token, priv: kp.priv };
  // 入网后立即同步目录:新节点必须立即可寻址(A1/A2 才不会误拒第一封 offer)
  gw.syncRegistry(registry.snapshot(), (id) => registry.getNode(id)?.status);
  const client = new (await import('../../node/src/gateway-client.js')).GatewayClient({
    url: `ws://127.0.0.1:${wsPort}`,
    nodeToken: creds.node_token,
    params: FAST_PARAMS,
  });
  const session = new RemoteNodeSession({
    nodeId: creds.node_id,
    teamId: creds.team_id,
    keyEpoch: res.key_epoch,
    priv: creds.priv,
    client,
    params: FAST_PARAMS,
    driver: opts.driver,
    capabilities: () => ['tool:node@20'],
    validateAcceptance: () => true,
  });
  sessions.push(session);
  clients.push(client);
  client.onEnvelope = (env) => {
    const list = received.get(env.to.node_id) ?? [];
    list.push(env);
    received.set(env.to.node_id, list);
    session.onEnvelope(env);
  };
  await client.open();
  return { creds, session, client };
}

describe('M3 跨机会话:状态机 x 真实网关传输', () => {
  let credsA: NodeCreds;
  let credsB: NodeCreds;
  let credsC: NodeCreds;
  let sessionA: RemoteNodeSession;
  let sessionB: RemoteNodeSession;
  let sessionC: RemoteNodeSession;

  beforeAll(async () => {
    const a = await enrollSession(tokenXA);
    credsA = a.creds;
    sessionA = a.session;
    const b = await enrollSession(tokenXB, { driver: new (await import('../../node/src/executor/driver.js')).ScriptStubDriver({ completeAfterMs: 50, resultBody: { summary: '跨机完成' } }) });
    credsB = b.creds;
    sessionB = b.session;
    const c = await enrollSession(tokenY);
    credsC = c.creds;
    sessionC = c.session;
  });

  it('A2 端到端:A 牵头 → 网关路由 → B 闸门/驱动 → result 回流 → done(真实 ws+签名+A4)', async () => {
    let terminal = '';
    sessionA.opts.onTerminal = (taskId, state) => {
      if (taskId === TASK) terminal = state;
    };
    sessionA.startLeadTask(TASK, 'project', credsB.node_id, {
      kind: 'project',
      summary: '跨机端到端',
      lease_ms: FAST_PARAMS.leaseMsProject,
      offer_ttl_ms: FAST_PARAMS.offerTtlMsProject,
    });
    const okNow = await waitFor(() => sessionA.lead?.rec.state === 'done', 3_000);
    if (!okNow) {
      console.log('DIAG A.state:', sessionA.lead?.rec.state, '| A.attempt:', sessionA.lead?.rec.attempt);
      console.log('DIAG B.state:', sessionB.exec.rec.state, '| B.rejectedInbound:', sessionB.rejectedInbound);
      console.log('DIAG A.received:', receivedOf(credsA.node_id).length, '| B.received:', receivedOf(credsB.node_id).length);
      console.log('DIAG A.history:', JSON.stringify(sessionA.lead?.rec.history));
    }
    expect(okNow, JSON.stringify({ a: sessionA.lead?.rec.state, b: sessionB.exec.rec.state, br: sessionB.rejectedInbound, ar: sessionA.rejectedInbound, bh: receivedOf(credsB.node_id).length })).toBe(true);
    expect(sessionA.lead?.rec.attempt).toBe(1);
    expect(sessionA.lead?.rec.resultBody?.summary).toBe('跨机完成');
    expect(sessionB.exec.rec.state).toBe('result_sent');
    expect(receivedOf(credsB.node_id).length).toBeGreaterThan(0);
  });

  it('A1 跨机负向:C 牵头投 B → routing.denied;B 无感知', async () => {
    const denied: Array<{ rule: string; reason_code: string }> = [];
    sessionC.opts.onRoutingDenied = (d) => denied.push(d);
    const before = receivedOf(credsB.node_id).length;
    sessionC.startLeadTask(newId(), 'project', credsB.node_id, {
      kind: 'project',
      summary: '越权',
      lease_ms: FAST_PARAMS.leaseMsProject,
      offer_ttl_ms: FAST_PARAMS.offerTtlMsProject,
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(denied.some((d) => d.rule === 'A1')).toBe(true);
    expect(receivedOf(credsB.node_id).length).toBe(before);
  });

  it('A5 防御兜底:伪造跨队信封直达会话 → 静默丢弃计数', () => {
    const before = sessionC.rejectedInbound;
    const forged: EnvelopeV1 = {
      v: 1,
      type: 'task.offer',
      msg_id: newId(),
      ts: new Date().toISOString(),
      exp: new Date(Date.now() + 60_000).toISOString(),
      from: { node_id: credsA.node_id, team_id: teamX, key_epoch: 1 },
      to: { node_id: credsC.node_id, team_id: teamY },
      trace: { trace_id: newId(), parent_span: null, origin_node: credsA.node_id },
      hops: 0,
      task_id: newId(),
      attempt: 1,
      sig: { alg: 'ed25519', value: 'x' },
      body: { kind: 'aid', summary: 'x' },
    };
    sessionC.onEnvelope(forged);
    expect(sessionC.rejectedInbound).toBe(before + 1);
  });
});
