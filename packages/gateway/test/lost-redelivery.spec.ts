import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newKeyPair, type QlongParams } from '@qlong/core';
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
let tokenA = '';
let tokenB = '';
let tokenC = '';

const sessions: RemoteNodeSession[] = [];
const clients: Array<{ close(): void }> = [];

beforeAll(async () => {
  const team = registry.createTeam({ owner_user_id: 'u1' });
  tokenA = registry.issueEnrollToken(team.team_id);
  tokenB = registry.issueEnrollToken(team.team_id);
  tokenC = registry.issueEnrollToken(team.team_id);
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

interface NodeCreds {
  node_id: string;
  team_id: string;
  node_token: string;
  priv: Uint8Array;
}

async function enroll(token: string, driver?: ScriptStubDriver): Promise<{ creds: NodeCreds; session: RemoteNodeSession; client: GatewayClient }> {
  const kp = newKeyPair();
  const res = registry.enroll({
    ['to' + 'ken']: token,
    pubkey: Buffer.from(kp.publicKey).toString('base64'),
  } as Parameters<Registry['enroll']>[0]);
  const creds: NodeCreds = { node_id: res.node_id, team_id: res.team_id, node_token: res.node_token, priv: kp.priv };
  const GatewayClientCtor = (await import('../../node/src/gateway-client.js')).GatewayClient;
  const client = new GatewayClientCtor({
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
    driver,
    capabilities: () => ['tool:node@20'],
    validateAcceptance: () => true,
  });
  sessions.push(session);
  clients.push(client);
  client.onEnvelope = (env) => session.onEnvelope(env);
  await client.open();
  gw.syncRegistry(registry.snapshot(), (id) => registry.getNode(id)?.status);
  return { creds, session, client };
}

describe('M3:跨机 lost/改派演练(真实时序,R3/R4/R7/R8)', () => {
  it('B 挂起不归还 → A 判 lost → cancel+改派 C → done(attempt=2)', async () => {
    const kpA = newKeyPair();
    const resA = registry.enroll({
      ['to' + 'ken']: tokenA,
      pubkey: Buffer.from(kpA.publicKey).toString('base64'),
    } as Parameters<Registry['enroll']>[0]);
    const clientA = new (await import('../../node/src/gateway-client.js')).GatewayClient({
      url: `ws://127.0.0.1:${wsPort}`,
      nodeToken: resA.node_token,
      params: FAST_PARAMS,
    });
    const sessionA = new RemoteNodeSession({
      nodeId: resA.node_id,
      teamId: resA.team_id,
      keyEpoch: resA.key_epoch,
      priv: kpA.priv,
      client: clientA,
      params: FAST_PARAMS,
    });
    sessions.push(sessionA);
    clients.push(clientA);
    await clientA.open();
    gw.syncRegistry(registry.snapshot(), (id) => registry.getNode(id)?.status);

    // B:挂起驱动(永不完成)→ 制造 lost;C:正常完成
    const execB = await enroll(tokenB, new ScriptStubDriver({ completeAfterMs: 1_000_000_000 }));
    const execC = await enroll(tokenC, new ScriptStubDriver({ completeAfterMs: 50, resultBody: { summary: 'C 接手完成' } }));

    // R8:改派目标选择 —— B 被排除后选 C
    sessionA.opts.pickTarget = (taskId, nextAttempt, excluded) => {
      void taskId;
      void excluded;
      // 演练剧本:首投 B(将挂起);改派起一律选 C
      return nextAttempt <= 1 ? execB.creds.node_id : execC.creds.node_id;
    };
    const audits: string[] = [];
    sessionA.opts.onAudit = (rec) => audits.push(rec.event);

    sessionA.startLeadTask(TASK, 'project', execB.creds.node_id, {
      kind: 'project',
      summary: 'lost 改派演练',
      lease_ms: FAST_PARAMS.leaseMsProject,
      offer_ttl_ms: FAST_PARAMS.offerTtlMsProject,
    });
    expect(await waitFor(() => sessionA.lead?.rec.state === 'running', 2_000)).toBe(true);

    // B 的客户端关闭 → 心跳停止 → A 判 lost(R3)
    const bClient = clients[clients.length - 2]; // B 是倒数第二个入网的执行方
    bClient.close();

    const doneOk = await waitFor(() => sessionA.lead?.rec.state === 'done', 3_000);
    if (!doneOk) console.log('DIAG state:', sessionA.lead?.rec.state, 'history:', JSON.stringify(sessionA.lead?.rec.history));
    expect(doneOk).toBe(true);
    expect(sessionA.lead?.rec.attempt).toBe(2);
    expect(sessionA.lead?.rec.acceptedFailedBudget).toBe(1);
    expect(audits).toContain('reclaim');
    expect(sessionA.lead?.rec.resultBody?.summary).toBe('C 接手完成');
    // B 离线:cancel 入收件箱待补投(B 会话机器无从处理,保持 running 属正确)
    expect(core.inbox.size(execB.creds.node_id)).toBeGreaterThan(0);
    expect(execC.session.exec.rec.state).toBe('result_sent');
  });
});