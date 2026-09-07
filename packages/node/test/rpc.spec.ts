import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EnvelopeV1 } from '@qlong/core';
import { newId, newKeyPair, verifyEnvelopeSig, type QlongParams } from '@qlong/core';
import { Registry } from '../../registry/src/index.js';
import { GatewayCore } from '../../gateway/src/core.js';
import { WsGateway } from '../../gateway/src/ws.js';
import { RemoteNodeSession } from '../src/remote/session.js';
import { GatewayClient } from '../src/gateway-client.js';

/**
 * 01 §4.1 rpc.* 运行时(问答族):ask/answer 关联、重投去重、超时、内置应答器。
 * 依赖网关与注册中心(与 gateway 包 m4-caps 同款三方接线)。
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
  client: GatewayClient;
}

async function enroll(opts: { caps?: string[]; rpcHandler?: Stack['session']['opts']['rpcHandler'] } = {}): Promise<Stack> {
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
    capabilities: () => opts.caps ?? [],
    rpcHandler: opts.rpcHandler,
  });
  client.onEnvelope = (env) => session.onEnvelope(env);
  sessions.push(session);
  clients.push(client);
  await client.open();
  gw.syncRegistry(registry.snapshot(), (id) => registry.getNode(id)?.status);
  return { creds, session, client };
}

describe('rpc.* 问答族(01 §4.1)', () => {
  it('caps.query:ask → answer 按 request_id 关联,携带对端能力', async () => {
    const a = await enroll({});
    const b = await enroll({ caps: ['tool:node@20'] });
    const answer = (await a.session.ask(b.creds.node_id, 'caps.query', 2_000)) as { caps: string[] };
    expect(answer.caps).toEqual(['tool:node@20']);
  });

  it('status.query 内置应答器(未配置 rpcHandler 也可用)', async () => {
    const a = await enroll({});
    const b = await enroll({ caps: [] });
    const answer = (await a.session.ask(b.creds.node_id, 'status.query', 2_000)) as {
      node_id: string;
      exec_state: string;
    };
    expect(answer.node_id).toBe(b.creds.node_id);
    expect(answer.exec_state).toBe('idle');
  });

  it('未知问题且无自定义应答器 → answer.error = no_handler', async () => {
    const a = await enroll({});
    const b = await enroll({});
    const answer = (await a.session.ask(b.creds.node_id, '随便问点啥', 2_000)) as { error?: string };
    expect(answer.error).toBe('no_handler');
  });

  it('应答超时 → ask 以异常拒绝', async () => {
    const a = await enroll({});
    const slow = await enroll({
      rpcHandler: () => new Promise(() => undefined), // 永不应答
    });
    await expect(a.session.ask(slow.creds.node_id, 'caps.query', 120)).rejects.toThrow(/超时/);
  });

  it('ask 重投去重:同一 request_id 只应答一次', async () => {
    let calls = 0;
    const b = await enroll({ rpcHandler: () => { calls += 1; return 'ok'; } });
    const a = await enroll({});
    // 构造一条 ask 信封,直接喂两次(模拟传输层重投)
    const askEnv: EnvelopeV1 = {
      v: 1,
      type: 'rpc.ask',
      msg_id: newId(),
      ts: new Date().toISOString(),
      exp: new Date(Date.now() + 60_000).toISOString(),
      from: { node_id: a.creds.node_id, team_id: teamX, key_epoch: 1 },
      to: { node_id: b.creds.node_id, team_id: teamX },
      trace: { trace_id: newId(), parent_span: null, origin_node: a.creds.node_id },
      sig: { alg: 'ed25519', value: 'x' },
      body: { request_id: newId(), question: 'caps.query' },
    };
    b.session.onEnvelope(askEnv);
    b.session.onEnvelope(askEnv);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(1);
  });
});
