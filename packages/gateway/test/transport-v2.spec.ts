import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CUSTODY_FEATURES, TRANSPORT_VERSION, MAX_TRANSPORT_BYTES, envelopeDigest, newId,
  type DeliveryFrame, type StoredFrame, type TransportNack,
} from '@qlong/core';
import { WsGateway, type WsGatewayOptions } from '../src/ws.js';
import {
  authenticated, fixture, foreign, makeEnvelope, nodes, other, rawPeer, receipt, source, target,
} from './transport-v2-helpers.js';
import { waitFor } from './wait.js';

const fixtures: Array<Awaited<ReturnType<typeof fixture>>> = [];
async function setup(...args: Parameters<typeof fixture>) {
  const f = await fixture(...args);
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((f) => f.close()));
});

describe('transport v2 durable gateway (raw WS and real SQLite)', () => {
  it.each([false, true])('retains %s-online delivery through send and SQLite reopen until receipt', async (online) => {
    const f = await setup();
    const legacyRoute = vi.spyOn(f.core, 'uplink');
    const legacyDrain = vi.spyOn(f.core, 'takeInbox');
    const sender = await authenticated(f);
    const receiver = online ? await authenticated(f, target) : undefined;
    const envelope = makeEnvelope(); // aid is also durable, including offline.
    sender.send({ frame: 'envelope', envelope });
    expect(await sender.frame<StoredFrame>('stored')).toEqual({
      frame: 'stored', from_node: source.node_id, msg_id: envelope.msg_id, digest: envelopeDigest(envelope),
    });
    const sent = receiver ? await receiver.frame<DeliveryFrame>('delivery') : undefined;
    expect(f.custody.outcome(source.node_id, envelope.msg_id)?.status).toBe('pending');
    expect(f.custody.pending(target.node_id, Date.now(), 16).length).toBe(1);
    expect(legacyRoute).not.toHaveBeenCalled();
    expect(legacyDrain).not.toHaveBeenCalled();
    await f.reopen();

    const replay = await authenticated(f, target);
    const delivery = await replay.frame<DeliveryFrame>('delivery');
    expect(replay.frames[0]?.frame).toBe('auth_ok');
    expect(replay.frames[0]?.transport_version).toBe(TRANSPORT_VERSION);
    expect(replay.frames[0]?.features).toEqual(CUSTODY_FEATURES);
    expect(delivery.envelope).toEqual(envelope);
    expect(sent === undefined || sent.ticket !== delivery.ticket).toBe(true);
    expect(f.custody.outcome(source.node_id, envelope.msg_id)?.status).toBe('pending');
    replay.send(receipt(delivery));
    expect(await waitFor(() => f.custody.outcome(source.node_id, envelope.msg_id)?.status === 'received')).toBe(true);
    expect(f.custody.pending(target.node_id, Date.now(), 16)).toHaveLength(0);

    await f.reopen();
    expect(f.custody.outcome(source.node_id, envelope.msg_id)?.status).toBe('received');
    const retryingSource = await authenticated(f);
    const finalReceiver = await authenticated(f, target);
    retryingSource.send({ frame: 'envelope', envelope });
    await retryingSource.frame('stored'); // lost stored ACK is idempotent after receipt/reopen.
    expect(f.custody.pending(target.node_id, Date.now(), 16)).toHaveLength(0);
    expect(finalReceiver.frames.some((frame) => frame.frame === 'delivery')).toBe(false);
  });

  it('retries an unreceipted delivery on the same connection using the same ticket', async () => {
    const f = await setup();
    const sender = await authenticated(f);
    const receiver = await authenticated(f, target);
    const envelope = makeEnvelope();
    sender.send({ frame: 'envelope', envelope });
    const first = await receiver.frame<DeliveryFrame>('delivery');
    const cursor = receiver.frames.length;
    const retried = await receiver.frame<DeliveryFrame>('delivery', cursor);
    // Boolean comparisons keep bearer-like receipt tickets out of assertion output.
    expect(retried.ticket === first.ticket).toBe(true);
    expect(retried.digest).toBe(first.digest);
    expect(receiver.ws.readyState).toBe(1);
    expect(f.custody.outcome(source.node_id, envelope.msg_id)?.status).toBe('pending');
    receiver.send(receipt(retried));
    expect(await waitFor(() => f.custody.outcome(source.node_id, envelope.msg_id)?.status === 'received')).toBe(true);
  });

  it('binds receipts to sender, message, digest, target and current connection; duplicates are harmless', async () => {
    const f = await setup();
    const acknowledge = vi.spyOn(f.custody, 'acknowledge');
    const sender = await authenticated(f);
    const old = await authenticated(f, target);
    const attacker = await authenticated(f, other);
    const envelope = makeEnvelope();
    sender.send({ frame: 'envelope', envelope });
    const first = await old.frame<DeliveryFrame>('delivery');
    const oldReceipt = receipt(first);
    // A different authenticated principal cannot use even an exact captured ticket.
    attacker.send(oldReceipt);
    attacker.send({ frame: 'envelope', envelope: makeEnvelope({ from: { node_id: other.node_id, key_epoch: 1 } }) });
    await attacker.frame('stored'); // same-socket barrier proves the prior receipt was processed.
    expect(acknowledge).not.toHaveBeenCalled();

    for (const forged of [
      { ...oldReceipt, from_node: other.node_id }, { ...oldReceipt, msg_id: newId() },
      { ...oldReceipt, digest: '0'.repeat(64) }, { ...oldReceipt, ticket: 'not-a-ticket' },
    ]) old.send(forged);
    old.send({ frame: 'envelope', envelope: makeEnvelope({ from: { node_id: target.node_id, key_epoch: 1 }, to: { node_id: other.node_id } }) });
    await old.frame('stored');
    expect(acknowledge).not.toHaveBeenCalled();
    const unauthenticated = await rawPeer(f);
    unauthenticated.send(oldReceipt);
    expect((await unauthenticated.closed).code).toBe(4003);

    const replacement = await authenticated(f, target);
    const fresh = await replacement.frame<DeliveryFrame>('delivery');
    expect((await old.closed).code).toBe(4000);
    expect(fresh.ticket !== first.ticket).toBe(true);
    replacement.send(oldReceipt);
    replacement.send({ frame: 'envelope', envelope: makeEnvelope({ from: { node_id: target.node_id, key_epoch: 1 }, to: { node_id: other.node_id } }) });
    await replacement.frame('stored');
    expect(acknowledge).not.toHaveBeenCalled();
    expect(f.custody.outcome(source.node_id, envelope.msg_id)?.status).toBe('pending');

    replacement.send(receipt(fresh));
    replacement.send(receipt(fresh));
    expect(await waitFor(() => f.custody.outcome(source.node_id, envelope.msg_id)?.status === 'received')).toBe(true);
    const cursor = replacement.frames.length;
    replacement.send({ frame: 'envelope', envelope: makeEnvelope({ from: { node_id: target.node_id, key_epoch: 1 }, to: { node_id: other.node_id } }) });
    await replacement.frame('stored', cursor);
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it('caps pending batches and inflight tickets at 16, then refills only after receipt', async () => {
    const f = await setup();
    const pending = vi.spyOn(f.custody, 'pending');
    const sender = await authenticated(f);
    const receiver = await authenticated(f, target);
    for (let i = 0; i < 19; i++) sender.send({ frame: 'envelope', envelope: makeEnvelope() });
    expect(await waitFor(() => sender.frames.filter((frame) => frame.frame === 'stored').length === 19)).toBe(true);
    const deliveredIds = (): Set<string> => new Set(receiver.frames
      .filter((frame) => frame.frame === 'delivery')
      .map((frame) => (frame as unknown as DeliveryFrame).envelope.msg_id));
    expect(await waitFor(() => deliveredIds().size === 16)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(deliveredIds().size).toBe(16);
    expect(pending.mock.calls.every((call) => call[2] <= 16)).toBe(true);
    const first = await receiver.frame<DeliveryFrame>('delivery');
    receiver.send(receipt(first));
    expect(await waitFor(() => deliveredIds().size === 17)).toBe(true);
  });

  it('stops socket writes under backpressure and resumes from custody on the shared timer', async () => {
    const f = await setup();
    const sender = await authenticated(f);
    const receiver = await authenticated(f, target);
    const buffered = vi.spyOn(receiver.serverWs, 'bufferedAmount', 'get').mockReturnValue(MAX_TRANSPORT_BYTES * 4);
    const envelope = makeEnvelope();
    sender.send({ frame: 'envelope', envelope });
    await sender.frame('stored');
    expect(receiver.frames.some((frame) => frame.frame === 'delivery')).toBe(false);
    expect(f.custody.outcome(source.node_id, envelope.msg_id)?.status).toBe('pending');
    buffered.mockRestore();
    await receiver.frame('delivery');
    expect(receiver.ws.readyState).toBe(1);
  });

  it('nacks full/conflict/strictly expired/invalid offers without stored or legacy ACK', async () => {
    const f = await setup({}, { maxEntries: 1 });
    const sender = await authenticated(f);
    const first = makeEnvelope();
    sender.send({ frame: 'envelope', envelope: first });
    await sender.frame('stored');
    for (const [reason, envelope] of [
      ['full', makeEnvelope()],
      ['conflict', { ...first, body: { text: 'different immutable content' } }],
      ['expired', makeEnvelope({ exp: new Date(Date.now() - 1_000).toISOString() })],
      ['invalid', makeEnvelope({ exp: undefined })],
      ['invalid', { ...makeEnvelope(), v: 3 }],
    ] as const) {
      const cursor = sender.frames.length;
      sender.send({ frame: 'envelope', envelope });
      const nack = await sender.frame<TransportNack>('nack', cursor);
      expect(nack.reason).toBe(reason);
      expect(nack.from_node).toBe(source.node_id);
      expect(nack.msg_id).toBe(envelope.msg_id);
      expect(nack.digest).toBe(envelopeDigest(envelope));
      expect(nack.retry_after_ms).toBeGreaterThan(0);
      expect(sender.frames.slice(cursor).some((frame) => frame.frame === 'stored' || frame.frame === 'ack')).toBe(false);
    }
    expect(f.custody.outcome(source.node_id, first.msg_id)?.digest).toBe(envelopeDigest(first));
  });

  it('reuses source pins, current status, target team and grant ACLs without legacy routing', async () => {
    const f = await setup();
    const offer = vi.spyOn(f.custody, 'offer');
    const sender = await authenticated(f);
    const forged = makeEnvelope({ from: { node_id: other.node_id, key_epoch: 1 } });
    sender.send({ frame: 'envelope', envelope: forged });
    const crossTeam = makeEnvelope({ to: { node_id: foreign.node_id, team_id: foreign.team_id } });
    sender.send({ frame: 'envelope', envelope: crossTeam });
    expect((await sender.frame<TransportNack>('nack')).reason).toBe('acl_rejected');
    expect(offer).not.toHaveBeenCalled();
    expect(f.custody.outcome(other.node_id, forged.msg_id)).toBeUndefined();
    f.core.grantLookup = (from, to) => (from === source.team_id && to === foreign.team_id ? [] : undefined);
    sender.send({ frame: 'envelope', envelope: crossTeam });
    await sender.frame('stored');
    expect(offer).toHaveBeenCalledTimes(1);
    const cursor = sender.frames.length;
    f.core.setDirectory({ epoch: 2, nodes: nodes.map((node) => node.node_id === source.node_id ? { ...node, status: 'suspended' } : node) });
    sender.send({ frame: 'envelope', envelope: makeEnvelope() });
    expect((await sender.frame<TransportNack>('nack', cursor)).reason).toBe('acl_rejected');
    expect(offer).toHaveBeenCalledTimes(1);
  });

  it('closes 1011 after a real SQLite offer failure, never stored/ACK, with no row after reopen', async () => {
    const f = await setup();
    const sender = await authenticated(f);
    f.store.transaction((db) => db.exec(`CREATE TRIGGER fail_offer BEFORE INSERT ON gateway_custody
      BEGIN SELECT RAISE(ABORT, 'injected offer failure'); END`));
    const envelope = makeEnvelope();
    sender.send({ frame: 'envelope', envelope });
    expect((await sender.closed).code).toBe(1011);
    expect(sender.frames.some((frame) => ['stored', 'ack', 'nack'].includes(String(frame.frame)))).toBe(false);
    expect(f.gateway.has(source.node_id)).toBe(false);
    await f.reopen();
    expect(f.custody.outcome(source.node_id, envelope.msg_id)).toBeUndefined();
  });

  it('retains custody after a failed receipt commit and issues a new ticket after reopen', async () => {
    const f = await setup();
    const sender = await authenticated(f);
    const receiver = await authenticated(f, target);
    const envelope = makeEnvelope();
    sender.send({ frame: 'envelope', envelope });
    const delivery = await receiver.frame<DeliveryFrame>('delivery');
    f.store.transaction((db) => db.exec(`CREATE TRIGGER fail_receipt BEFORE UPDATE ON gateway_custody
      WHEN NEW.status = 'received' BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END`));
    receiver.send(receipt(delivery));
    expect((await receiver.closed).code).toBe(1011);
    expect((await sender.closed).code).toBe(1011);
    await f.reopen();
    expect(f.custody.outcome(source.node_id, envelope.msg_id)?.status).toBe('pending');
    const replay = await authenticated(f, target);
    const fresh = await replay.frame<DeliveryFrame>('delivery');
    expect(fresh.ticket !== delivery.ticket).toBe(true);
  });

  it('catches background custody failure, closes all connections and stops the timer', async () => {
    const f = await setup();
    const sender = await authenticated(f);
    const receiver = await authenticated(f, target);
    const pending = vi.spyOn(f.custody, 'pending').mockImplementation(() => { throw new Error('injected unavailable'); });
    expect((await receiver.closed).code).toBe(1011);
    expect((await sender.closed).code).toBe(1011);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(pending).toHaveBeenCalledTimes(1);
    expect(f.core.connections.size).toBe(0);
  });

  it('clears retry work and connection tickets when closed', async () => {
    const f = await setup();
    const pending = vi.spyOn(f.custody, 'pending');
    await authenticated(f, target);
    await f.gateway.close();
    const calls = pending.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(pending.mock.calls.length).toBe(calls);
    expect(f.gateway.has(target.node_id)).toBe(false);
    expect(f.core.connections.size).toBe(0);
  });

  it('bounds incoming payloads while allowing a maximum-sized envelope plus JSON wrapper', async () => {
    const f = await setup();
    const sender = await authenticated(f);
    const empty = makeEnvelope({ body: { text: '' } });
    const envelope = makeEnvelope({ body: { text: 'x'.repeat(MAX_TRANSPORT_BYTES - Buffer.byteLength(JSON.stringify(empty))) } });
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBe(MAX_TRANSPORT_BYTES);
    sender.send({ frame: 'envelope', envelope });
    await sender.frame('stored');
    sender.ws.send('x'.repeat(MAX_TRANSPORT_BYTES + 4_097));
    expect((await sender.closed).code).toBe(1009);
    expect(f.custody.outcome(source.node_id, envelope.msg_id)?.status).toBe('pending');
  });

  it.each([
    {}, { transport_version: 1, features: CUSTODY_FEATURES }, { features: CUSTODY_FEATURES },
    { transport_version: 2 }, { transport_version: 2, features: [] },
    { transport_version: 2, features: ['durable-custody'] },
    { transport_version: 2, features: ['receiver-receipt'] },
    // b2b:旧完整集缺 lease-renewal → 网关拒绝陈旧客户端(诚实版本跃迁,无静默回退)
    { transport_version: 2, features: ['durable-custody', 'receiver-receipt'] },
  ])('requires explicit v2 and all custody features (%j)', async (fields) => {
    const f = await setup();
    const peer = await rawPeer(f);
    peer.auth(source, fields);
    expect(await peer.closed).toEqual({ code: 4004, reason: 'version_mismatch' });
    expect(peer.frames.length).toBe(0);
    expect(f.gateway.has(source.node_id)).toBe(false);
  });

  it('rejects v2 on legacy gateways without silent fallback, but keeps ephemeral v1 working', async () => {
    const f = await setup({ custody: undefined });
    const v2 = await rawPeer(f);
    v2.auth();
    expect(await v2.closed).toEqual({ code: 4004, reason: 'version_mismatch' });
    const sender = await rawPeer(f);
    sender.auth(source, {});
    await sender.frame('auth_ok');
    const envelope = makeEnvelope({ body: { kind: 'project' } });
    sender.send({ frame: 'envelope', envelope });
    expect((await sender.frame('ack')).ack_type).toBe('queued');
    const receiver = await rawPeer(f);
    receiver.auth(target, {});
    await receiver.frame('envelope');
    expect(receiver.frames[0]?.frame).toBe('auth_ok');
    expect(receiver.frames[0]?.transport_version).toBeUndefined();
    expect(f.custody.outcome(source.node_id, envelope.msg_id)).toBeUndefined();
  });

  it('rejects durable cluster configuration and invalid retry/window limits at construction', async () => {
    const f = await setup();
    const base: WsGatewayOptions = { core: f.core, custody: f.custody, authenticate: () => source };
    expect(() => new WsGateway({ ...base, clusterSecret: '' })).toThrow(/cluster/);
    expect(() => new WsGateway({ ...base, cluster: {} as NonNullable<WsGatewayOptions['cluster']> })).toThrow(/cluster/);
    for (const window of [0, -1, 17, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new WsGateway({ ...base, window })).toThrow(RangeError);
    }
    for (const retryIntervalMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() => new WsGateway({ ...base, retryIntervalMs })).toThrow(RangeError);
    }
  });
});