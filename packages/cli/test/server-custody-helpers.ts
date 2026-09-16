import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { expect, vi } from 'vitest';
import {
  CUSTODY_FEATURES, TRANSPORT_VERSION, envelopeDigest, newId, newKeyPair, signEnvelope,
  toBase64, type EnvelopeV1,
} from '@qlong/core';
import { AUTH_KEY } from '../../gateway/src/ws.js';
import { GatewayClient } from '../../node/src/gateway-client.js';
import { createRegistryVerifier, loadRegistryIdentity } from '../../node/src/remote/registry-verifier.js';
import { NODE_SCHEMA } from '../../node/src/runtime/schema.js';
import { NodeRuntimeStore } from '../../node/src/runtime/store.js';
import type { EnrollResult } from '../../registry/src/index.js';
import { SqliteStore } from '../../storage/src/index.js';
import type { ServerHandles } from '../src/server.js';
import { DurableServerFixture, type Owner } from './server-durable-fixtures.js';

export const wait = (check: () => void) => vi.waitFor(check, { timeout: 4_000, interval: 10 });
export interface EnrolledNode {
  credentials: EnrollResult;
  pair: ReturnType<typeof newKeyPair>;
  dataDir: string;
}

const registryUrl = (handles: ServerHandles) => `http://127.0.0.1:${handles.registryPort}`;
const gatewayUrl = (handles: ServerHandles) => `ws://127.0.0.1:${handles.registryPort}${handles.gatewayPath}`;

/** Separate node authorities; the inherited fixture owns and guards deletion of their parent. */
export class CustodyFixture extends DurableServerFixture {
  private readonly clients: GatewayClient[] = [];
  private readonly stores: SqliteStore[] = [];
  private readonly rawSockets: WebSocket[] = [];

  async enrollKey(owner: Owner, teamId: string, label: 'sender' | 'receiver'): Promise<EnrolledNode> {
    const pair = newKeyPair();
    const token = await this.invite(owner, teamId);
    const response = await this.call<EnrollResult>('POST', '/v1/enroll', {
      token, pubkey: toBase64(pair.publicKey), platform: 'fixture/local', qlong_version: 'test',
    });
    expect(response.status).toBe(200);
    expect(typeof response.body.node_token === 'string' && response.body.node_token.length > 0).toBe(true);
    return { pair, credentials: response.body, dataDir: mkdtempSync(join(this.root, `${label}-`)) };
  }

  runtime(node: EnrolledNode, mode: 'create' | 'open' = 'create') {
    const store = SqliteStore.open({
      ...this.options(mode), dataDir: node.dataDir, schema: NODE_SCHEMA, filename: 'node.sqlite',
    });
    this.stores.push(store);
    return { store, runtime: new NodeRuntimeStore(store, node.credentials.node_id) };
  }

  async client(handles: ServerHandles, node: EnrolledNode, runtime?: NodeRuntimeStore) {
    const connection = { registryUrl: registryUrl(handles), nodeToken: node.credentials.node_token };
    const identity = await loadRegistryIdentity(connection);
    expect(identity.node_id === node.credentials.node_id && identity.team_id === node.credentials.team_id &&
      identity.key_epoch === node.credentials.key_epoch && identity.pubkey === toBase64(node.pair.publicKey)).toBe(true);
    const events = { closes: [] as number[], acks: [] as string[], ready: 0, legacy: 0, faults: 0 };
    const client = new GatewayClient({
      url: gatewayUrl(handles), nodeToken: node.credentials.node_token, runtime,
      verifyInbound: createRegistryVerifier(connection, identity),
      handshakeTimeoutMs: 3_000, backoffMs: 5_000,
      onAck: (ack) => { events.acks.push(ack.ack_type); },
      onClose: (code) => { events.closes.push(code); },
      onInboxReady: () => { events.ready += 1; },
      onEnvelope: () => { events.legacy += 1; },
      onFault: () => { events.faults += 1; },
    });
    this.clients.push(client);
    return {
      client, events,
      async close() {
        const connected = client.state === 'authed' || client.state === 'connecting';
        const count = events.closes.length;
        client.close();
        if (connected) await wait(() => expect(events.closes.length > count).toBe(true));
      },
    };
  }

  /** Raw sender is only for replay/conflict injection; never retains auth frames or tickets. */
  async rawSender(handles: ServerHandles, node: EnrolledNode) {
    const socket = new WebSocket(gatewayUrl(handles));
    this.rawSockets.push(socket);
    let authenticated = false;
    let failed = false;
    const replies: Array<{ kind: 'stored' | 'nack' | 'ack'; fromNode: unknown; msgId: unknown;
      digest: unknown; reason: unknown }> = [];
    socket.on('error', () => { failed = true; });
    socket.on('open', () => socket.send(JSON.stringify({
      frame: 'auth', [AUTH_KEY]: node.credentials.node_token,
      transport_version: TRANSPORT_VERSION, features: CUSTODY_FEATURES,
    })));
    socket.on('message', (data) => {
      try {
        const frame = JSON.parse(String(data)) as Record<string, unknown>;
        if (frame.frame === 'auth_ok') authenticated = frame.transport_version === TRANSPORT_VERSION;
        if (frame.frame === 'stored' || frame.frame === 'nack' || frame.frame === 'ack') {
          replies.push({ kind: frame.frame, fromNode: frame.from_node, msgId: frame.msg_id,
            digest: frame.digest, reason: frame.reason });
        }
      } catch { failed = true; }
    });
    await wait(() => { expect(failed).toBe(false); expect(authenticated).toBe(true); });
    return {
      async send(envelope: EnvelopeV1, expected: 'stored' | 'conflict') {
        const cursor = replies.length;
        socket.send(JSON.stringify({ frame: 'envelope', envelope }));
        await wait(() => expect(replies.length > cursor).toBe(true));
        const reply = replies[cursor]!;
        // Only booleans/safe protocol classifications can appear in assertion diagnostics.
        expect(reply.kind === (expected === 'stored' ? 'stored' : 'nack')).toBe(true);
        expect(reply.fromNode === envelope.from.node_id && reply.msgId === envelope.msg_id &&
          reply.digest === envelopeDigest(envelope)).toBe(true);
        if (expected === 'conflict') expect(reply.reason === 'conflict').toBe(true);
      },
      successes: () => replies.filter((reply) => reply.kind === 'stored' || reply.kind === 'ack').length,
      async close() {
        socket.close(1000, 'fixture closing');
        await wait(() => expect(socket.readyState === WebSocket.CLOSED).toBe(true));
      },
    };
  }

  override async dispose(): Promise<void> {
    for (const client of this.clients) client.close();
    for (const socket of this.rawSockets) if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    await this.stop(); // Drain sockets before releasing node ownership or removing any directory.
    for (const store of this.stores) store.close();
    await super.dispose(); // Existing exact-root/prefix guard; never remove ownership files to recover.
  }
}

export async function setup() {
  const f = new CustodyFixture();
  const handles = await f.start('create', { seedTeam: { name: 'custody-team' } });
  const owner = await f.register();
  const teamId = (await f.teams(owner))[0]!.team_id;
  const sender = await f.enrollKey(owner, teamId, 'sender');
  const receiver = await f.enrollKey(owner, teamId, 'receiver');
  expect(sender.dataDir !== receiver.dataDir && sender.dataDir !== f.dataDir && receiver.dataDir !== f.dataDir).toBe(true);
  return { f, handles, owner, teamId, sender, receiver };
}

export function offer(sender: EnrolledNode, receiver: EnrolledNode): EnvelopeV1 {
  const from = sender.credentials;
  const to = receiver.credentials;
  return signEnvelope({
    v: 1, type: 'task.offer', msg_id: newId(), task_id: newId(), attempt: 1, hops: 0,
    ts: new Date().toISOString(), exp: new Date(Date.now() + 120_000).toISOString(),
    from: { node_id: from.node_id, team_id: from.team_id, key_epoch: from.key_epoch },
    to: { node_id: to.node_id, team_id: to.team_id },
    trace: { trace_id: newId(), parent_span: null, origin_node: from.node_id },
    body: { kind: 'project', summary: 'durable custody only', lease_ms: 60_000, offer_ttl_ms: 60_000 },
  }, sender.pair.priv);
}

/** Short-lived read-only business-DB observer, not another SqliteStore/ownership claimant. */
export function inspectSql<T>(path: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 25 });
  try { return read(db); } finally { db.close(); }
}

export function centerView(db: DatabaseSync, envelope: EnvelopeV1) {
  const row = db.prepare(`SELECT status, payload IS NOT NULL AS has_payload, digest = ? AS digest_matches
    FROM gateway_custody WHERE from_node = ? AND msg_id = ?`)
    .get(envelopeDigest(envelope), envelope.from.node_id, envelope.msg_id);
  const totals = db.prepare('SELECT count(*) AS entries, coalesce(sum(payload_bytes), 0) AS bytes FROM gateway_custody').get()!;
  return { status: row?.status, payload: row?.has_payload === 1, digestMatches: row?.digest_matches === 1,
    entries: Number(totals.entries), bytes: Number(totals.bytes) };
}

export const readCenter = (f: DurableServerFixture, envelope: EnvelopeV1) =>
  inspectSql(join(f.dataDir, 'center.sqlite'), (db) => centerView(db, envelope));

/** The INSERT succeeds; only COMMIT fails. Installation/repair uses the sole offline owner. */
export function failCommit(store: SqliteStore, target: 'gateway_custody' | 'node_inbox'): void {
  store.transaction((db) => db.exec(`
    CREATE TABLE fixture_custody_parent (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE fixture_custody_child (id TEXT PRIMARY KEY, parent TEXT NOT NULL
      REFERENCES fixture_custody_parent(id) DEFERRABLE INITIALLY DEFERRED) STRICT;
    CREATE TRIGGER fixture_custody_commit AFTER INSERT ON ${target} BEGIN
      INSERT INTO fixture_custody_child VALUES ('failure', 'missing');
    END;
  `));
}

export function repairCommit(store: SqliteStore): void {
  expect(store.database.prepare('SELECT count(*) AS count FROM fixture_custody_child').get()?.count).toBe(0);
  store.transaction((db) => db.exec('DROP TRIGGER fixture_custody_commit'));
}