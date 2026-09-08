import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startQlongServer, type ServerHandles } from '../src/server.js';

/**
 * v0.8 服务器级集群接线(02 §12.1):单端口形态下 registry http 承载
 * POST /internal/envelope 中继(密钥头鉴权);clusterSecret 缺省时不暴露。
 */
const SECRET = 'srv-cluster-secret';
let handles: ServerHandles;
let base = '';

beforeAll(async () => {
  handles = await startQlongServer({
    registryPort: 0,
    gatewayPath: '/gateway',
    seedTeam: false,
    clusterSecret: SECRET,
  });
  base = `http://127.0.0.1:${handles.registryPort}`;
});

afterAll(async () => {
  await handles.close();
});

describe('qlong server 集群接线(v0.8)', () => {
  it('clusterSecret 设置后暴露集群句柄与中继路由', async () => {
    expect(handles.cluster).toBeDefined();
    expect(handles.cluster!.size).toBe(1); // 单实例集群形态:仅自身成员

    const post = (secret: string | undefined, payload: unknown): Promise<Response> =>
      fetch(`${base}/internal/envelope`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(secret ? { 'x-qlong-cluster-secret': secret } : {}) },
        body: JSON.stringify(payload),
      });

    const bad = await post('wrong', { to_node_id: randomUUID(), envelope: {} });
    expect(bad.status).toBe(403);

    const absent = randomUUID();
    const env = {
      v: 1,
      type: 'msg.notify',
      msg_id: randomUUID(),
      ts: new Date().toISOString(),
      from: { node_id: randomUUID(), key_epoch: 1 },
      to: { node_id: absent, key_epoch: 1 },
      trace: { trace_id: randomUUID(), parent_span: null, origin_node: randomUUID() },
      body: { kind: 'project' },
    };
    const ok = await post(SECRET, { to_node_id: absent, envelope: env });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { result: string }).result).toBe('queued');

    const malformed = await post(SECRET, { to_node_id: absent, envelope: { msg_id: 'nope' } });
    expect(malformed.status).toBe(400); // 畸形信封不入箱
  });

  it('clusterSecret 缺省:无集群句柄,中继路由 404', async () => {
    const plain = await startQlongServer({ registryPort: 0, gatewayPath: '/gateway', seedTeam: false });
    try {
      expect(plain.cluster).toBeUndefined();
      const res = await fetch(`http://127.0.0.1:${plain.registryPort}/internal/envelope`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-qlong-cluster-secret': SECRET },
        body: JSON.stringify({ to_node_id: 'x', envelope: {} }),
      });
      expect(res.status).toBe(404);
    } finally {
      await plain.close();
    }
  });
});
