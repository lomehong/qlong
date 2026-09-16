import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PARAMS, heartbeatIntervalMs, newId, newKeyPair, validateEnvelope } from '@qlong/core';
import { GatewayClient } from '../src/gateway-client.js';
import { RemoteNodeSession } from '../src/remote/session.js';
import { envelope, fixture, LOCAL } from './gateway-custody-helpers.js';

const clients: GatewayClient[] = [];
const sessions: RemoteNodeSession[] = [];
const LEASE_MS = DEFAULT_PARAMS.leaseMsAid;

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const client of clients.splice(0)) client.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('RemoteNodeSession custody boundary', () => {
  it.each([false, true])('rejects a real v2 runtime before rebinding callbacks (override=%s)', async (override) => {
    const onInboxReady = vi.fn();
    const c = await fixture({ onInboxReady });
    const verifier = c.client.verifyInbound;
    const onEnvelope = c.client.onEnvelope;
    const onAck = c.client.onAck;
    const onRoutingDenied = c.client.onRoutingDenied;
    const sessionVerifier = vi.fn(async () => false);
    expect(c.client.transportVersion).toBe(2);
    expect(c.client.outbox === c.runtime).toBe(true);

    expect(() => {
      new RemoteNodeSession({
        nodeId: LOCAL, teamId: newId(), keyEpoch: 1, priv: newKeyPair().priv, client: c.client,
        ...(override ? { verifyInbound: sessionVerifier } : {}),
      });
    }).toThrow('Legacy RemoteNodeSession cannot consume durable inbox; transactional task runtime required');

    // Only compare callback identities/counts, never snapshot a client, options, or signing key.
    expect(c.client.verifyInbound === verifier).toBe(true);
    expect(c.client.onInboxReady === onInboxReady).toBe(true);
    expect(c.client.onEnvelope === onEnvelope).toBe(true);
    expect(c.client.onAck === onAck).toBe(true);
    expect(c.client.onRoutingDenied === onRoutingDenied).toBe(true);
    expect(sessionVerifier).not.toHaveBeenCalled();
    expect(onInboxReady).not.toHaveBeenCalled();
    expect(c.runtime.pending().length).toBe(0);
    expect(c.sockets.length).toBe(0);
  });
});

function legacyHeartbeat() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  const client = new GatewayClient({ url: 'ws://127.0.0.1:9', nodeToken: 'test-only' });
  clients.push(client);
  const send = vi.spyOn(client, 'send').mockResolvedValue('timeout');
  const session = new RemoteNodeSession({
    nodeId: LOCAL, teamId: newId(), keyEpoch: 1, priv: newKeyPair().priv, client,
  });
  sessions.push(session);
  const acked = vi.spyOn(session.exec, 'onHeartbeatAcked');
  const offer = envelope({ body: {
    kind: 'aid', summary: 'heartbeat custody boundary', lease_ms: LEASE_MS,
    offer_ttl_ms: DEFAULT_PARAMS.offerTtlMsAid,
  } });
  expect(validateEnvelope(offer).ok).toBe(true);
  expect(client.transportVersion).toBe(1);
  // Real offer acceptance and timer wiring, with no driver, model, or network send.
  client.onEnvelope(offer);
  expect(session.exec.rec.state).toBe('running');
  expect(send.mock.calls[0]?.[0].type).toBe('task.accept');
  vi.advanceTimersByTime(heartbeatIntervalMs(LEASE_MS));
  const progress = send.mock.calls.map(([env]) => env).find((env) => env.type === 'task.progress');
  expect(progress?.type).toBe('task.progress');
  if (!progress) throw new Error('Expected timer-generated heartbeat');
  expect(progress.task_id).toBe(offer.task_id);
  expect(progress.body.seq).toBe(1);
  expect(acked).not.toHaveBeenCalled();
  expect(client.state).toBe('idle');
  return { client, session, acked, send, progressId: progress.msg_id };
}

describe('legacy session heartbeat ACK compatibility', () => {
  it.each(['queued', 'stored', 'rejected', 'receipt', 'unknown'])(
    '%s cannot renew or consume a matching progress heartbeat', (ack_type) => {
      const { client, session, acked, progressId } = legacyHeartbeat();
      const deadline = session.exec.rec.leaseSelfDeadline;
      client.onAck({ ack_type, msg_id: progressId });
      expect(acked).not.toHaveBeenCalled();
      expect(session.exec.rec.leaseSelfDeadline).toBe(deadline);

      client.onAck({ ack_type: 'delivered', msg_id: progressId });
      expect(acked).toHaveBeenCalledTimes(1);
      expect(acked).toHaveBeenCalledWith(Date.now());
      expect(session.exec.rec.leaseSelfDeadline).toBe(Date.now() + LEASE_MS);
    },
  );

  it('renews only the latest matching delivered progress, once', () => {
    const { client, session, acked, send, progressId } = legacyHeartbeat();
    const deadline = session.exec.rec.leaseSelfDeadline;
    vi.advanceTimersByTime(heartbeatIntervalMs(LEASE_MS));
    const latest = send.mock.calls.map(([env]) => env).filter((env) => env.type === 'task.progress').at(-1);
    expect(latest?.body.seq).toBe(2);
    if (!latest) throw new Error('Expected second timer-generated heartbeat');
    client.onAck({ ack_type: 'delivered', msg_id: newId() });
    client.onAck({ ack_type: 'delivered', msg_id: progressId });
    expect(acked).not.toHaveBeenCalled();
    expect(session.exec.rec.leaseSelfDeadline).toBe(deadline);

    client.onAck({ ack_type: 'delivered', msg_id: latest.msg_id });
    expect(acked).toHaveBeenCalledTimes(1);
    expect(acked).toHaveBeenCalledWith(Date.now());
    expect(session.exec.rec.leaseSelfDeadline).toBe(Date.now() + LEASE_MS);
    client.onAck({ ack_type: 'delivered', msg_id: latest.msg_id });
    expect(acked).toHaveBeenCalledTimes(1);
  });

  it('also gates delivered ACKs on transport version 1 at callback time', () => {
    const { client, session, acked, progressId } = legacyHeartbeat();
    const deadline = session.exec.rec.leaseSelfDeadline;
    // Constructor rejection is tested above; isolate the independent ACK guard here.
    const version = vi.spyOn(client, 'transportVersion', 'get').mockReturnValue(2);
    client.onAck({ ack_type: 'delivered', msg_id: progressId });
    expect(acked).not.toHaveBeenCalled();
    expect(session.exec.rec.leaseSelfDeadline).toBe(deadline);
    version.mockRestore();

    client.onAck({ ack_type: 'delivered', msg_id: progressId });
    expect(acked).toHaveBeenCalledTimes(1);
    expect(acked).toHaveBeenCalledWith(Date.now());
    expect(session.exec.rec.leaseSelfDeadline).toBe(Date.now() + LEASE_MS);
  });
});