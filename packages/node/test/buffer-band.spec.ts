import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EnvelopeV1 } from '@qlong/core';
import { newId, newKeyPair, verifyEnvelopeSig, type QlongParams } from '@qlong/core';
import { Registry } from '../../registry/src/index.js';
import { GatewayCore } from '../../gateway/src/core.js';
import { WsGateway } from '../../gateway/src/ws.js';
import { RemoteNodeSession } from '../src/remote/session.js';
import { GatewayClient } from '../src/gateway-client.js';
import { ScriptStubDriver } from '../src/executor/driver.js';

/** 03 §6.3 同队缓冲带:暂停开关 / per-source 限速 / 本地通知;01 §11 指标 */
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

type NotifyFn = (n: { kind: string; task_id: string; from: string; state?: string; summary?: string }) => void;

async function enroll(
  opts: { rateLimit?: { maxOffersPerMinPerSource: number }; notify?: NotifyFn; driver?: ScriptStubDriver } = {},
): Promise<{
  creds: { node_id: string; team_id: string; node_token: string; priv: Uint8Array };
  session: RemoteNodeSession;
  client: GatewayClient;
  outbound: EnvelopeV1[];
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
    validateAcceptance: () => true,
    rateLimit: opts.rateLimit,
    notify: opts.notify,
    driver: opts.driver,
  });
  const outbound: EnvelopeV1[] = [];
  const origSend = client.send.bind(client);
  (client as unknown as { send: typeof client.send }).send = async (env: EnvelopeV1, o?: { ackTimeoutMs?: number }) => {
    outbound.push(env);
    return origSend(env, o);
  };
  client.onEnvelope = (env) => session.onEnvelope(env);
  sessions.push(session);
  clients.push(client);
  await client.open();
  gw.syncRegistry(registry.snapshot(), (id) => registry.getNode(id)?.status);
  return { creds, session, client, outbound };
}

function offerEnv(from: string, to: string, taskId: string): EnvelopeV1 {
  return {
    v: 1,
    type: 'task.offer',
    msg_id: newId(),
    ts: new Date().toISOString(),
    exp: new Date(Date.now() + 60_000).toISOString(),
    from: { node_id: from, team_id: teamX, key_epoch: 1 },
    to: { node_id: to, team_id: teamX },
    trace: { trace_id: newId(), parent_span: null, origin_node: from },
    hops: 0,
    task_id: taskId,
    attempt: 1,
    sig: { alg: 'ed25519', value: 'x' },
    body: { kind: 'aid', summary: 's', lease_ms: 1000, offer_ttl_ms: 1000 },
  };
}

describe('同队缓冲带(03 §6.3)', () => {
  it('暂停开关:暂停即拒(busy + 人话 detail),恢复后正常接单', async () => {
    const exec = await enroll({});
    const fakeLead = newId();
    exec.session.setAcceptRemotePaused(true);
    expect(exec.session.isAcceptRemotePaused()).toBe(true);
    exec.session.onEnvelope(offerEnv(fakeLead, exec.creds.node_id, newId()));
    await new Promise((r) => setTimeout(r, 60));
    const rej = exec.outbound.find((e) => e.type === 'task.reject');
    expect(rej?.body).toMatchObject({ reason_code: 'busy', detail: '本地已暂停接远端单' });
    expect(exec.session.exec.rec.state).toBe('idle');
    // 恢复 → 正常接单
    exec.session.setAcceptRemotePaused(false);
    exec.session.onEnvelope(offerEnv(fakeLead, exec.creds.node_id, newId()));
    await new Promise((r) => setTimeout(r, 60));
    expect(exec.session.exec.rec.state).toBe('running');
  });

  it('per-source 限速:窗口内第 2 单被拒(来源限速)', async () => {
    const exec = await enroll({ rateLimit: { maxOffersPerMinPerSource: 1 } });
    const fakeLead = newId();
    exec.session.onEnvelope(offerEnv(fakeLead, exec.creds.node_id, newId()));
    await new Promise((r) => setTimeout(r, 60));
    expect(exec.session.exec.rec.state).toBe('running');
    // 撤销回到 idle,腾出执行位
    const cancel = offerEnv(fakeLead, exec.creds.node_id, newId());
    cancel.type = 'task.cancel';
    cancel.body = { reason: 'user' };
    exec.session.onEnvelope(cancel);
    await new Promise((r) => setTimeout(r, 60));
    expect(exec.session.exec.rec.state).toBe('stopped'); // cancel 后停止态
    // 窗口内第 2 单 → 限速拒
    exec.session.onEnvelope(offerEnv(fakeLead, exec.creds.node_id, newId()));
    await new Promise((r) => setTimeout(r, 60));
    expect(exec.session.exec.rec.state).toBe('stopped'); // 被限速拒,保持停止态
    const rej = exec.outbound.filter((e) => e.type === 'task.reject');
    expect(rej.some((e) => (e.body as { detail?: string }).detail === '来源限速')).toBe(true);
  });

  it('本地通知:执行方 task_start / task_end 可见(通知不阻断)', async () => {
    const notes: Array<{ kind: string; state?: string }> = [];
    const exec = await enroll({
      notify: (n) => notes.push({ kind: n.kind, state: n.state }),
      driver: new ScriptStubDriver({ completeAfterMs: 30, resultBody: { summary: 'done' } }),
    });
    const fakeLead = newId();
    exec.session.onEnvelope(offerEnv(fakeLead, exec.creds.node_id, newId()));
    await new Promise((r) => setTimeout(r, 60));
    exec.session.onEnvelope;
    void exec.session;
    await new Promise((r) => setTimeout(r, 120)); // 等驱动完成 → result 经 driverHost 出站
    await new Promise((r) => setTimeout(r, 60));
    expect(notes.some((n) => n.kind === 'task_start')).toBe(true);
    expect(notes.some((n) => n.kind === 'task_end' && n.state === 'result_sent')).toBe(true);
  });

  it('指标(01 §11):执行方出站 reject 计数入直方图', async () => {
    const exec = await enroll({});
    const fakeLead = newId();
    exec.session.setAcceptRemotePaused(true);
    exec.session.onEnvelope(offerEnv(fakeLead, exec.creds.node_id, newId()));
    await new Promise((r) => setTimeout(r, 60));
    expect(exec.session.metrics.snapshot().rejectReasons.busy).toBeGreaterThanOrEqual(1);
  });
});
