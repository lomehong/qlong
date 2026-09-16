import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { newId, newKeyPair, signEnvelope, validateEnvelope, type EnvelopeV1 } from '@qlong/core';
import { GatewayClient, type GatewayClientOptions } from '../src/gateway-client.js';
import { RemoteNodeSession } from '../src/remote/session.js';

const pair = newKeyPair();
const nodeId = newId();
const teamId = newId();
const clients: GatewayClient[] = [];
const servers: WebSocketServer[] = [];

function envelope(): EnvelopeV1 {
  const env = signEnvelope({
    v: 1, type: 'task.offer', msg_id: newId(), ts: new Date().toISOString(),
    exp: new Date(Date.now() + 60_000).toISOString(),
    from: { node_id: newId(), team_id: teamId, key_epoch: 1 },
    to: { node_id: nodeId, team_id: teamId },
    trace: { trace_id: newId(), parent_span: null, origin_node: nodeId },
    task_id: newId(), attempt: 1, hops: 0,
    body: { kind: 'aid', summary: 'verifier regression', lease_ms: 120000, offer_ttl_ms: 10000 },
  }, pair.priv);
  expect(validateEnvelope(env).ok).toBe(true);
  return env;
}

async function connection(verifyInbound?: GatewayClientOptions['verifyInbound'],
  session?: { verifyInbound?: GatewayClientOptions['verifyInbound'] }) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  await once(server, 'listening');
  let socket: WebSocket | undefined;
  server.on('connection', (ws) => {
    socket = ws;
    ws.once('message', () => ws.send(JSON.stringify({ frame: 'auth_ok' })));
  });
  const address = server.address() as { port: number };
  const client = new GatewayClient({ url: `ws://127.0.0.1:${address.port}`, nodeToken: 'test-only', verifyInbound });
  clients.push(client);
  if (session) new RemoteNodeSession({
    nodeId, teamId, keyEpoch: 1, priv: pair.priv, client, ...session,
  });
  const received = vi.fn();
  client.onEnvelope = received;
  await client.open();
  return { client, received, send: (value: unknown) => socket!.send(JSON.stringify(value)) };
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => {
    for (const ws of s.clients) ws.terminate();
    s.close(() => resolve());
  })));
});

describe('GatewayClient verifier wiring over real WebSocket', () => {
  it('without any verifier rejects instead of delivering', async () => {
    const c = await connection();
    c.send({ frame: 'envelope', envelope: envelope() });
    await vi.waitFor(() => expect(c.client.rejectedInbound).toBe(1));
    expect(c.received).not.toHaveBeenCalled();
  });

  it('session-only verifier is enforced', async () => {
    const verify = vi.fn(async () => false);
    const c = await connection(undefined, { verifyInbound: verify });
    c.send({ frame: 'envelope', envelope: envelope() });
    await vi.waitFor(() => expect(c.client.rejectedInbound).toBe(1));
    expect(verify).toHaveBeenCalledOnce();
    expect(c.received).not.toHaveBeenCalled();
  });

  it('session with no override preserves the client verifier', async () => {
    const verify = vi.fn(async () => true);
    const c = await connection(verify, {});
    expect(c.client.verifyInbound).toBe(verify);
    c.send({ frame: 'envelope', envelope: envelope() });
    await vi.waitFor(() => expect(c.received).toHaveBeenCalledOnce());
    expect(verify).toHaveBeenCalledOnce();
  });

  it('an explicit session override replaces the constructor verifier', async () => {
    const previous = vi.fn(async () => true);
    const override = vi.fn(async () => false);
    const c = await connection(previous, { verifyInbound: override });
    c.send({ frame: 'envelope', envelope: envelope() });
    await vi.waitFor(() => expect(c.client.rejectedInbound).toBe(1));
    expect(previous).not.toHaveBeenCalled();
    expect(override).toHaveBeenCalledOnce();
    expect(c.received).not.toHaveBeenCalled();
  });

  it.each(['throw', 'reject'] as const)('verifier %s fails closed without crashing the connection', async (mode) => {
    const c = await connection(() => {
      if (mode === 'throw') throw new Error('test failure');
      return Promise.reject(new Error('test failure'));
    });
    c.send({ frame: 'envelope', envelope: envelope() });
    await vi.waitFor(() => expect(c.client.rejectedInbound).toBe(1));
    expect(c.received).not.toHaveBeenCalled();
    expect(c.client.state).toBe('authed');
  });

  it('null, arrays and primitives do not crash frame parsing', async () => {
    const c = await connection(async () => true);
    for (const value of [null, [], false, 1, 'invalid']) c.send(value);
    c.send({ frame: 'envelope', envelope: envelope() });
    await vi.waitFor(() => expect(c.received).toHaveBeenCalledOnce());
  });
});