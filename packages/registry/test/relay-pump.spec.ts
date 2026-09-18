import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Registry } from '../src/index.js';
import { createRegistryServer } from '../src/http.js';

/**
 * d1d:单端口 custody 集群中继路由 POST /internal/pump 的失败关闭语义。
 *
 * ws.ts 独立端口形态对 claim 库故障显式返回 500(fail-closed,"无法仲裁归属,绝不能伪装成非现主")。
 * 单端口形态经 onPumpNotify 回调同一个 gw.pumpNotify —— 其内部 claimRegistry.lookup 在中心 SQLite
 * faulted/损坏时会抛。此路由必须同样 500,而**不能**让该异常落入外层"畸形请求"catch 伪装成 400:
 * 服务端存储故障 ≠ 客户端请求错误,误标 400 会让运维把中心库故障归咎于对端网关的请求。
 * (通知本身 best-effort、对端吞错,故无投递正确性影响;此处校准的是失败信号的一致性与可观测性。)
 */
const SECRET = 'relay-secret';
const servers: Server[] = [];

async function start(onPumpNotify: (toNodeId: string, generation: number) => boolean): Promise<string> {
  const registry = new Registry({ now: () => 1_000_000 });
  const server = createRegistryServer({ registry, relaySecret: SECRET, onPumpNotify });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function post(base: string, body: unknown, secret: string | undefined = SECRET): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}/internal/pump`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(secret ? { 'x-qlong-relay-secret': secret } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as unknown };
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('单端口 /internal/pump 中继路由(d1d fail-closed)', () => {
  it('claim 库故障(onPumpNotify 抛)→ 500 fail-closed,不伪装成 400 畸形请求', async () => {
    const base = await start(() => { throw new Error('claim store faulted'); });
    const r = await post(base, { to_node_id: randomUUID(), generation: 1 });
    expect(r.status).toBe(500);
  });

  it('现主 → 200 {pumped:true};非现主/陈旧 generation → 200 {pumped:false}(路由契约不受 fail-closed 影响)', async () => {
    const base = await start((_toNodeId, generation) => generation === 7);
    const id = randomUUID();
    expect(await post(base, { to_node_id: id, generation: 7 })).toEqual({ status: 200, json: { pumped: true } });
    expect(await post(base, { to_node_id: id, generation: 8 })).toEqual({ status: 200, json: { pumped: false } });
  });

  it('错密钥 403 / 空密钥 403 / 缺字段 400 / 非法 generation 400 / 非 uuid 400', async () => {
    const base = await start(() => true);
    const id = randomUUID();
    expect((await post(base, { to_node_id: id, generation: 1 }, 'wrong')).status).toBe(403);
    expect((await post(base, { to_node_id: id, generation: 1 }, '')).status).toBe(403); // 空串 → 不带头
    expect((await post(base, {})).status).toBe(400);
    expect((await post(base, { to_node_id: id, generation: 0 })).status).toBe(400);
    expect((await post(base, { to_node_id: 'not-a-uuid', generation: 1 })).status).toBe(400);
  });
});
