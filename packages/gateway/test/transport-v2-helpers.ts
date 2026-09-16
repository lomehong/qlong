import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import {
  CUSTODY_FEATURES, TRANSPORT_VERSION, newId, newKeyPair, signEnvelope,
  type DeliveryFrame, type EnvelopeV1, type ReceiptFrame,
} from '@qlong/core';
import { defineMigration, SqliteStore } from '../../storage/src/index.js';
import { GatewayCore } from '../src/core.js';
import { CUSTODY_SQL, SqliteCustodyStore } from '../src/custody-store.js';
import { AUTH_KEY, WsGateway, type WsGatewayOptions } from '../src/ws.js';
import { waitFor } from './wait.js';

const team = newId();
export const nodes = Array.from({ length: 4 }, (_, index) => ({
  node_id: newId(), team_id: index === 3 ? newId() : team, status: 'active' as const, currentEpoch: 1,
}));
export const source = nodes[0]!;
export const target = nodes[1]!;
export const other = nodes[2]!;
export const foreign = nodes[3]!;
const keys = newKeyPair();
const schema = {
  id: 'qlong.gateway.transport-v2-test',
  migrations: [defineMigration({ version: 1, name: 'custody', sql: CUSTODY_SQL })],
};

export function makeEnvelope(overrides: Partial<EnvelopeV1> = {}): EnvelopeV1 {
  return signEnvelope({
    v: 1, type: 'msg.notify', msg_id: newId(), ts: new Date().toISOString(),
    exp: new Date(Date.now() + 60_000).toISOString(),
    from: { node_id: source.node_id, team_id: source.team_id, key_epoch: 1 },
    to: { node_id: target.node_id, team_id: target.team_id },
    trace: { trace_id: newId(), parent_span: null, origin_node: source.node_id },
    body: { kind: 'aid', text: 'custody fixture' }, ...overrides,
  }, keys.priv);
}

export function receipt(delivery: DeliveryFrame): ReceiptFrame {
  return {
    frame: 'receipt', from_node: delivery.envelope.from.node_id,
    msg_id: delivery.envelope.msg_id, digest: delivery.digest, ticket: delivery.ticket,
  };
}

/** Handcrafted custody-only SQLite schema; no registry/center or GatewayClient dependency. */
export async function fixture(
  gatewayOptions: Partial<WsGatewayOptions> = {},
  custodyOptions: ConstructorParameters<typeof SqliteCustodyStore>[1] = {},
) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'gateway-transport-v2-')));
  const open = (mode: 'create' | 'open'): SqliteStore => SqliteStore.open({
    mode, schema, allowedBase: base, dataDir: join(base, 'data'),
    localFilesystemConfirmed: true, windowsAclConfirmed: true,
  });
  let store = open('create');
  const start = async () => {
    const custody = new SqliteCustodyStore(store, custodyOptions);
    const core = new GatewayCore();
    core.setDirectory({ epoch: 1, nodes });
    const gateway = new WsGateway({
      core, custody, retryIntervalMs: 40,
      // IDs are deliberately non-secret test credentials, never production tokens.
      authenticate: (id) => nodes.find((node) => node.node_id === id), ...gatewayOptions,
    });
    try {
      const port = await gateway.listen();
      return { custody, core, gateway, port };
    } catch (error) {
      await gateway.close();
      throw error;
    }
  };
  let active: Awaited<ReturnType<typeof start>>;
  try { active = await start(); } catch (error) {
    store.close();
    rmSync(base, { recursive: true, force: true });
    throw error;
  }
  return {
    get store() { return store; }, get custody() { return active.custody; },
    get core() { return active.core; }, get gateway() { return active.gateway; }, get port() { return active.port; },
    async reopen() {
      await active.gateway.close();
      store.close();
      store = open('open');
      active = await start();
    },
    async close() {
      await active.gateway.close();
      store.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

export async function rawPeer(f: Awaited<ReturnType<typeof fixture>>) {
  const accepted = new Promise<WebSocket>((resolve) => f.gateway.wss.once('connection', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${f.port}`);
  const opened = once(ws, 'open');
  ws.on('error', () => { /* opened rejects; teardown must not emit an uncaught error. */ });
  const frames: Array<Record<string, unknown>> = [];
  ws.on('message', (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  await opened;
  const serverWs = await accepted;
  const send = (frame: unknown): void => ws.send(JSON.stringify(frame));
  return {
    ws, serverWs, frames, closed, send,
    auth(node = source, fields: Record<string, unknown> = { transport_version: TRANSPORT_VERSION, features: CUSTODY_FEATURES }) {
      send({ frame: 'auth', [AUTH_KEY]: node.node_id, ...fields });
    },
    async frame<T = Record<string, unknown>>(kind: string, after = 0): Promise<T> {
      if (!await waitFor(() => frames.slice(after).some((frame) => frame.frame === kind))) {
        throw new Error(`Missing ${kind} frame`);
      }
      return frames.slice(after).find((frame) => frame.frame === kind) as T;
    },
  };
}

export async function authenticated(f: Awaited<ReturnType<typeof fixture>>, node = source) {
  const peer = await rawPeer(f);
  peer.auth(node);
  await peer.frame('auth_ok');
  return peer;
}