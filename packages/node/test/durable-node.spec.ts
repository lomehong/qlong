import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  CUSTODY_FEATURES, MAX_TRANSPORT_BYTES, envelopeDigest, newId, newKeyPair, signEnvelope,
  type EnvelopeV1,
} from '@qlong/core';
import { SqliteStore, StorageError, type SqliteStoreOptions } from '../../storage/src/index.js';
import { NODE_SCHEMA } from '../src/runtime/schema.js';
import { NodeRuntimeStore } from '../src/runtime/store.js';
import { createDurableNode, type DurableNode } from '../src/runtime/node.js';
import { TASK_REPORT_KIND, type TaskReport } from '../src/runtime/report.js';
import type { FencedDriver, RunFence, RunHandle, RunOutcome } from '../src/driver/run-handle.js';

const tempBase = realpathSync(tmpdir());
const roots = new Set<string>();
const nodes = new Set<DurableNode>();
const servers: WebSocketServer[] = [];

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
  readonly started: Array<{ fence: RunFence; offer: Record<string, unknown> }> = [];
  readonly stops: string[] = [];
  private readonly pending = new Map<string, (outcome: RunOutcome) => void>();
  recover = vi.fn(async (): Promise<'stopped' | 'unknown'> => 'unknown');

  start = async (fence: RunFence, offer: Record<string, unknown>): Promise<RunHandle> => {
    this.started.push({ fence, offer });
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



