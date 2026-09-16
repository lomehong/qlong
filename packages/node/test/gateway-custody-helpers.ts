import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  CUSTODY_FEATURES, MAX_TRANSPORT_BYTES, envelopeDigest, newId, newKeyPair, signEnvelope, verifyEnvelopeSig,
  type EnvelopeV1,
} from '@qlong/core';
import { SqliteStore, type SqliteStoreOptions } from '../../storage/src/index.js';
import { GatewayClient, type GatewayClientOptions } from '../src/gateway-client.js';
import { NODE_SCHEMA } from '../src/runtime/schema.js';
import { NodeRuntimeStore } from '../src/runtime/store.js';

export const LOCAL = '10000000-0000-4000-8000-000000000001';
export const SENDER = '10000000-0000-4000-8000-000000000002';
const pair = newKeyPair();
const tempBase = realpathSync(tmpdir());
const cleanups: Array<() => Promise<void>> = [];
export const pause = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
export const authOk = { frame: 'auth_ok', transport_version: 2, features: CUSTODY_FEATURES, node_id: LOCAL };
export const write = (ws: WebSocket, frame: unknown): void => ws.send(JSON.stringify(frame));

export function envelope(overrides: Partial<EnvelopeV1> = {}): EnvelopeV1 {
  return signEnvelope({
    v: 1, type: 'task.offer', msg_id: newId(), task_id: newId(), attempt: 1, hops: 0,
    ts: new Date().toISOString(), exp: new Date(Date.now() + 60_000).toISOString(),
    from: { node_id: SENDER, key_epoch: 1 }, to: { node_id: LOCAL },
    trace: { trace_id: newId(), parent_span: null, origin_node: SENDER },
    body: { kind: 'project', description: 'custody test' }, ...overrides,
  }, pair.priv);
}

export const outbound = (overrides: Partial<EnvelopeV1> = {}): EnvelopeV1 => envelope({
  from: { node_id: LOCAL, key_epoch: 1 }, to: { node_id: SENDER }, ...overrides,
});

/** Exact serialized UTF-8 bytes, including JSON escapes rather than only string length. */
export function sizedEnvelope(env: EnvelopeV1, bytes = MAX_TRANSPORT_BYTES): EnvelopeV1 {
  const base = { ...env, body: { padding: '' } };
  const remaining = bytes - Buffer.byteLength(JSON.stringify(base));
  if (remaining < 0) throw new RangeError('Envelope size is smaller than its headers');
  const chunk = '\u0000"\\雪';
  const chunkBytes = Buffer.byteLength(JSON.stringify(chunk)) - 2;
  const padding = chunk.repeat(Math.floor(remaining / chunkBytes)) + 'x'.repeat(remaining % chunkBytes);
  return envelope({ ...base, body: { padding } });
}

export const stored = (env: EnvelopeV1) => ({
  frame: 'stored', from_node: env.from.node_id, msg_id: env.msg_id, digest: envelopeDigest(env),
});
export const delivery = (env: EnvelopeV1, ticket = newId()) => ({
  frame: 'delivery', envelope: env, digest: envelopeDigest(env), ticket,
});

export async function fixture(overrides: Partial<GatewayClientOptions> = {}, options: {
  auth?: (ws: WebSocket, connection: number) => void;
  onFrame?: (frame: Record<string, unknown>, ws: WebSocket) => void;
  limits?: { maxEntries?: number; maxBytes?: number };
} = {}) {
  const root = mkdtempSync(join(tempBase, 'qlong-gateway-custody-'));
  const storeOptions: SqliteStoreOptions = {
    allowedBase: root, dataDir: join(root, 'data'), mode: 'create', schema: NODE_SCHEMA,
    localFilesystemConfirmed: true, windowsAclConfirmed: true, busyTimeoutMs: 25,
  };
  let store = SqliteStore.open(storeOptions);
  const runtime = new NodeRuntimeStore(store, LOCAL, options.limits);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: MAX_TRANSPORT_BYTES + 4_096 });
  const sockets: WebSocket[] = [];
  const frames: Array<Record<string, unknown>> = [];
  // Never retain an auth frame/token in assertions, snapshots or failure output.
  const handshakes: Array<{ transport_version: unknown; features: unknown }> = [];
  const closeCodes: number[] = [];
  let client: GatewayClient | undefined;
  cleanups.push(async () => {
    client?.close();
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    if (dirname(root) !== tempBase || !basename(root).startsWith('qlong-gateway-custody-')) {
      throw new Error('Unsafe gateway test cleanup target');
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  server.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('error', () => {});
    ws.on('close', (code) => closeCodes.push(code));
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      if (frame.frame === 'auth') {
        handshakes.push({ transport_version: frame.transport_version, features: frame.features });
        if (options.auth) options.auth(ws, sockets.length);
        else write(ws, client!.transportVersion === 2 ? authOk : { frame: 'auth_ok' });
      } else {
        frames.push(frame);
        options.onFrame?.(frame, ws);
      }
    });
  });
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  client = new GatewayClient({
    url: `ws://127.0.0.1:${port}`, nodeToken: 'test-only', runtime, backoffMs: 5,
    verifyInbound: async (env) => (await verifyEnvelopeSig(env, () => pair.publicKey)).ok,
    ...overrides,
  });
  return {
    client, runtime, store, server, sockets, frames, handshakes, closeCodes,
    get socket() { return sockets.at(-1)!; },
    send(frame: unknown) { write(sockets.at(-1)!, frame); },
    received(kind: string) { return frames.filter((frame) => frame.frame === kind); },
    reopenRuntime() {
      client!.close();
      store.close();
      store = SqliteStore.open({ ...storeOptions, mode: 'open' });
      return new NodeRuntimeStore(store, LOCAL);
    },
  };
}

/** Actual deferred SQLite COMMIT failure, not a mocked custody implementation. */
export function failCommit(store: SqliteStore, event: 'receive' | 'stored' | 'save'): void {
  const trigger = event === 'receive' ? 'AFTER INSERT ON node_inbox'
    : event === 'save' ? 'AFTER INSERT ON node_outbox' : 'AFTER DELETE ON node_outbox';
  store.transaction((db) => db.exec(`
    CREATE TABLE test_parent (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE test_child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL
      REFERENCES test_parent(id) DEFERRABLE INITIALLY DEFERRED) STRICT;
    CREATE TRIGGER test_commit_failure ${trigger} BEGIN
      INSERT INTO test_child VALUES ('failure', 'missing');
    END;
  `));
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});