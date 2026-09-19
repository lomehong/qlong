import { once } from 'node:events';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { createServer, type Server } from 'node:http';
import {
  CUSTODY_FEATURES, MAX_TRANSPORT_BYTES, envelopeDigest, newId, newKeyPair, signEnvelope,
  type EnvelopeV1,
} from '@qlong/core';
import { SqliteStore, StorageError, type SqliteStoreOptions } from '../../storage/src/index.js';
import { NODE_SCHEMA } from '../src/runtime/schema.js';
import { NodeRuntimeStore } from '../src/runtime/store.js';
import { createDurableNode, type DurableNode } from '../src/runtime/node.js';
import { FencedWorkspace } from '../src/collab/workspace.js';
import { verifyManifest, type SignedManifest } from '../src/collab/artifact-manifest.js';
import { TASK_REPORT_KIND, type TaskReport } from '../src/runtime/report.js';
import type { ExecutorWorkspace, FencedDriver, RunContext, RunFence, RunHandle, RunOutcome } from '../src/driver/run-handle.js';

const tempBase = realpathSync(tmpdir());
const roots = new Set<string>();
const nodes = new Set<DurableNode>();
const servers: WebSocketServer[] = [];
const httpServers: Server[] = [];

afterEach(async () => {
  for (const node of [...nodes].reverse()) {
    try { await node.stop(); } catch { /* faulted/stopped stops are expected in some tests */ }
  }
  nodes.clear();
  for (const server of servers.reverse()) {
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.length = 0;
  for (const http of httpServers.splice(0)) {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
  for (const root of roots) {
    if (dirname(root) !== tempBase || !basename(root).startsWith('qlong-durable-node-')) {
      throw new Error('Unsafe durable node test cleanup target');
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  roots.clear();
});

const wait = (check: () => void) => vi.waitFor(check, { timeout: 4_000, interval: 10 });
const write = (ws: WebSocket, frame: unknown): void => ws.send(JSON.stringify(frame));
const stored = (env: EnvelopeV1) => ({
  frame: 'stored', from_node: env.from.node_id, msg_id: env.msg_id, digest: envelopeDigest(env),
});
const delivery = (env: EnvelopeV1, ticket = newId()) => ({
  frame: 'delivery', envelope: env, digest: envelopeDigest(env), ticket,
});
const RESULT: RunOutcome = { kind: 'result', body: { summary: 'finished' } };

class StubDriver implements FencedDriver {
  readonly started: Array<{ fence: RunFence; offer: Record<string, unknown>; ctx?: RunContext }> = [];
  readonly stops: string[] = [];
  private readonly pending = new Map<string, (outcome: RunOutcome) => void>();
  recover = vi.fn(async (): Promise<'stopped' | 'unknown'> => 'unknown');

  start = async (fence: RunFence, offer: Record<string, unknown>, ctx?: RunContext): Promise<RunHandle> => {
    this.started.push({ fence, offer, ctx });
    let resolveClosed!: (outcome: RunOutcome) => void;
    const closed = new Promise<RunOutcome>((resolve) => { resolveClosed = resolve; });
    this.pending.set(fence.run_id, resolveClosed);
    return Object.freeze({ fence, closed, stop: async () => { this.stops.push(fence.run_id); } });
  };

  complete(runId: string, outcome: RunOutcome = RESULT): void {
    this.pending.get(runId)?.(outcome);
    this.pending.delete(runId);
  }
}

/** e2d-1d:记录型 ExecutorWorkspace 桩——验证 createDurableNode 把工作区端口接线到执行器。 */
class StubWorkspace implements ExecutorWorkspace {
  readonly prepared: RunFence[] = [];
  readonly released: RunFence[] = [];
  async prepare(fence: Readonly<RunFence>): Promise<RunContext> {
    this.prepared.push({ ...fence });
    return { cwd: `/ws/${fence.run_id}` };
  }
  async release(fence: Readonly<RunFence>): Promise<void> { this.released.push({ ...fence }); }
}

interface FixtureOptions {
  verify?: (env: EnvelopeV1) => Promise<boolean>;
  driver?: FencedDriver;
  onFrame?: (frame: Record<string, unknown>, ws: WebSocket) => void;
  mode?: 'create' | 'open';
}

async function fixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tempBase, 'qlong-durable-node-'));
  roots.add(root);
  const dataDir = join(root, 'data');
  const identityKeys = newKeyPair();
  const peerKeys = newKeyPair();
  const identity = {
    node_id: newId(), team_id: newId(), key_epoch: 1,
    pubkey: Buffer.from(identityKeys.publicKey).toString('base64'),
  };
  const peerId = newId();
  const storeOptions: SqliteStoreOptions = {
    allowedBase: root, dataDir, mode: options.mode ?? 'create', schema: NODE_SCHEMA,
    localFilesystemConfirmed: true, windowsAclConfirmed: true, busyTimeoutMs: 25,
  };
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: MAX_TRANSPORT_BYTES + 4_096 });
  servers.push(server);
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  const frames: Array<Record<string, unknown>> = [];
  const sockets: WebSocket[] = [];
  let verify: (env: EnvelopeV1) => Promise<boolean> = options.verify ?? (async () => true);
  server.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('error', () => {});
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      if (frame.frame === 'auth') {
        write(ws, { frame: 'auth_ok', transport_version: 2, features: CUSTODY_FEATURES, node_id: identity.node_id });
        return;
      }
      frames.push(frame);
      options.onFrame?.(frame, ws);
    });
  });
  const makeNode = async (overrides: Partial<Parameters<typeof createDurableNode>[0]> = {}): Promise<DurableNode> => {
    const node = await createDurableNode({
      registryUrl: 'http://127.0.0.1:9',
      gatewayUrl: `ws://127.0.0.1:${port}`,
      nodeToken: 'test-only',
      privKey: identityKeys.priv,
      storage: { ...storeOptions, mode: options.mode ?? 'create' },
      identity,
      verifyInbound: (env) => verify(env),
      reportIntervalMs: 0,
      tickIntervalMs: 50,
      verifyRetryMs: 200,
      shutdownFlushMs: 2_000,
      driverTimeoutMs: 1_000,
      driver: options.driver,
      ...overrides,
    });
    nodes.add(node);
    return node;
  };
  const signPeer = (overrides: Partial<EnvelopeV1>, body: Record<string, unknown>): EnvelopeV1 => signEnvelope({
    v: 1, type: 'task.offer', msg_id: newId(), task_id: newId(), attempt: 1, hops: 0,
    ts: new Date().toISOString(), exp: new Date(Date.now() + 60_000).toISOString(),
    from: { node_id: peerId, team_id: identity.team_id, key_epoch: 1 },
    to: { node_id: identity.node_id, team_id: identity.team_id },
    trace: { trace_id: newId(), parent_span: null, origin_node: peerId },
    body, ...overrides,
  }, peerKeys.priv);
  return {
    root, dataDir, identity, peerId, frames, sockets, makeNode, signPeer, identityKeys,
    setVerify: (next: (env: EnvelopeV1) => Promise<boolean>) => { verify = next; },
    get socket() { return sockets.at(-1)!; },
    send: (frame: unknown) => write(sockets.at(-1)!, frame),
    received: (kind: string) => frames.filter((frame) => frame.frame === kind),
    sentEnvelopes: () => frames.flatMap((frame) => frame.frame === 'envelope' ? [frame.envelope as EnvelopeV1] : []),
    sent: (type: string) => frames
      .flatMap((frame) => frame.frame === 'envelope' ? [frame.envelope as EnvelopeV1] : [])
      .filter((env) => env.type === type),
  };
}

const autoStored: FixtureOptions['onFrame'] = (frame, ws) => {
  if (frame.frame === 'envelope') write(ws, stored(frame.envelope as EnvelopeV1));
};

/**
 * 最小 owner 命令中心(E3c 测试装置):镜像 SqliteCommandStore 的节点侧 HTTP 契约(OWNER-COMMAND §4.3),供
 * createDurableNode 的 pullCommands 经真实 HTTP 拉取/确认。维护 pending/acked 队列 + 记录 ack,并可注入
 * GET/ack 失败以验证 at-least-once/幂等/传输韧性。只服务 lead=指定 node 的命令(跨节点防越权由中心侧 e3a 固化)。
 */
interface CenterCommand {
  id: string; team_id: string; lead: string; task_id: string;
  kind: 'cancel' | 'redispatch'; status: 'pending' | 'acked'; created_at: string; acked_at?: string;
}

async function startCommandCenter(nodeId: string, teamId: string, nodeToken = 'test-only') {
  const commands: CenterCommand[] = [];
  const acks: string[] = [];
  let failGets = false;
  let failAcks = false;
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]!;
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== 'Bearer ' + nodeToken) { send(401, { error: 'unauthorized' }); return; }
    if (req.method === 'GET' && path === '/v1/nodes/me/commands') {
      if (failGets) { send(503, { error: 'center down' }); return; }
      send(200, { commands: commands.filter((c) => c.lead === nodeId && c.status === 'pending') });
      return;
    }
    const ack = /^\/v1\/nodes\/me\/commands\/([^/]+)\/ack$/.exec(path);
    if (req.method === 'POST' && ack) {
      if (failAcks) { send(500, { error: 'ack down' }); return; }
      const cmd = commands.find((c) => c.id === decodeURIComponent(ack[1]!) && c.lead === nodeId && c.status === 'pending');
      if (!cmd) { send(200, { ok: false }); return; }
      cmd.status = 'acked';
      cmd.acked_at = new Date().toISOString();
      acks.push(cmd.id);
      send(200, { ok: true });
      return;
    }
    // start() 的 reportCaps(PUT /v1/nodes/me/caps)与默认上报汇(POST /v1/teams/:id/tasks):一律 200 消噪。
    if (req.method === 'PUT' || req.method === 'POST') { send(200, {}); return; }
    send(404, {});
  });
  httpServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    acks,
    get pending(): CenterCommand[] { return commands.filter((c) => c.status === 'pending'); },
    enqueue(task_id: string, kind: 'cancel' | 'redispatch'): CenterCommand {
      const cmd: CenterCommand = {
        id: newId(), team_id: teamId, lead: nodeId, task_id, kind,
        status: 'pending', created_at: new Date().toISOString(),
      };
      commands.push(cmd);
      return cmd;
    },
    setFailGets: (v: boolean): void => { failGets = v; },
    setFailAcks: (v: boolean): void => { failAcks = v; },
  };
}

describe('DurableNode v2 task loop', () => {
  it('accepts a live offer, runs the fenced driver and releases custody after stored', async () => {
    const driver = new StubDriver();
    const f = await fixture({ driver, onFrame: autoStored });
    const node = await f.makeNode();
    await node.start();
    expect(node.client.transportVersion).toBe(2);

    const env = f.signPeer({}, { kind: 'aid', summary: 'durable node test', lease_ms: 60_000, offer_ttl_ms: 30_000 });
    f.send(delivery(env));
    await wait(() => expect(f.sent('task.accept')).toHaveLength(1));
    const accept = f.sent('task.accept')[0]!;
    expect(accept.task_id).toBe(env.task_id);
    expect(accept.attempt).toBe(1);
    expect(accept.reply_to).toBe(env.msg_id);
    await wait(() => expect(driver.started).toHaveLength(1));
    expect(driver.started[0]!.fence).toMatchObject({ task_id: env.task_id, attempt: 1, generation: 1 });
    expect(driver.started[0]!.offer).toMatchObject({ kind: 'aid', summary: 'durable node test' });

    driver.complete(driver.started[0]!.fence.run_id);
    await wait(() => expect(f.sent('task.result')).toHaveLength(1));
    const result = f.sent('task.result')[0]!;
    expect(result.body).toMatchObject({ summary: 'finished', generation: 1 });
    expect(node.runtime.pending()).toHaveLength(0);
    await wait(() => expect(node.runtime.all()).toHaveLength(0)); // stored released the payload
    expect(node.executor.snapshot().slot).toBeNull();
  });

  it('driver 工厂形式:createDurableNode 用持久 runtime 解析并接线执行器(C1c)', async () => {
    const driver = new StubDriver();
    let seen: NodeRuntimeStore | undefined;
    const f = await fixture({ onFrame: autoStored });
    const node = await f.makeNode({ driver: (runtime) => { seen = runtime; return driver; } });
    expect(seen).toBe(node.runtime); // 工厂收到刚装配的持久 store(供 RunHandleStore 背书)
    await node.start();
    const env = f.signPeer({}, { kind: 'aid', summary: 'factory driver', lease_ms: 60_000, offer_ttl_ms: 30_000 });
    f.send(delivery(env));
    await wait(() => expect(driver.started).toHaveLength(1)); // 解析出的驱动确被执行器使用
  });

  it('workspace 端口形式:createDurableNode 接线执行器 → prepare 的 cwd 传驱动、结果提交后 release(e2d-1d)', async () => {
    const driver = new StubDriver();
    const workspace = new StubWorkspace();
    let seen: NodeRuntimeStore | undefined;
    const f = await fixture({ driver, onFrame: autoStored });
    const node = await f.makeNode({ workspace: (runtime) => { seen = runtime; return workspace; } });
    expect(seen).toBe(node.runtime); // 工厂收到刚装配的持久 store
    await node.start();
    const env = f.signPeer({}, { kind: 'aid', summary: 'workspace wiring', lease_ms: 60_000, offer_ttl_ms: 30_000 });
    f.send(delivery(env));
    await wait(() => expect(driver.started).toHaveLength(1));
    const fence = driver.started[0]!.fence;
    expect(workspace.prepared).toEqual([{ ...fence }]);          // 执行器事务外 prepare
    expect(driver.started[0]!.ctx).toEqual({ cwd: `/ws/${fence.run_id}` }); // 解析 cwd 传驱动
    expect(workspace.released).toEqual([]);                       // 在途不清理
    driver.complete(fence.run_id);
    await wait(() => expect(f.sent('task.result')).toHaveLength(1));
    await wait(() => expect(workspace.released).toEqual([{ ...fence }])); // 结果提交后 release
    expect(node.executor.snapshot().slot).toBeNull();
  });

  it('artifactRepo 未配置 → PROJECT offer policy_denied(不装配 publisher、driver 不启动)(e2d-2d)', async () => {
    const driver = new StubDriver();
    const f = await fixture({ driver, onFrame: autoStored });
    const node = await f.makeNode({ workspace: new StubWorkspace() });
    await node.start();
    f.send(delivery(f.signPeer({}, { kind: 'project', summary: 'build', lease_ms: 60_000, offer_ttl_ms: 30_000,
      contract: { deliverables: [{ path: 'dist/report.md' }] } })));
    await wait(() => expect(f.sent('task.reject')).toHaveLength(1));
    expect(f.sent('task.reject')[0]!.body.reason_code).toBe('policy_denied');
    expect(driver.started).toHaveLength(0); // 未配置产物仓 → PROJECT 不准入,绝不启动 harness
    expect(node.executor.snapshot().slot).toBeNull();
  });

  it('artifactRepo 配置:createDurableNode 装配 GitArtifactPublisher → PROJECT 准入、真实产物入 git、task.result 携可验签 artifacts(e2d-2d)', async () => {
    const driver = new StubDriver();
    const f = await fixture({ driver, onFrame: autoStored });
    const repo = join(f.root, 'artifacts.git');
    execFileSync('git', ['init', '--bare', '--quiet', repo], { stdio: 'pipe' });
    const node = await f.makeNode({
      artifactRepo: repo,
      workspace: new FencedWorkspace({ baseDir: join(f.root, 'ws') }), // 真实工作区(落 f.root,随 afterEach 清理)
    });
    await node.start();
    const env = f.signPeer({}, { kind: 'project', summary: 'build', lease_ms: 60_000, offer_ttl_ms: 30_000,
      contract: { deliverables: [{ path: 'dist/report.md' }] } });
    f.send(delivery(env));
    await wait(() => expect(driver.started).toHaveLength(1));
    const { fence, ctx } = driver.started[0]!;
    expect(ctx?.cwd).toBeTruthy(); // 执行器事务外 prepare 的真实工作区
    // 真实子进程产物落入工作区(此处由测试代替 harness 写文件)
    mkdirSync(join(ctx!.cwd!, 'dist'), { recursive: true });
    writeFileSync(join(ctx!.cwd!, 'dist', 'report.md'), '# 真实产物');
    driver.complete(fence.run_id);
    await wait(() => expect(f.sent('task.result')).toHaveLength(1));
    const resultEnv = f.sent('task.result')[0]!;
    const artifacts = (resultEnv.body as { artifacts?: Array<{ repo: string; manifest: SignedManifest; branch: string }> }).artifacts;
    expect(artifacts).toHaveLength(1);
    expect(artifacts![0]!.repo).toBe(repo);
    expect(artifacts![0]!.branch).toBe(`qlong/${fence.task_id}/a${fence.attempt}`);
    // 清单以节点登记私钥签名,登记公钥可独立验签;钥标识 == 信封署名者(牵头方防线①)
    expect(verifyManifest(artifacts![0]!.manifest, f.identityKeys.publicKey)).toBe(true);
    expect(artifacts![0]!.manifest.manifest.node_id).toBe(f.identity.node_id);
    expect(artifacts![0]!.manifest.manifest.key_epoch).toBe(f.identity.key_epoch);
    expect(resultEnv.from.node_id).toBe(f.identity.node_id);
    await wait(() => expect(node.executor.snapshot().slot).toBeNull());
  });

  it('rejects a live offer without a driver instead of executing it', async () => {
    const f = await fixture({ onFrame: autoStored });
    const node = await f.makeNode();
    await node.start();
    f.send(delivery(f.signPeer({}, { kind: 'aid', summary: 'no driver', lease_ms: 60_000 })));
    await wait(() => expect(f.sent('task.reject')).toHaveLength(1));
    expect(f.sent('task.reject')[0]!.body.reason_code).toBe('policy_denied');
    expect(node.executor.snapshot().slot).toBeNull();
  });

  it('consumes a restart-pending offer only after fresh authorization', async () => {
    const driver = new StubDriver();
    const f = await fixture({ driver, onFrame: autoStored, mode: 'open' });

    // Pre-seed a persisted pending offer exactly as a previous process would have left it.
    const bootstrap = SqliteStore.open({
      allowedBase: f.root, dataDir: f.dataDir, mode: 'create', schema: NODE_SCHEMA, filename: 'runtime.sqlite',
      localFilesystemConfirmed: true, windowsAclConfirmed: true, busyTimeoutMs: 25,
    });
    new NodeRuntimeStore(bootstrap, f.identity.node_id).receive(
      f.signPeer({}, { kind: 'aid', summary: 'offline offer', lease_ms: 60_000 }));
    bootstrap.close();

    const verify = vi.fn(async () => true);
    f.setVerify(verify);
    const node = await f.makeNode();
    await node.start();
    expect(node.runtime.pending()).toHaveLength(0);
    expect(verify).toHaveBeenCalled(); // restart-pending custody is re-authorized, never trusted
    await wait(() => expect(f.sent('task.accept')).toHaveLength(1));
    await wait(() => expect(driver.started).toHaveLength(1));
    driver.complete(driver.started[0]!.fence.run_id);
    await wait(() => expect(f.sent('task.result')).toHaveLength(1));
  });

  it('keeps an unverifiable pending offer without replying, then retries it by timer', async () => {
    const driver = new StubDriver();
    const f = await fixture({ driver, onFrame: autoStored, verify: async () => false });
    const node = await f.makeNode();
    await node.start();

    const seeded = f.signPeer({}, { kind: 'aid', summary: 'unverified', lease_ms: 60_000 });
    expect(node.runtime.receive(seeded)).toBe('new'); // pending row without a live admission
    await node.drain(); // first pass skips without any destructive reply
    expect(f.sent('task.reject')).toHaveLength(0);
    expect(f.sent('task.accept')).toHaveLength(0);
    expect(node.runtime.pending()).toHaveLength(1);

    f.setVerify(async (incoming) => incoming.msg_id === seeded.msg_id);
    await wait(() => expect(f.sent('task.accept')).toHaveLength(1)); // tick-driven retry consumed it
    await wait(() => expect(node.runtime.pending()).toHaveLength(0));
  });

  it('honors a lead cancel mid-run: quiesces the driver and acks after storage', async () => {
    const driver = new StubDriver();
    const f = await fixture({ driver, onFrame: autoStored });
    const node = await f.makeNode();
    await node.start();

    const env = f.signPeer({}, { kind: 'aid', summary: 'cancel me', lease_ms: 60_000 });
    f.send(delivery(env));
    await wait(() => expect(driver.started).toHaveLength(1));
    f.send(delivery(f.signPeer({
      type: 'task.cancel', task_id: env.task_id, attempt: 1,
    }, { reason: 'user' })));
    await wait(() => expect(f.sent('task.cancel.ack')).toHaveLength(1));
    expect(f.sent('task.fail')).toHaveLength(0);
    expect(driver.stops).toHaveLength(1);
    expect(node.executor.snapshot().slot).toBeNull();
    await wait(() => expect(node.runtime.all()).toHaveLength(0));
  });

  it('expires a stalled run through the lease pump without driver completion', async () => {
    const driver = new StubDriver();
    const f = await fixture({ driver, onFrame: autoStored });
    const node = await f.makeNode();
    await node.start();

    f.send(delivery(f.signPeer({}, { kind: 'aid', summary: 'stalled', lease_ms: 300, offer_ttl_ms: 30_000 })));
    await wait(() => expect(f.sent('task.progress').length).toBeGreaterThanOrEqual(1)); // heartbeats ran
    expect(f.sent('task.progress')[0]!.body.seq).toBe(1);
    await wait(() => expect(f.sent('task.fail')).toHaveLength(1));
    expect(f.sent('task.fail')[0]!.body).toMatchObject({ reason_code: 'other', summary: 'lease_expired' });
    expect(driver.started).toHaveLength(1);
    expect(node.executor.snapshot().slot).toBeNull();
  });

  it('stop() quiesces the live run, flushes the terminal message and closes the store', async () => {
    const driver = new StubDriver();
    const f = await fixture({ driver, onFrame: autoStored });
    const node = await f.makeNode();
    await node.start();
    f.send(delivery(f.signPeer({}, { kind: 'aid', summary: 'shutdown target', lease_ms: 60_000 })));
    await wait(() => expect(driver.started).toHaveLength(1));

    await node.stop();
    expect(f.sent('task.fail').map((env) => env.body.summary)).toEqual(['shutdown']);
    expect(driver.stops).toHaveLength(1);
    // The bounded flush inside stop() observed stored (otherwise task.fail would still be pending
    // and stop() would only resolve after the full shutdown-flush deadline).
    expect(node.client.state).toBe('closed');
    expect(node.store.state).toBe('closed');
    await expect(node.start()).rejects.toThrow();
  });

  it('refuses duplicate or mismatched runtime databases via explicit create/open', async () => {
    const f = await fixture();
    await f.makeNode();
    await expect(f.makeNode()).rejects.toBeInstanceOf(StorageError); // create on existing
    const missing = mkdtempSync(join(tempBase, 'qlong-durable-node-'));
    roots.add(missing);
    await expect(createDurableNode({
      registryUrl: 'http://127.0.0.1:9', gatewayUrl: 'ws://127.0.0.1:9', nodeToken: 't',
      privKey: f.identityKeys.priv,
      storage: { dataDir: join(missing, 'data'), mode: 'open', localFilesystemConfirmed: true },
      identity: f.identity,
    })).rejects.toBeInstanceOf(StorageError); // open on missing
  });

  it('refuses a private key that does not match the registered epoch pubkey', async () => {
    const f = await fixture();
    const stranger = newKeyPair();
    await expect(f.makeNode({ privKey: stranger.priv })).rejects.toThrow('节点身份不匹配');
    await expect(f.makeNode({ privKey: new Uint8Array(16) })).rejects.toThrow('32 字节');
  });

  it('fails closed on a consume COMMIT fault: stops admission and preserves pending', async () => {
    const driver = new StubDriver();
    const f = await fixture({ driver });
    const onFault = vi.fn();
    const node = await f.makeNode({ onFault });
    await node.start();

    const env = f.signPeer({}, { kind: 'aid', summary: 'fault probe', lease_ms: 60_000 });
    expect(node.runtime.receive(env)).toBe('new'); // seeded pending: the consume path is exercised
    const { store } = node.runtime as unknown as { store: SqliteStore };
    // Deferred-FK COMMIT failure on the first consume (same technique as the runtime-store tests).
    store.transaction((db) => db.exec(`
      CREATE TABLE test_parent (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE test_child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL
        REFERENCES test_parent(id) DEFERRABLE INITIALLY DEFERRED) STRICT;
      CREATE TRIGGER test_commit_failure AFTER UPDATE OF decision ON node_inbox
        WHEN NEW.decision = 'applied' BEGIN INSERT INTO test_child VALUES ('failure', 'missing'); END;
    `));
    await expect(node.drain()).rejects.toThrow();
    await wait(() => expect(onFault).toHaveBeenCalledOnce());
    expect(node.client.state).toBe('closed');
    expect(f.sent('task.accept')).toHaveLength(0);
    expect(() => node.executor.snapshot()).toThrow(); // executor refuses further work
    expect(node.store.state).toBe('faulted');
  });
});

describe('DurableNode v2 lead role + persistent projection (B1d)', () => {
  const ledOffer = (over: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ kind: 'aid', summary: 'led task', offer_ttl_ms: 30_000, lease_ms: 60_000, ...over });
  const pendingReports = (node: DurableNode): number =>
    node.runtime.pendingEffects(undefined, true).filter((e) => e.kind === TASK_REPORT_KIND).length;

  it('originates and dispatches a led task through the pump, projecting each revision to the center sink', async () => {
    const reports: TaskReport[] = [];
    const taskReportSink = vi.fn(async (report: TaskReport) => { reports.push(report); return { ok: true, status: 200 }; });
    const f = await fixture({ onFrame: autoStored });
    const node = await f.makeNode({ taskReportSink, validateAcceptance: () => true });
    await node.start();

    const taskId = newId();
    expect(node.lead.originate(taskId, 'aid')).toBe(true);
    expect(node.lead.dispatch(taskId, f.peerId, ledOffer())).toBe(true);

    // The pump seals the offer into the outbox and flushes it to the gateway.
    await wait(() => expect(f.sent('task.offer')).toHaveLength(1));
    expect(f.sent('task.offer')[0]).toMatchObject({ task_id: taskId, attempt: 1, to: { node_id: f.peerId } });
    // The pump's reporter projects the 'offered' revision to the center sink.
    await wait(() => expect(reports.map((r) => r.status)).toContain('offered'));
    expect(reports[0]).toMatchObject({
      task_id: taskId, lead: f.identity.node_id, exec: f.peerId, attempt: 1, status: 'offered', type: 'aid', task_seq: 1,
    });

    // The executor accepts; drain routes the receipt to the lead (not this node's executor).
    f.send(delivery(f.signPeer({ type: 'task.accept', task_id: taskId, attempt: 1 }, { lease_ms: 60_000 })));
    await wait(() => expect(reports.map((r) => r.status)).toContain('running'));
    expect(node.lead.snapshot(taskId)).toMatchObject({ state: 'running', task_seq: 2 });

    // The executor returns a result; the lead projects the terminal 'done' revision, in task_seq order.
    f.send(delivery(f.signPeer({ type: 'task.result', task_id: taskId, attempt: 1 }, { status: 'done', summary: 'ok' })));
    await wait(() => expect(reports.map((r) => r.status)).toContain('done'));
    expect(node.lead.snapshot(taskId)).toMatchObject({ state: 'done', task_seq: 3 });
    expect(reports.map((r) => [r.status, r.task_seq])).toEqual([['offered', 1], ['running', 2], ['done', 3]]);
    // The led task never engaged this node's executor slot.
    expect(node.executor.snapshot().slot).toBeNull();
  });

  it('re-flushes an undelivered lead report across a node restart without fabricating a revision', async () => {
    const delivered: TaskReport[] = [];
    let reachable = false;
    const taskReportSink = vi.fn(async (report: TaskReport) => {
      if (!reachable) return { ok: false, status: 0 }; // center unreachable -> stays pending, never dropped
      delivered.push(report);
      return { ok: true, status: 200 };
    });
    const f = await fixture({ onFrame: autoStored });
    const node = await f.makeNode({ taskReportSink, validateAcceptance: () => true, shutdownFlushMs: 200 });
    await node.start();
    const taskId = newId();
    node.lead.originate(taskId, 'aid');
    node.lead.dispatch(taskId, f.peerId, ledOffer());
    await wait(() => expect(f.sent('task.offer')).toHaveLength(1));
    await wait(() => expect(taskReportSink).toHaveBeenCalled()); // pump tried, center down
    expect(pendingReports(node)).toBe(1); // the 'offered' revision survives as a pending intent
    await node.stop();

    // Reopen the same runtime with the center reachable: the pump re-flushes the persisted revision.
    reachable = true;
    const reopened = await f.makeNode({
      storage: {
        allowedBase: f.root, dataDir: f.dataDir, mode: 'open', filename: 'runtime.sqlite',
        localFilesystemConfirmed: true, windowsAclConfirmed: true, busyTimeoutMs: 25,
      },
      taskReportSink, validateAcceptance: () => true,
    });
    await reopened.start();
    await wait(() => expect(delivered.map((r) => [r.status, r.task_seq])).toEqual([['offered', 1]]));
    expect(reopened.lead.snapshot(taskId)).toMatchObject({ state: 'offered', attempt: 1, target: f.peerId, task_seq: 1 });
    await wait(() => expect(pendingReports(reopened)).toBe(0));
  });
});

describe('DurableNode v2 cross-machine lead takeover (C2d)', () => {
  const ledOffer = (over: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ kind: 'aid', summary: 'led task', offer_ttl_ms: 30_000, lease_ms: 60_000, ...over });

  it('takeover() imports+fences the origin bundle and immediately re-offers at the fenced attempt, without waiting for the periodic pump', async () => {
    // Origin leads a task to 'running' (attempt 1, task_seq 2), then exports a takeover bundle.
    const of = await fixture({ onFrame: autoStored });
    const originSink = vi.fn(async (report: TaskReport) => ({ ok: true, status: 200, report }));
    const origin = await of.makeNode({ taskReportSink: originSink, validateAcceptance: () => true });
    await origin.start();
    const taskId = newId();
    expect(origin.lead.originate(taskId, 'aid')).toBe(true);
    expect(origin.lead.dispatch(taskId, of.peerId, ledOffer())).toBe(true);
    await wait(() => expect(of.sent('task.offer')).toHaveLength(1));
    of.send(delivery(of.signPeer({ type: 'task.accept', task_id: taskId, attempt: 1 }, { lease_ms: 60_000 })));
    await wait(() => expect(origin.lead.snapshot(taskId)).toMatchObject({ state: 'running', attempt: 1, task_seq: 2 }));
    const bundle = origin.lead.exportTasks();

    // A different node takes over. Its periodic pump is suppressed (large tickIntervalMs), so any
    // re-offer / center projection observed below is driven by takeover() itself, not the background tick.
    const EXEC = newId();
    const targetReports: TaskReport[] = [];
    const targetSink = vi.fn(async (report: TaskReport) => { targetReports.push(report); return { ok: true, status: 200 }; });
    const tf = await fixture({ onFrame: autoStored });
    const target = await tf.makeNode({
      taskReportSink: targetSink, validateAcceptance: () => true,
      tickIntervalMs: 60_000, // suppress the periodic pump: isolate takeover's own tick + flush
      selectTarget: () => ({ target: EXEC, offerBody: ledOffer({ summary: 'redispatched' }) }),
    });
    await target.start();

    const result = target.takeover(bundle);
    expect(result.imported).toEqual([taskId]); // in-flight 'running' fenced to attempt 2 drafting, then re-offered
    expect(result.fenced).toEqual([]);
    expect(result.archived).toEqual([]);

    // takeover() immediately re-dispatched (attempt 2 -> 3) and flushed the offer to the gateway.
    await wait(() => expect(tf.sent('task.offer')).toHaveLength(1));
    expect(tf.sent('task.offer')[0]).toMatchObject({ task_id: taskId, attempt: 3, to: { node_id: EXEC } });
    // ...and projected the new 'offered' revision to the center, continuing task_seq from the origin.
    await wait(() => expect(targetReports.map((r) => [r.status, r.attempt, r.task_seq])).toEqual([['offered', 3, 3]]));
    expect(target.lead.snapshot(taskId)).toMatchObject({ state: 'offered', attempt: 3, task_seq: 3 });
    // The taken-over task never engaged this node's executor slot.
    expect(target.executor.snapshot().slot).toBeNull();
  });
});

describe('DurableNode v2 owner command PULL (E3c)', () => {
  const ledOffer = (over: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ kind: 'aid', summary: 'led task', offer_ttl_ms: 30_000, lease_ms: 60_000, ...over });

  // Drive a led task to 'running' (originate → dispatch → peer accept), mirroring the B1d lead-role test.
  async function leadToRunning(node: DurableNode, f: Awaited<ReturnType<typeof fixture>>, taskId: string): Promise<void> {
    node.lead.originate(taskId, 'aid');
    node.lead.dispatch(taskId, f.peerId, ledOffer());
    await wait(() => expect(f.sent('task.offer')).toHaveLength(1));
    f.send(delivery(f.signPeer({ type: 'task.accept', task_id: taskId, attempt: 1 }, { lease_ms: 60_000 })));
    await wait(() => expect(node.lead.snapshot(taskId)).toMatchObject({ state: 'running' }));
  }

  it('pullCommands() applies an owner cancel through lead.cancel (transactional) and acks it once', async () => {
    const f = await fixture({ onFrame: autoStored });
    const center = await startCommandCenter(f.identity.node_id, f.identity.team_id);
    const node = await f.makeNode({ registryUrl: center.url, validateAcceptance: () => true, commandIntervalMs: 0 });
    await node.start();
    const taskId = newId();
    await leadToRunning(node, f, taskId);

    const cmd = center.enqueue(taskId, 'cancel');
    await node.pullCommands();

    // Transactional apply via lead.cancel: the state transition commits synchronously (single-task CAS).
    expect(node.lead.snapshot(taskId)).toMatchObject({ state: 'cancelling' });
    expect(center.acks).toEqual([cmd.id]); // acked exactly once, after the apply committed
    await wait(() => expect(f.sent('task.cancel')).toHaveLength(1)); // pump flushes the sealed cancel
    expect(f.sent('task.cancel')[0]!.body.reason).toBe('user');
  });

  it('pullCommands() applies an owner redispatch through lead.redispatch, excluding the current target, and acks it', async () => {
    const EXEC2 = newId();
    const f = await fixture({ onFrame: autoStored });
    const center = await startCommandCenter(f.identity.node_id, f.identity.team_id);
    const node = await f.makeNode({
      registryUrl: center.url, validateAcceptance: () => true, commandIntervalMs: 0,
      selectTarget: () => ({ target: EXEC2, offerBody: ledOffer({ summary: 'redispatched' }) }),
    });
    await node.start();
    const taskId = newId();
    await leadToRunning(node, f, taskId);

    const cmd = center.enqueue(taskId, 'redispatch');
    await node.pullCommands();

    const snap = node.lead.snapshot(taskId)!;
    expect(snap.state).toBe('reclaiming'); // redispatchByOwner → beginReclaim (transactional)
    expect(snap.excluded[f.peerId]).toBe('once'); // current target excluded so re-dispatch avoids it
    expect(center.acks).toEqual([cmd.id]);
    await wait(() => expect(f.sent('task.cancel')).toHaveLength(1));
    expect(f.sent('task.cancel')[0]!.body.reason).toBe('reclaim');
  });

  it('pullCommands() acks-and-discards a command for a task it does not lead, without faulting the node', async () => {
    const onFault = vi.fn();
    const f = await fixture({ onFrame: autoStored });
    const center = await startCommandCenter(f.identity.node_id, f.identity.team_id);
    const node = await f.makeNode({ registryUrl: center.url, onFault, commandIntervalMs: 0 });
    await node.start();

    // A command for a task never originated here: lead.cancel would throw → checked → fail-close the WHOLE node.
    const foreign = newId();
    const cmd = center.enqueue(foreign, 'cancel');
    await node.pullCommands();

    expect(onFault).not.toHaveBeenCalled(); // ledByUs pre-check avoided routing a stale command into lead.cancel
    expect(node.client.state).not.toBe('closed');
    expect(node.lead.snapshot(foreign)).toBeNull(); // never touched
    expect(center.acks).toEqual([cmd.id]); // stale command discarded (acked) so it is not re-pulled forever
  });

  it('pullCommands() leaves an unacked command pending and re-applies it idempotently (at-least-once)', async () => {
    const f = await fixture({ onFrame: autoStored });
    const center = await startCommandCenter(f.identity.node_id, f.identity.team_id);
    const node = await f.makeNode({ registryUrl: center.url, validateAcceptance: () => true, commandIntervalMs: 0 });
    await node.start();
    const taskId = newId();
    await leadToRunning(node, f, taskId);

    const cmd = center.enqueue(taskId, 'cancel');
    center.setFailAcks(true); // ack lost → the command stays pending at the center (durable until acked)
    await node.pullCommands();
    const first = node.lead.snapshot(taskId)!;
    expect(first.state).toBe('cancelling');
    expect(center.acks).toEqual([]);
    expect(center.pending.map((c) => c.id)).toEqual([cmd.id]); // still pending

    await node.pullCommands(); // re-pull the same pending command → cancelByUser no-ops on 'cancelling'
    const second = node.lead.snapshot(taskId)!;
    expect(second.task_seq).toBe(first.task_seq); // no duplicate revision from the re-apply (idempotent)
    expect(second.state).toBe('cancelling');

    center.setFailAcks(false);
    await node.pullCommands(); // the ack finally lands; the command leaves the pending set
    expect(center.acks).toEqual([cmd.id]);
    expect(center.pending).toEqual([]);
  });

  it('start() wires the command pump so a command enqueued while offline is applied after restart', async () => {
    const f = await fixture({ onFrame: autoStored });
    const center = await startCommandCenter(f.identity.node_id, f.identity.team_id);
    const node = await f.makeNode({ registryUrl: center.url, validateAcceptance: () => true, commandIntervalMs: 0 });
    await node.start();
    const taskId = newId();
    await leadToRunning(node, f, taskId);
    await node.stop();

    // Owner cancels while the node is offline: the command persists at the center (§1.1 durability).
    const cmd = center.enqueue(taskId, 'cancel');
    expect(center.pending.map((c) => c.id)).toEqual([cmd.id]);

    // Restart on the same runtime with the command pump enabled: the periodic pull applies the pending command.
    const reopened = await f.makeNode({
      registryUrl: center.url, validateAcceptance: () => true, commandIntervalMs: 30,
      storage: {
        allowedBase: f.root, dataDir: f.dataDir, mode: 'open', filename: 'runtime.sqlite',
        localFilesystemConfirmed: true, windowsAclConfirmed: true, busyTimeoutMs: 25,
      },
    });
    await reopened.start();
    await wait(() => expect(reopened.lead.snapshot(taskId)).toMatchObject({ state: 'cancelling' }));
    await wait(() => expect(center.acks).toEqual([cmd.id]));
  });

  it('pullCommands() survives a center GET failure without faulting and applies on the next pull', async () => {
    const onFault = vi.fn();
    const f = await fixture({ onFrame: autoStored });
    const center = await startCommandCenter(f.identity.node_id, f.identity.team_id);
    const node = await f.makeNode({ registryUrl: center.url, onFault, validateAcceptance: () => true, commandIntervalMs: 0 });
    await node.start();
    const taskId = newId();
    await leadToRunning(node, f, taskId);

    const cmd = center.enqueue(taskId, 'cancel');
    center.setFailGets(true); // center transiently unavailable
    await node.pullCommands();
    expect(onFault).not.toHaveBeenCalled(); // transport failure is retryable, never a node fault
    expect(node.lead.snapshot(taskId)).toMatchObject({ state: 'running' }); // not applied
    expect(center.pending.map((c) => c.id)).toEqual([cmd.id]);

    center.setFailGets(false);
    await node.pullCommands(); // next pull retries and succeeds
    expect(node.lead.snapshot(taskId)).toMatchObject({ state: 'cancelling' });
    expect(center.acks).toEqual([cmd.id]);
  });
});



