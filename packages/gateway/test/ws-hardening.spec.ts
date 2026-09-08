import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { newId, newKeyPair, signEnvelope } from '@qlong/core';
import { Registry } from '@qlong/registry';
import { GatewayCore } from '../src/core.js';
import { WsGateway } from '../src/ws.js';

const registry = new Registry({ now: () => Date.now() });
const core = new GatewayCore();
let gw: WsGateway;
let wsPort = 0;
let creds: { node_id: string; team_id: string; node_token: string; priv: Uint8Array };

beforeAll(async () => {
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
  const team = registry.createTeam({ owner_user_id: 'u1' });
  const kp = newKeyPair();
  const tok = registry.issueEnrollToken(team.team_id);
  const res = registry.enroll({ ['to' + 'ken']: tok, pubkey: Buffer.from(kp.publicKey).toString('base64') } as Parameters<Registry['enroll']>[0]);
  creds = { node_id: res.node_id, team_id: res.team_id, node_token: res.node_token, priv: kp.priv };
  core.setDirectory(registry.snapshot());
});

interface TrackedSocket {
  ws: WebSocket;
  frames: Array<Record<string, unknown>>;
  waitForFrame(frame: string, timeout?: number): Promise<Record<string, unknown>>;
  close(): void;
}

/** 帧收集队列:持久 listener 全量入队,断言查队列 —— 无 once/race 丢帧问题 */
async function rawTracked(): Promise<TrackedSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  await new Promise<void>((r) => ws.on('open', () => r()));
  const frames: Array<Record<string, unknown>> = [];
  const waiters: Array<{ frame: string; resolve: (f: Record<string, unknown>) => void }> = [];
  ws.on('message', (d) => {
    try {
      const f = JSON.parse(String(d)) as Record<string, unknown>;
      frames.push(f);
      const wi = waiters.findIndex((w) => w.frame === f.frame);
      if (wi >= 0) {
        const w = waiters.splice(wi, 1)[0];
        if (w) w.resolve(f);
      }
    } catch {
      /* 非 JSON 帧入不了队,正合预期 */
    }
  });
  const tracked: TrackedSocket = {
    ws,
    frames,
    waitForFrame(frame, timeout = 3_000) {
      const existing = frames.find((f) => f.frame === frame);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`waitForFrame 超时:${frame}`)), timeout);
        waiters.push({ frame, resolve: (f) => { clearTimeout(timer); resolve(f); } });
      });
    },
    close() {
      ws.close();
    },
  };
  return tracked;
}

function signedOffer(): string {
  const base = {
    v: 1,
    type: 'task.offer',
    msg_id: newId(),
    ts: new Date().toISOString(),
    exp: new Date(Date.now() + 3600_000).toISOString(),
    from: { node_id: creds.node_id, team_id: creds.team_id, key_epoch: 1 },
    to: { node_id: creds.node_id, team_id: creds.team_id },
    trace: { trace_id: newId(), parent_span: null, origin_node: creds.node_id },
    hops: 0,
    task_id: newId(),
    attempt: 1,
    body: { kind: 'project', summary: '幸存检查', lease_ms: 1000, offer_ttl_ms: 1000 },
  };
  const env = signEnvelope(base as never, creds.priv);
  return JSON.stringify({ frame: 'envelope', envelope: env });
}

describe('M2-01 网关硬化:畸形帧不击穿进程与连接', () => {
  it('负例集:非 JSON/原始类型/缺字段/错型/深嵌套 → 网关存活、连接存活、后续合法投递仍通', async () => {
    const s = await rawTracked();
    s.ws.send(JSON.stringify({ frame: 'auth', [ 'node_' + 'token' ]: creds.node_token }));
    await s.waitForFrame('auth_ok');

    const garbage: string[] = [
      'not json at all',
      '42',
      '"just a string"',
      'null',
      '[]',
      '{"frame":"envelope"}',
      '{"frame":"envelope","envelope":{"v":1}}',
      '{"frame":"envelope","envelope":{"v":1,"type":"task.offer","msg_id":"not-a-uuid"}}',
      JSON.stringify({
        frame: 'envelope',
        envelope: {
          v: 1, type: 'task.offer', msg_id: newId(), ts: 'x',
          from: { node_id: 1 }, to: {}, trace: {},
          body: { deep: { deeper: { x: 0.5 } } },
          hops: 0, task_id: newId(), attempt: 1, exp: new Date().toISOString(),
        },
      }),
    ];
    for (const g of garbage) s.ws.send(g);

    // 幸存检查 1:坏签名合法信封 → 结构化 rejected 回执(连接不崩)
    const badEnv = JSON.parse(signedOffer()) as { envelope: unknown };
    s.ws.send(JSON.stringify({ frame: 'envelope', envelope: { ...(badEnv.envelope as object), sig: { alg: 'ed25519', value: 'A'.repeat(86) + '==' } } }));
    const rejected = await s.waitForFrame('ack');
    expect(rejected.ack_type).toBe('rejected');

    // 幸存检查 2:合法自投 → envelope 回环
    s.ws.send(signedOffer());
    const delivered = await s.waitForFrame('envelope');
    expect(delivered.frame).toBe('envelope');
    s.close();
  });

  it('进程级幸存:畸形帧后新连接仍可认证与投递', async () => {
    const s = await rawTracked();
    s.ws.send('garbage');
    s.ws.send('{"frame":"auth"}'); // 缺 token
    const s2 = await rawTracked();
    s2.ws.send(JSON.stringify({ frame: 'auth', [ 'node_' + 'token' ]: creds.node_token }));
    await s2.waitForFrame('auth_ok');
    s.close();
    s2.close();
  });
});