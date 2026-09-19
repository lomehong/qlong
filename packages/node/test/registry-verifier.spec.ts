import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { newId, newKeyPair, toBase64 } from '@qlong/core';
import { createPubkeyResolver, type RegistryIdentity } from '../src/remote/registry-verifier.js';

/**
 * e2d-3c:createPubkeyResolver —— 牵头方按注册中心登记公钥回源(ARTIFACT-ACCEPTANCE §4.3)。
 * 复用 fetchRegistryJson + createRegistryVerifier 内层同款校验(node_id/key_epoch/status/team),
 * 但独立导出、返回 Uint8Array|undefined(对齐 lead.ts resolvePubkey 端口),失败一律 undefined(fail-closed)。
 * 真实 /v1/nodes/{id}/pubkey?epoch= 200 体 = {node_id,status,key_epoch,pubkey}(不含 team_id;team 校验为防御性)。
 */

const TEAM = newId();
const OTHER_TEAM = newId();
const SENDER = newId();
const OTHER = newId();
const senderKey = newKeyPair();
const PUB_B64 = toBase64(senderKey.publicKey);

// 本节点身份:resolver 仅取 team_id 做跨队核对(node_id/pubkey 不参与解析)。
const identity: RegistryIdentity = { node_id: newId(), team_id: TEAM, key_epoch: 1, pubkey: PUB_B64 };

type Stub = { kind: 'json'; status: number; body: unknown } | { kind: 'raw'; raw: string };
let stub: Stub = { kind: 'json', status: 200, body: {} };
const seen: Array<{ url: string; auth?: string }> = [];

let server: Server;
let registryUrl = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization });
    if (stub.kind === 'raw') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(stub.raw);
      return;
    }
    res.writeHead(stub.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stub.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  registryUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  stub = { kind: 'json', status: 200, body: {} };
  seen.length = 0;
});

const resolver = () => createPubkeyResolver({ registryUrl, nodeToken: 'tok' }, identity);
const okBody = (over: Record<string, unknown> = {}) =>
  ({ node_id: SENDER, status: 'current', key_epoch: 1, pubkey: PUB_B64, ...over });

describe('createPubkeyResolver(注册中心公钥回源,ARTIFACT-ACCEPTANCE §4.3)', () => {
  it('T1 current 纪元:回源登记公钥 → 32 字节;携带 Bearer 与 ?epoch=', async () => {
    stub = { kind: 'json', status: 200, body: okBody() };
    const pub = await resolver()(SENDER, 1);
    expect(pub).toBeInstanceOf(Uint8Array);
    expect(pub!.length).toBe(32);
    expect(Buffer.from(pub!).toString('base64')).toBe(PUB_B64);
    expect(seen).toHaveLength(1);
    const first = seen[0]!;
    expect(first.url).toBe(`/v1/nodes/${SENDER}/pubkey?epoch=1`);
    expect(first.auth).toBe('Bearer tok');
  });

  it('T2 historical 纪元:轮换窗口内补投验签 → 同样回源公钥', async () => {
    stub = { kind: 'json', status: 200, body: okBody({ status: 'historical' }) };
    const pub = await resolver()(SENDER, 1);
    expect(pub).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(pub!).toString('base64')).toBe(PUB_B64);
  });

  it('T3 node_id 不符(他人公钥冒充本次交付)→ undefined', async () => {
    stub = { kind: 'json', status: 200, body: okBody({ node_id: OTHER }) };
    expect(await resolver()(SENDER, 1)).toBeUndefined();
  });

  it('T4 key_epoch 不符 → undefined', async () => {
    stub = { kind: 'json', status: 200, body: okBody({ key_epoch: 2 }) };
    expect(await resolver()(SENDER, 1)).toBeUndefined();
  });

  it('T5 status 非 current/historical(如 revoked)→ undefined', async () => {
    stub = { kind: 'json', status: 200, body: okBody({ status: 'revoked' }) };
    expect(await resolver()(SENDER, 1)).toBeUndefined();
  });

  it('T6 team_id 守卫:同队 → 公钥;跨队 → undefined', async () => {
    stub = { kind: 'json', status: 200, body: okBody({ team_id: TEAM }) };
    expect(await resolver()(SENDER, 1)).toBeInstanceOf(Uint8Array);
    stub = { kind: 'json', status: 200, body: okBody({ team_id: OTHER_TEAM }) };
    expect(await resolver()(SENDER, 1)).toBeUndefined();
  });

  it('T7 HTTP 非 2xx(节点不存在/非 active/纪元冲突)→ undefined,绝不抛', async () => {
    for (const status of [404, 403, 500]) {
      stub = { kind: 'json', status, body: { error: { code: 'x' } } };
      expect(await resolver()(SENDER, 1)).toBeUndefined();
    }
  });

  it('T8 非法输入:非 UUID / epoch<1 / 非整数 → undefined 且零回源请求', async () => {
    stub = { kind: 'json', status: 200, body: okBody() };
    expect(await resolver()('not-a-uuid', 1)).toBeUndefined();
    expect(await resolver()(SENDER, 0)).toBeUndefined();
    expect(await resolver()(SENDER, 1.5)).toBeUndefined();
    expect(seen).toHaveLength(0);
  });

  it('T9 畸形响应:非法公钥 / 坏 JSON → undefined', async () => {
    stub = { kind: 'json', status: 200, body: okBody({ pubkey: 'not-44-chars' }) };
    expect(await resolver()(SENDER, 1)).toBeUndefined();
    stub = { kind: 'raw', raw: '{ this is not json' };
    expect(await resolver()(SENDER, 1)).toBeUndefined();
  });
});
