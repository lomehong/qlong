import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateIdentity } from '../src/identity.js';

describe('createProductionNode', () => {
  it('fetch /v1/nodes/me 失败时抛出明确错误', async () => {
    const mockFetch = (await import('vitest')).vi.fn().mockResolvedValue({ ok: false, status: 401 });
    (await import('vitest')).vi.stubGlobal('fetch', mockFetch);
    const { createProductionNode } = await import('../src/remote/factory.js');
    await expect(createProductionNode({
      registryUrl: 'http://fake',
      gatewayUrl: 'ws://fake',
      nodeToken: 'bad',
    })).rejects.toThrow('401');
    (await import('vitest')).vi.unstubAllGlobals();
  });

  it('启动即上报 caps,并按周期上报 load(03 §4)', async () => {
    const puts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const srv: Server = createServer((req, res) => {
      const path = req.url ?? '';
      if (req.method === 'GET' && path === '/v1/nodes/me') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ node_id: '11111111-1111-4111-8111-111111111111', team_id: 't1', key_epoch: 1 }));
        return;
      }
      if (req.method === 'PUT' && (path === '/v1/nodes/me/caps' || path === '/v1/nodes/me/load')) {
        let raw = '';
        req.on('data', (c: Buffer) => (raw += c.toString()));
        req.on('end', () => {
          puts.push({ path, body: JSON.parse(raw) as Record<string, unknown> });
          res.writeHead(200);
          res.end('{}');
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;

    const dataDir = mkdtempSync(join(tmpdir(), 'qlong-factory-'));
    const { createProductionNode } = await import('../src/remote/factory.js');
    const node = await createProductionNode({
      registryUrl: `http://127.0.0.1:${port}`,
      gatewayUrl: 'ws://127.0.0.1:9', // 不可达:weak-net 后台重连,不影响上报
      nodeToken: 'node_test',
      dataDir,
      capabilities: () => ['tool:node@20'],
      load: () => ({ queueDepth: 1, running: 0, maxQueue: 8, maxRunning: 2 }),
      reportIntervalMs: 30,
    });
    try {
      await node.start();
      const deadline = Date.now() + 3_000;
      const capsPut = () => puts.find((p) => p.path === '/v1/nodes/me/caps');
      const loadPuts = () => puts.filter((p) => p.path === '/v1/nodes/me/load');
      while (!(capsPut() && loadPuts().length >= 2) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(capsPut()?.body).toMatchObject({ caps: ['tool:node@20'] });
      expect(loadPuts().length).toBeGreaterThanOrEqual(2);
      const firstLoad = loadPuts()[0];
      expect(firstLoad).toBeDefined();
      expect(firstLoad?.body).toMatchObject({ queue_depth: 1, running: 0, accepting: true });
    } finally {
      node.stop();
      srv.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('节点身份存档(02 §3.2)', () => {
  it('同一 dataDir 二次加载返回同一密钥(私钥不重生成)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlong-id-'));
    try {
      const a = loadOrCreateIdentity(dir);
      const b = loadOrCreateIdentity(dir);
      expect(b.pubkeyB64).toBe(a.pubkeyB64);
      expect(Buffer.from(b.priv).equals(Buffer.from(a.priv))).toBe(true);
      const doc = JSON.parse(readFileSync(join(dir, 'identity.json'), 'utf8')) as { pubkey_b64: string };
      expect(doc.pubkey_b64).toBe(a.pubkeyB64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
