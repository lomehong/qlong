import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { CUSTODY_FEATURES, MAX_TRANSPORT_BYTES, type EnvelopeV1 } from '@qlong/core';
import { GatewayClient } from '../src/gateway-client.js';
import {
  authOk, delivery, envelope, failCommit, fixture, outbound, pause, SENDER, sizedEnvelope, stored, write,
} from './gateway-custody-helpers.js';

const wait = (check: () => void) => vi.waitFor(check, { timeout: 2_000, interval: 10 });
// Inspect only lifecycle counts, never the client/options (which contain authentication data).
const waiterCount = (client: GatewayClient): number =>
  (client as unknown as { ackWaiters: Map<string, Set<unknown>> }).ackWaiters.size;
afterEach(() => vi.restoreAllMocks());

describe('GatewayClient transport negotiation', () => {
  it('pins runtime custody and refuses mixed legacy stores', async () => {
    const c = await fixture();
    const options = { url: 'ws://127.0.0.1:9', nodeToken: 'test-only', runtime: c.runtime };
    expect(() => new GatewayClient({ ...options, outbox: c.runtime })).toThrow('cannot be combined');
    expect(() => new GatewayClient({ ...options, dataDir: '' })).toThrow('cannot be combined');
    expect(c.client.outbox === c.runtime).toBe(true);
    expect(c.client.transportVersion).toBe(2);
    const first = c.client.open();
    expect(c.client.open() === first).toBe(true);
    await first;
    await c.client.open();
    expect(c.sockets.length).toBe(1);
    expect(c.handshakes).toEqual([{ transport_version: 2, features: CUSTODY_FEATURES }]);
  });

  it.each([
    { frame: 'auth_ok' },
    { ...authOk, transport_version: 1 },
    { ...authOk, features: ['durable-custody'] },
    { ...authOk, node_id: SENDER },
  ])('fails closed on incompatible auth_ok %# without flushing or retrying', async (response) => {
    const c = await fixture({}, { auth: (ws) => write(ws, response) });
    c.runtime.save({ envelope: outbound(), attempts: 0, lastAt: 0 });
    await expect(c.client.open()).rejects.toThrow();
    await wait(() => expect(c.closeCodes).toEqual([4004]));
    await pause(100);
    expect(c.sockets.length).toBe(1);
    expect(c.received('envelope')).toHaveLength(0);
    expect(c.runtime.all()).toHaveLength(1);
    await expect(c.client.open()).rejects.toThrow('stopped');
  });

  it('legacy mode rejects v2 rather than silently binding a legacy session', async () => {
    const c = await fixture({ runtime: undefined }, { auth: (ws) => write(ws, authOk) });
    expect(c.client.transportVersion).toBe(1);
    await expect(c.client.open()).rejects.toThrow();
    await wait(() => expect(c.closeCodes).toEqual([4004]));
    await pause(100);
    expect(c.sockets.length).toBe(1);
  });

  it('ignores pre-auth custody and delivery frames', async () => {
    const c = await fixture({}, { auth: () => {} });
    const env = outbound();
    c.runtime.save({ envelope: env, attempts: 0, lastAt: 0 });
    const opening = c.client.open();
    await wait(() => expect(c.handshakes).toHaveLength(1));
    c.send(stored(env));
    c.send(delivery(envelope()));
    await pause();
    expect(c.runtime.all()).toHaveLength(1);
    expect(c.runtime.pending()).toHaveLength(0);
    expect(c.received('receipt')).toHaveLength(0);
    c.send(authOk);
    await opening;
    c.send(stored(env));
    await wait(() => expect(c.runtime.all()).toHaveLength(0));
  });

  it.each(['disconnect', 'timeout'] as const)('retries an initial handshake %s', async (mode) => {
    const c = await fixture({ handshakeTimeoutMs: 80 }, {
      auth: (ws, connection) => {
        if (connection > 1) write(ws, authOk);
        else if (mode === 'disconnect') ws.terminate();
      },
    });
    await expect(c.client.open()).rejects.toThrow();
    await wait(() => expect(c.client.state).toBe('authed'));
    expect(c.handshakes).toHaveLength(2);
    await c.client.open();
    expect(c.sockets.length).toBe(2);
  });

  it.each([4000, 4001, 4002, 4003, 4004])('does not reconnect after permanent close %i', async (code) => {
    const c = await fixture({ onClose: () => { throw new Error('observer failure'); } });
    await c.client.open();
    c.socket.close(code, 'test close');
    await wait(() => expect(c.client.state).toBe('closed'));
    await pause(100);
    expect(c.sockets.length).toBe(1);
    await expect(c.client.open()).rejects.toThrow('stopped');
  });

  it('can close a pending handshake and reopen without obsolete promise/socket events winning', async () => {
    const c = await fixture({}, { auth: (ws, connection) => { if (connection > 1) write(ws, authOk); } });
    const first = c.client.open();
    const rejected = expect(first).rejects.toThrow();
    await wait(() => expect(c.handshakes).toHaveLength(1));
    c.client.close();
    const second = c.client.open();
    expect(second === first).toBe(false);
    await Promise.all([rejected, second]);
    await pause();
    expect(c.client.state).toBe('authed');
    expect(c.sockets.length).toBe(2);
  });

  it('does not allow post-auth renegotiation to downgrade custody', async () => {
    const c = await fixture();
    await c.client.open();
    c.send({ frame: 'auth_ok' });
    await wait(() => expect(c.closeCodes).toEqual([4004]));
    expect(c.client.transportVersion).toBe(2);
    await expect(c.client.open()).rejects.toThrow('stopped');
  });
});

describe('GatewayClient sender custody and waiters', () => {
  it('returns persisted stored on a repeated send without resurrecting its payload or waiter', async () => {
    const c = await fixture({}, { onFrame: (frame, ws) => {
      if (frame.frame === 'envelope') write(ws, stored(frame.envelope as EnvelopeV1));
    } });
    const env = outbound();
    await c.client.open();
    expect(await c.client.send(env)).toBe('stored');
    expect(await c.client.send(env)).toBe('stored');
    expect(c.runtime.delivery(env.msg_id)?.status).toBe('stored');
    expect(c.runtime.all()).toHaveLength(0);
    expect(waiterCount(c.client)).toBe(0);
    expect(c.received('envelope')).toHaveLength(1);
    expect(c.reopenRuntime().delivery(env.msg_id)?.status).toBe('stored');
  });

  it('only matching stored commits release; legacy/invalid ACK, denial and NACK retain v2 custody', async () => {
    const c = await fixture();
    const env = outbound();
    let remaining = -1;
    const ack = vi.fn(() => { remaining = c.runtime.all().length; throw new Error('observer failure'); });
    c.client.onAck = ack;
    c.client.onRoutingDenied = () => { throw new Error('observer failure'); };
    await c.client.open();
    const first = c.client.send(env);
    const second = c.client.send(env);
    const short = c.client.send(env, { ackTimeoutMs: 5 });
    for (const ack_type of ['delivered', 'queued', 'rejected', 'stored', 'unknown', null]) {
      c.send({ frame: 'ack', ack_type, msg_id: env.msg_id });
    }
    for (const frame of [
      { frame: 'ack', msg_id: env.msg_id },
      { ...stored(env), digest: '0'.repeat(64) },
      { ...stored(env), from_node: SENDER },
      { ...stored(env), msg_id: 'unknown' },
      { ...stored(env), digest: null },
      { frame: 'routing.denied', msg_id: env.msg_id, rule: 'A1', reason_code: 'acl_rejected' },
      { ...stored(env), frame: 'nack', reason: 'busy', retry_after_ms: 100 },
    ]) c.send(frame);
    expect(await short).toBe('timeout');
    await pause();
    expect(c.runtime.all()).toHaveLength(1);
    expect(ack).not.toHaveBeenCalled();
    expect(waiterCount(c.client)).toBe(1);
    c.send(stored(env));
    expect(await Promise.all([first, second])).toEqual(['stored', 'stored']);
    expect(remaining).toBe(0);
    expect(ack).toHaveBeenCalledWith({ ack_type: 'stored', msg_id: env.msg_id });
    expect(waiterCount(c.client)).toBe(0);
    expect(c.runtime.usage().entries).toBe(1); // Delivery tracking survives payload release.
  });

  it('registers before an immediate receipt and removes timed-out/closed waiters', async () => {
    const c = await fixture({}, { onFrame: (frame, ws) => {
      if (frame.frame === 'envelope') write(ws, stored(frame.envelope as EnvelopeV1));
    } });
    await c.client.open();
    expect(await c.client.send(outbound())).toBe('stored');
    expect(waiterCount(c.client)).toBe(0);
    c.client.close();
    await c.client.open();
    expect(c.client.state).toBe('authed');
    const offline = await fixture();
    const env = outbound();
    expect(await offline.client.send(env, { ackTimeoutMs: 5 })).toBe('timeout');
    expect(waiterCount(offline.client)).toBe(0);
    const first = offline.client.send(env, { ackTimeoutMs: 60_000 });
    const second = offline.client.send(env, { ackTimeoutMs: 60_000 });
    offline.client.close();
    expect(await Promise.all([first, second])).toEqual(['timeout', 'timeout']);
    expect(waiterCount(offline.client)).toBe(0);
    expect(offline.runtime.all()).toHaveLength(1);
  });

  it('detaches waiter identity from subsequent caller mutations', async () => {
    const c = await fixture();
    const env = outbound();
    const originalId = env.msg_id;
    const receipt = c.client.send(env, { ackTimeoutMs: 5 });
    env.msg_id = outbound().msg_id;
    expect(await receipt).toBe('timeout');
    expect(waiterCount(c.client)).toBe(0);
    expect(c.runtime.all()[0]!.envelope.msg_id).toBe(originalId);
  });

  it('keeps legacy ACK validation and transient rejection retention', async () => {
    const c = await fixture({ runtime: undefined });
    await c.client.open();
    for (const reason of ['internal_error', 'cluster_error']) {
      const env = outbound();
      const receipt = c.client.send(env);
      c.send({ frame: 'ack', ack_type: 'unknown', msg_id: env.msg_id });
      c.send({ frame: 'routing.denied', msg_id: env.msg_id, rule: 1 });
      await pause();
      expect(c.client.outbox.all().some((entry) => entry.envelope.msg_id === env.msg_id)).toBe(true);
      c.send({ frame: 'ack', ack_type: 'rejected', reason, msg_id: env.msg_id });
      expect(await receipt).toBe('rejected');
      expect(c.client.outbox.all().some((entry) => entry.envelope.msg_id === env.msg_id)).toBe(true);
      c.send({ frame: 'ack', ack_type: 'delivered', msg_id: env.msg_id });
      await wait(() => expect(c.client.outbox.all()).toHaveLength(0));
    }
  });

  it('faults without releasing custody on an actual stored COMMIT failure', async () => {
    const fault = vi.fn(() => { throw new Error('observer failure'); });
    const ack = vi.fn();
    const c = await fixture({ onFault: fault, onAck: ack });
    await c.client.open();
    const env = outbound();
    const receipt = c.client.send(env);
    failCommit(c.store, 'stored');
    c.send(stored(env));
    expect(await receipt).toBe('timeout');
    await wait(() => expect(c.closeCodes).toEqual([1011]));
    expect(fault).toHaveBeenCalledWith();
    expect(ack).not.toHaveBeenCalled();
    expect(c.store.state).toBe('faulted');
    await pause(100);
    expect(c.sockets.length).toBe(1);
    await expect(c.client.send(outbound())).rejects.toThrow('storage unavailable');
    await expect(c.client.open()).rejects.toThrow('stopped');
    expect(c.reopenRuntime().all()).toHaveLength(1);
  });

  it.each(['FULL', 'CONFLICT'] as const)('rejects %s admission without stopping the committed outbox', async (code) => {
    const fault = vi.fn();
    const c = await fixture({ onFault: fault }, { limits: code === 'FULL' ? { maxEntries: 2 } : undefined });
    await c.client.open();
    const env = outbound();
    c.runtime.save({ envelope: env, attempts: 0, lastAt: 0 });
    const rejected = code === 'FULL' ? outbound() : outbound({ ...env, body: { conflict: true } });
    await expect(c.client.send(rejected)).rejects.toMatchObject({
      name: 'RuntimeStoreError', code,
      message: code === 'FULL' ? 'gateway outbox capacity exhausted' : 'gateway outbound message identity conflict',
    });
    expect(waiterCount(c.client)).toBe(0);
    expect(c.client.state).toBe('authed');
    expect(c.store.state).not.toBe('faulted');
    expect(c.runtime.all()).toHaveLength(1);
    await wait(() => expect(c.received('envelope')).toHaveLength(1));
    expect((c.received('envelope')[0]!.envelope as EnvelopeV1).msg_id).toBe(env.msg_id);
    c.send(stored(env));
    await wait(() => expect(c.runtime.all()).toHaveLength(0));
    await c.client.open();
    expect(c.sockets.length).toBe(1);
    expect(c.closeCodes).toHaveLength(0);
    expect(fault).not.toHaveBeenCalled();
  });
});

describe('GatewayClient receiver custody', () => {
  it('notifies pending committed inbox work on authentication after restart without legacy delivery', async () => {
    const ready = vi.fn(() => { throw new Error('observer failure'); });
    const legacy = vi.fn();
    const c = await fixture();
    const env = envelope();
    expect(c.runtime.receive(env)).toBe('new');
    const runtime = c.reopenRuntime();
    const { port } = c.server.address() as { port: number };
    const restarted = new GatewayClient({
      url: `ws://127.0.0.1:${port}`, nodeToken: 'test-only', runtime,
      onInboxReady: ready, onEnvelope: legacy,
    });
    try {
      expect(ready).not.toHaveBeenCalled();
      await restarted.open();
      expect(ready).toHaveBeenCalledOnce();
      expect(ready).toHaveBeenCalledWith();
      expect(runtime.pending()).toEqual([env]);
      expect(legacy).not.toHaveBeenCalled();
      expect(c.received('receipt')).toHaveLength(0);
      expect(restarted.state).toBe('authed');
    } finally { restarted.close(); }
  });

  it('commits before receipt, re-receipts duplicates and never dispatches a legacy handler', async () => {
    const legacy = vi.fn();
    const ready = vi.fn(() => { throw new Error('observer failure'); });
    const c = await fixture({ onEnvelope: legacy, onInboxReady: ready });
    await c.client.open();
    const env = envelope();
    const frame = delivery(env);
    c.send(frame);
    await wait(() => expect(c.received('receipt')).toHaveLength(1));
    expect(c.runtime.pending()).toEqual([env]);
    const expected = { ...stored(env), frame: 'receipt', ticket: frame.ticket };
    expect(c.received('receipt')[0]).toEqual(expected);
    c.send(frame);
    c.send(delivery(env, 'replacement-ticket'));
    await wait(() => expect(c.received('receipt')).toHaveLength(3));
    expect(c.received('receipt')[1]).toEqual(expected);
    expect(c.received('receipt')[2]).toEqual({ ...expected, ticket: 'replacement-ticket' });
    expect(ready).toHaveBeenCalledOnce();
    expect(legacy).not.toHaveBeenCalled();
    expect(c.reopenRuntime().pending()).toEqual([env]);
  });

  it.each(['missing', 'false', 'throw', 'reject'] as const)('fails closed for verifier %s', async (mode) => {
    const c = await fixture({ verifyInbound: mode === 'missing' ? undefined : () => {
      if (mode === 'throw') throw new Error('verification failed');
      if (mode === 'reject') return Promise.reject(new Error('verification failed'));
      return Promise.resolve(false);
    } });
    await c.client.open();
    c.send(delivery(envelope()));
    await wait(() => expect(c.client.rejectedInbound).toBe(1));
    expect(c.runtime.pending()).toHaveLength(0);
    expect(c.received('receipt')).toHaveLength(0);
    expect(c.client.state).toBe('authed');
  });

  it('rejects malformed identities, tickets, targets, signatures and conflicting content', async () => {
    const c = await fixture();
    await c.client.open();
    const env = envelope();
    const good = delivery(env);
    const badSig = { ...env, body: { changed: true } };
    const invalid = [
      { ...good, envelope: null }, { ...good, digest: '0'.repeat(64) },
      { ...good, ticket: '' }, { ...good, ticket: 'x'.repeat(129) }, { ...good, ticket: 1 },
      delivery(envelope({ to: { node_id: SENDER } })), delivery(badSig),
    ];
    for (const frame of invalid) c.send(frame);
    await wait(() => expect(c.client.rejectedInbound).toBe(invalid.length));
    expect(c.runtime.pending()).toHaveLength(0);
    expect(c.received('receipt')).toHaveLength(0);
    c.send(good);
    await wait(() => expect(c.received('receipt')).toHaveLength(1));
    c.send(delivery(envelope({ ...env, body: { conflict: true } })));
    await wait(() => expect(c.client.rejectedInbound).toBe(invalid.length + 1));
    expect(c.runtime.pending()).toEqual([env]);
    expect(c.received('receipt')).toHaveLength(1);
  });

  it('serializes at most 16 admitted verifications and uses the live verifier for queued work', async () => {
    let release!: (ok: boolean) => void;
    const firstVerifier = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));
    const nextVerifier = vi.fn(async () => true);
    const c = await fixture({ verifyInbound: firstVerifier });
    await c.client.open();
    for (let index = 0; index < 20; index += 1) c.send(delivery(envelope()));
    await wait(() => expect(c.client.rejectedInbound).toBe(4));
    expect(firstVerifier).toHaveBeenCalledOnce();
    expect(c.runtime.pending()).toHaveLength(0);
    c.client.verifyInbound = nextVerifier;
    release(true);
    await wait(() => expect(c.received('receipt')).toHaveLength(16));
    expect(nextVerifier).toHaveBeenCalledTimes(15);
    expect(c.runtime.pending()).toHaveLength(16);
  });

  it('fences verification results and queued deliveries from an obsolete socket', async () => {
    let release!: (ok: boolean) => void;
    const verifier = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));
    const c = await fixture({ verifyInbound: verifier });
    await c.client.open();
    c.send(delivery(envelope()));
    c.send(delivery(envelope()));
    await wait(() => expect(verifier).toHaveBeenCalledOnce());
    c.socket.terminate();
    await wait(() => { expect(c.sockets.length).toBe(2); expect(c.client.state).toBe('authed'); });
    c.client.verifyInbound = async () => true;
    const current = envelope();
    c.send(delivery(current));
    release(true);
    await wait(() => expect(c.received('receipt')).toHaveLength(1));
    expect(c.runtime.pending()).toEqual([current]);
    expect(c.client.state).toBe('authed');
  });

  it('stops after one verifier timeout across reconnect without a storage fault or late callbacks', async () => {
    let release!: (ok: boolean) => void;
    const verifier = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));
    const fault = vi.fn();
    const ready = vi.fn();
    const legacy = vi.fn();
    const closed = vi.fn();
    const c = await fixture({
      verifyInbound: verifier, verifyTimeoutMs: 500, onFault: fault,
      onInboxReady: ready, onEnvelope: legacy, onClose: closed,
    });
    await c.client.open();
    c.send(delivery(envelope()));
    c.send(delivery(envelope()));
    await wait(() => expect(verifier).toHaveBeenCalledOnce());
    c.socket.terminate();
    await wait(() => { expect(c.sockets.length).toBe(2); expect(c.client.state).toBe('authed'); });
    c.send(delivery(envelope()));
    await wait(() => {
      expect(c.closeCodes).toContain(1011);
      expect(closed).toHaveBeenCalledWith(1011);
    });
    expect(c.client.rejectedInbound).toBe(1);
    expect(c.client.state).toBe('closed');
    await expect(c.client.open()).rejects.toThrow('stopped');
    release(true);
    await pause(100);
    expect(verifier).toHaveBeenCalledOnce();
    expect(c.sockets.length).toBe(2);
    expect(c.runtime.pending()).toHaveLength(0);
    expect(c.received('receipt')).toHaveLength(0);
    expect(ready).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
    expect(fault).not.toHaveBeenCalled();
    expect(c.store.state).not.toBe('faulted');
  });

  it('clears the deadline after verification resolves', async () => {
    const c = await fixture({ verifyInbound: async () => true, verifyTimeoutMs: 50 });
    await c.client.open();
    c.send(delivery(envelope()));
    await wait(() => expect(c.received('receipt')).toHaveLength(1));
    await pause(100);
    expect(c.client.state).toBe('authed');
    expect(c.closeCodes).toHaveLength(0);
    expect(c.client.rejectedInbound).toBe(0);
  });

  it('does not receipt a full inbox', async () => {
    const c = await fixture({}, { limits: { maxEntries: 0 } });
    await c.client.open();
    c.send(delivery(envelope()));
    await wait(() => expect(c.client.rejectedInbound).toBe(1));
    expect(c.runtime.pending()).toHaveLength(0);
    expect(c.received('receipt')).toHaveLength(0);
  });

  it('stops admission without receipt after an actual receive COMMIT failure', async () => {
    const fault = vi.fn();
    const ready = vi.fn();
    const c = await fixture({ onFault: fault, onInboxReady: ready });
    await c.client.open();
    failCommit(c.store, 'receive');
    c.send(delivery(envelope()));
    c.send(delivery(envelope()));
    await wait(() => expect(c.closeCodes).toEqual([1011]));
    expect(fault).toHaveBeenCalledOnce();
    expect(fault).toHaveBeenCalledWith();
    expect(ready).not.toHaveBeenCalled();
    expect(c.store.state).toBe('faulted');
    expect(c.received('receipt')).toHaveLength(0);
    await pause(100);
    expect(c.sockets.length).toBe(1);
    expect(c.reopenRuntime().pending()).toHaveLength(0);
  });
});

describe('GatewayClient bounded live retry', () => {
  it('discovers runtime outbox commits while already authenticated and idle', async () => {
    const c = await fixture();
    await c.client.open();
    const env = outbound();
    c.runtime.save({ envelope: env, attempts: 0, lastAt: 0 });
    await wait(() => expect(c.received('envelope')).toHaveLength(1));
    expect(c.runtime.all()[0]!.attempts).toBe(1);
    expect(c.sockets.length).toBe(1);
  });

  it('limits each window to 16 sends and rotates past older failures to unsent messages', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const c = await fixture();
    const old = Array.from({ length: 16 }, () => outbound());
    const fresh = Array.from({ length: 16 }, () => outbound());
    for (const env of old) c.runtime.save({ envelope: env, attempts: 5, lastAt: now - 10_000 });
    for (const env of fresh) c.runtime.save({ envelope: env, attempts: 0, lastAt: 0 });
    await c.client.open();
    for (let index = 0; index < 32; index += 1) c.client.flush();
    await wait(() => expect(c.received('envelope')).toHaveLength(16));
    expect(c.received('envelope').map((frame) => (frame.envelope as EnvelopeV1).msg_id))
      .toEqual(fresh.map((env) => env.msg_id));
    expect(c.runtime.all().filter((entry) => entry.lastAt === now)).toHaveLength(16);
    now += 100;
    await wait(() => expect(c.received('envelope')).toHaveLength(32));
    expect(c.received('envelope').slice(16).map((frame) => (frame.envelope as EnvelopeV1).msg_id))
      .toEqual(old.map((env) => env.msg_id));
    expect(c.runtime.all().slice(0, 16).map((entry) => entry.attempts)).toEqual(Array(16).fill(6));
    expect(c.sockets.length).toBe(1);
  });

  it('keeps retrying after waiter timeout, persists attempts, and retains expired payload/tracking', async () => {
    const c = await fixture();
    const env = outbound();
    await c.client.open();
    expect(await c.client.send(env, { ackTimeoutMs: 5 })).toBe('timeout');
    await wait(() => expect(c.received('envelope').length).toBeGreaterThanOrEqual(2));
    expect(c.runtime.all()[0]!.attempts).toBeGreaterThanOrEqual(2);
    expect(c.runtime.all()[0]!.lastAt).toBeGreaterThan(0);
    expect(c.sockets.length).toBe(1);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(env.exp!) + 1);
    c.client.flush();
    const count = c.received('envelope').length;
    const persisted = c.runtime.all();
    await pause(250);
    expect(c.received('envelope')).toHaveLength(count);
    expect(c.runtime.all()).toEqual(persisted);
    expect(c.runtime.usage().entries).toBe(2);
    expect(c.reopenRuntime().all()).toEqual(persisted);
  });

  it('clamps NACK retry_after and recomputes persisted backoff after reconnect', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const c = await fixture();
    const env = outbound();
    await c.client.open();
    expect(await c.client.send(env, { ackTimeoutMs: 5 })).toBe('timeout');
    await wait(() => expect(c.received('envelope')).toHaveLength(1));
    c.send({ ...stored(env), frame: 'nack', reason: 'busy', retry_after_ms: Number.MAX_SAFE_INTEGER });
    c.send(delivery(envelope())); // Receipt is a barrier after processing the NACK.
    await wait(() => expect(c.received('receipt')).toHaveLength(1));
    now += 4_999;
    c.client.flush();
    await pause();
    expect(c.received('envelope')).toHaveLength(1);
    now += 1;
    c.client.flush();
    await wait(() => expect(c.received('envelope')).toHaveLength(2));
    c.send({ ...stored(env), frame: 'nack', reason: 'busy', retry_after_ms: -1_000 });
    c.send(delivery(envelope()));
    await wait(() => expect(c.received('receipt')).toHaveLength(2));
    const retryNotBefore = (c.client as unknown as { retryNotBefore: Map<string, number> }).retryNotBefore;
    expect(retryNotBefore.get(env.msg_id)).toBe(now + 100);
    c.send({ ...stored(env), frame: 'nack', reason: 'busy', retry_after_ms: Number.MAX_SAFE_INTEGER });
    c.send(delivery(envelope()));
    await wait(() => expect(c.received('receipt')).toHaveLength(3));
    expect(retryNotBefore.get(env.msg_id)).toBe(now + 5_000);
    c.socket.terminate();
    await wait(() => { expect(c.sockets.length).toBe(2); expect(c.client.state).toBe('authed'); });
    expect(retryNotBefore.size).toBe(0);
    now += 200; // Persisted attempts=2 still enforces the normal exponential backoff.
    c.client.flush();
    await wait(() => expect(c.received('envelope')).toHaveLength(3));
    expect(c.runtime.all()).toHaveLength(1);
  });

  it('pauses at socket backpressure and resumes without dropping the durable outbox', async () => {
    const c = await fixture();
    await c.client.open();
    const socket = (c.client as unknown as { ws: WebSocket }).ws;
    const pressure = vi.spyOn(socket, 'bufferedAmount', 'get').mockReturnValue(MAX_TRANSPORT_BYTES * 4);
    expect(await c.client.send(outbound(), { ackTimeoutMs: 5 })).toBe('timeout');
    expect(c.received('envelope')).toHaveLength(0);
    expect(c.runtime.all()[0]!.attempts).toBe(0);
    pressure.mockRestore();
    await wait(() => expect(c.received('envelope')).toHaveLength(1));
    expect(c.runtime.all()[0]!.attempts).toBe(1);
  });

  it.each(['send', 'runtime'] as const)('transports maximum escaped envelope bytes bidirectionally via %s', async (source) => {
    const c = await fixture({}, { onFrame: (frame, ws) => {
      if (frame.frame === 'envelope') write(ws, stored(frame.envelope as EnvelopeV1));
    } });
    const outgoing = sizedEnvelope(outbound());
    const incoming = sizedEnvelope(envelope());
    for (const env of [outgoing, incoming]) expect(Buffer.byteLength(JSON.stringify(env))).toBe(MAX_TRANSPORT_BYTES);
    for (const frame of [{ frame: 'envelope', envelope: outgoing }, delivery(incoming)]) {
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeGreaterThan(MAX_TRANSPORT_BYTES);
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(MAX_TRANSPORT_BYTES + 4_096);
    }
    await c.client.open();
    if (source === 'send') expect(await c.client.send(outgoing)).toBe('stored');
    else {
      c.runtime.save({ envelope: outgoing, attempts: 0, lastAt: 0 });
      c.client.flush();
    }
    await wait(() => expect(c.received('envelope')).toHaveLength(1));
    await wait(() => expect(c.runtime.all()).toHaveLength(0));
    expect(Buffer.byteLength(JSON.stringify(c.received('envelope')[0]!.envelope))).toBe(MAX_TRANSPORT_BYTES);
    c.send(delivery(incoming));
    await wait(() => expect(c.received('receipt')).toHaveLength(1));
    expect(c.runtime.pending().map((env) => env.msg_id)).toEqual([incoming.msg_id]);
    expect(c.client.state).toBe('authed');
    expect(c.closeCodes).toHaveLength(0);
  });

  it('bounds envelope bytes separately from the inbound WebSocket framing allowance', async () => {
    const verifier = vi.fn(async () => true);
    const fault = vi.fn();
    const c = await fixture({ verifyInbound: verifier, onFault: fault });
    await c.client.open();
    await expect(c.client.send(sizedEnvelope(outbound(), MAX_TRANSPORT_BYTES + 1)))
      .rejects.toThrow('transport byte limit');
    expect(c.runtime.all()).toHaveLength(0);
    c.send(delivery(sizedEnvelope(envelope(), MAX_TRANSPORT_BYTES + 1)));
    await wait(() => expect(c.client.rejectedInbound).toBe(1));
    expect(c.client.state).toBe('authed');
    expect(fault).not.toHaveBeenCalled();
    c.send({ frame: 'delivery', large: 'x'.repeat(MAX_TRANSPORT_BYTES + 4_096) });
    await wait(() => expect(c.closeCodes).toHaveLength(1));
    expect(verifier).not.toHaveBeenCalled();
    expect(c.runtime.pending()).toHaveLength(0);
    expect(c.received('receipt')).toHaveLength(0);
  });

  it('stops on an actual outbox save COMMIT failure instead of admitting unpersisted sends', async () => {
    const fault = vi.fn();
    const c = await fixture({ onFault: fault });
    await c.client.open();
    failCommit(c.store, 'save');
    await expect(c.client.send(outbound())).rejects.toThrow('storage unavailable');
    await wait(() => expect(c.closeCodes).toEqual([1011]));
    expect(c.received('envelope')).toHaveLength(0);
    expect(waiterCount(c.client)).toBe(0);
    expect(fault).toHaveBeenCalledOnce();
    expect(c.store.state).toBe('faulted');
    expect(c.reopenRuntime().all()).toHaveLength(0);
  });
});