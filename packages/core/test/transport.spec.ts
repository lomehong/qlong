import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EnvelopeV1 } from '../src/envelope.js';
import { newId } from '../src/ids.js';
import { jcs } from '../src/jcs.js';
import { newKeyPair, signEnvelope } from '../src/sig.js';
import {
  CUSTODY_FEATURES, envelopeDigest, hasCustodyFeatures, isDeliveryIdentity, isReceiptFrame, isStoredFrame,
} from '../src/transport.js';

describe('custody feature negotiation', () => {
  it('requires both advertised features, independent of order and extensions', () => {
    expect(CUSTODY_FEATURES).toEqual(['durable-custody', 'receiver-receipt']);
    expect(hasCustodyFeatures(CUSTODY_FEATURES)).toBe(true);
    expect(hasCustodyFeatures(['receiver-receipt', 'future-feature', 'durable-custody'])).toBe(true);
    expect(hasCustodyFeatures(['durable-custody', 'durable-custody', 'receiver-receipt'])).toBe(true);
  });

  it.each([
    undefined, null, false, 2, 'durable-custody,receiver-receipt', {},
    { features: ['durable-custody', 'receiver-receipt'] }, [],
    ['durable-custody'], ['receiver-receipt'], ['durable-custody', 'durable-custody'],
    ['durable-custody', null], ['durable-custody', ['receiver-receipt']],
    ['durable-custody', 'RECEIVER-RECEIPT'],
  ].map((value) => ({ value })))('rejects missing or malformed features %#', ({ value }) => {
    expect(hasCustodyFeatures(value)).toBe(false);
  });
});

// Structural validators need no credentials or cryptographic signature fixture.
const identity = { from_node: 'fixture-sender', msg_id: 'fixture-message', digest: 'a'.repeat(64) };
const stored = { ...identity, frame: 'stored' };
const receipt = { ...identity, frame: 'receipt', ticket: 'fixture-ticket' };

describe.each([
  { name: 'delivery identity', validate: isDeliveryIdentity, valid: identity },
  { name: 'stored frame', validate: isStoredFrame, valid: stored },
  { name: 'receipt frame', validate: isReceiptFrame, valid: receipt },
])('$name contract', ({ validate, valid }) => {
  it('accepts the full identity and ignores extension fields', () => {
    expect(validate(valid)).toBe(true);
    expect(validate({ ...valid, extension: { revision: 3 } })).toBe(true);
  });

  it.each([undefined, null, false, 1, 'stored', {}, [], [valid], Object.assign([], valid)]
    .map((value) => ({ value })))('rejects malformed input %#', ({ value }) => {
    expect(validate(value)).toBe(false);
  });

  it.each(['from_node', 'msg_id', 'digest'])('requires %s to be present', (field) => {
    const missing: Record<string, unknown> = { ...valid };
    delete missing[field];
    expect(validate(missing)).toBe(false);
  });

  it.each(['from_node', 'msg_id', 'digest'])('requires a nonempty string %s', (field) => {
    for (const value of [undefined, null, '', 1, false, [], {}]) {
      expect(validate({ ...valid, [field]: value })).toBe(false);
    }
  });

  it.each(['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), ` ${identity.digest}`])(
    'rejects a noncanonical digest %#', (digest) => {
      expect(validate({ ...valid, digest })).toBe(false);
    },
  );
});

describe('custody frame discriminants and receipt tickets', () => {
  it('does not confuse bare identities, stored, receipt, or legacy ACK frames', () => {
    expect(isStoredFrame(identity)).toBe(false);
    expect(isReceiptFrame(identity)).toBe(false);
    expect(isStoredFrame(receipt)).toBe(false);
    expect(isReceiptFrame(stored)).toBe(false);
    for (const frame of [undefined, null, [], 2, 'ack', 'delivery', 'nack', 'STORED', 'RECEIPT']) {
      expect(isStoredFrame({ ...stored, frame, ack_type: 'stored' })).toBe(false);
      expect(isReceiptFrame({ ...receipt, frame, ack_type: 'receipt' })).toBe(false);
    }
  });

  it('requires a receipt ticket of 1 through 128 characters', () => {
    expect(isReceiptFrame({ ...receipt, ticket: 'x' })).toBe(true);
    expect(isReceiptFrame({ ...receipt, ticket: 'x'.repeat(128) })).toBe(true);
    expect(isReceiptFrame({ ...identity, frame: 'receipt' })).toBe(false);
    for (const ticket of [undefined, null, '', 'x'.repeat(129), 1, false, [], {}]) {
      expect(isReceiptFrame({ ...receipt, ticket })).toBe(false);
    }
  });
});

function signedEnvelope(): EnvelopeV1 {
  const from = newId();
  return signEnvelope({
    v: 1, type: 'task.offer', msg_id: newId(), task_id: newId(), attempt: 1, hops: 0,
    ts: '2026-01-01T00:00:00.000Z', exp: '2026-01-01T00:01:00.000Z', reply_to: newId(),
    from: { node_id: from, team_id: newId(), agent_id: newId(), key_epoch: 1 },
    to: { node_id: newId(), team_id: newId() },
    trace: { trace_id: newId(), parent_span: null, origin_node: from },
    body: { kind: 'aid', summary: 'digest fixture', details: { step: 1, label: 'test' } },
  }, newKeyPair().priv);
}

describe('full-envelope custody digest', () => {
  it('is lowercase SHA-256 of JCS, including the signature', () => {
    const env = signedEnvelope();
    const digest = envelopeDigest(env);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(createHash('sha256').update(jcs(env)).digest('hex'));
    const { sig: _sig, ...unsigned } = env;
    expect(envelopeDigest(unsigned)).not.toBe(digest);
  });

  it('ignores property insertion order throughout the envelope', () => {
    const env = signedEnvelope();
    const reordered = Object.fromEntries(Object.entries(env).reverse()) as unknown as EnvelopeV1;
    reordered.from = { key_epoch: env.from.key_epoch, agent_id: env.from.agent_id,
      team_id: env.from.team_id, node_id: env.from.node_id };
    reordered.body = { details: { label: 'test', step: 1 }, summary: 'digest fixture', kind: 'aid' };
    expect(JSON.stringify(reordered) === JSON.stringify(env)).toBe(false);
    expect(envelopeDigest(reordered)).toBe(envelopeDigest(env));
  });

  const tamper: Array<{ field: string; change: (env: EnvelopeV1) => EnvelopeV1 }> = [
    { field: 'v', change: (env) => ({ ...env, v: 2 }) },
    { field: 'type', change: (env) => ({ ...env, type: 'task.accept' }) },
    { field: 'msg_id', change: (env) => ({ ...env, msg_id: newId() }) },
    { field: 'task_id', change: (env) => ({ ...env, task_id: newId() }) },
    { field: 'attempt', change: (env) => ({ ...env, attempt: 2 }) },
    { field: 'hops', change: (env) => ({ ...env, hops: 1 }) },
    { field: 'ts', change: (env) => ({ ...env, ts: '2026-01-01T00:00:01.000Z' }) },
    { field: 'exp', change: (env) => ({ ...env, exp: '2026-01-01T00:02:00.000Z' }) },
    { field: 'reply_to', change: (env) => ({ ...env, reply_to: newId() }) },
    { field: 'sender', change: (env) => ({ ...env, from: { ...env.from, node_id: newId() } }) },
    { field: 'key epoch', change: (env) => ({ ...env, from: { ...env.from, key_epoch: 2 } }) },
    { field: 'recipient', change: (env) => ({ ...env, to: { ...env.to, node_id: newId() } }) },
    { field: 'trace', change: (env) => ({ ...env, trace: { ...env.trace, parent_span: newId() } }) },
    { field: 'body', change: (env) => ({ ...env, body: { ...env.body, details: { step: 2, label: 'test' } } }) },
    { field: 'signature value', change: (env) => ({ ...env, sig: { alg: 'ed25519', value: 'fixture-tamper' } }) },
    { field: 'signature algorithm', change: (env) => ({ ...env, sig: { alg: 'fixture-algorithm', value: env.sig!.value } }) },
    { field: 'extension', change: (env) => ({ ...env, extension: { revision: 2 } }) },
  ];

  it.each(tamper)('detects $field tampering without re-signing', ({ change }) => {
    const env = signedEnvelope();
    expect(envelopeDigest(change(env))).not.toBe(envelopeDigest(env));
  });
});