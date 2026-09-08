import { describe, expect, it } from 'vitest';
import { validateEnvelope } from '../src/envelope.js';
import { jcs } from '../src/jcs.js';
import { newKeyPair, signEnvelope, signatureInput, verifyEnvelopeSig } from '../src/sig.js';

const kpA = newKeyPair();
const kpB = newKeyPair();

function rawOffer(): Record<string, unknown> {
  return {
    v: 1,
    type: 'task.offer',
    msg_id: '77777777-7777-4777-8777-777777777777',
    ts: '2026-09-06T12:00:00+08:00',
    exp: '2026-09-07T12:00:00+08:00',
    from: { node_id: '11111111-1111-4111-8111-111111111111', team_id: '33333333-3333-4333-8333-333333333333', key_epoch: 3 },
    to: { node_id: '22222222-2222-4222-8222-222222222222', team_id: '33333333-3333-4333-8333-333333333333' },
    trace: { trace_id: '55555555-5555-4555-8555-555555555555', parent_span: null, origin_node: '11111111-1111-4111-8111-111111111111' },
    hops: 0,
    task_id: '66666666-6666-4666-8666-666666666666',
    attempt: 1,
    body: { kind: 'aid', summary: '帮我看下构建日志', lease_ms: 120000, offer_ttl_ms: 10000 },
  };
}

function mustValid(raw: unknown) {
  // 签名前形态校验(sig 由 signEnvelope 附加)
  const r = validateEnvelope(raw, undefined, { allowMissingSig: true });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.value;
}

describe('Ed25519 签名(D23)', () => {
  it('签名后仍过校验;按 from.key_epoch 查钥验签 ok', async () => {
    const unsigned = mustValid(rawOffer());
    const signed = signEnvelope(unsigned, kpA.priv);
    expect(validateEnvelope(signed).ok).toBe(true);
    const lookup = (nodeId: string, epoch: number) =>
      nodeId === unsigned.from.node_id && epoch === 3 ? kpA.publicKey : null;
    await expect(verifyEnvelopeSig(signed, lookup)).resolves.toEqual({ ok: true });
  });

  it('body 篡改 → bad_sig(body 必签)', async () => {
    const signed = signEnvelope(mustValid(rawOffer()), kpA.priv);
    const tampered = { ...signed, body: { ...signed.body, summary: '改过的任务书' } };
    await expect(verifyEnvelopeSig(tampered, () => kpA.publicKey)).resolves.toEqual({
      ok: false,
      reason: 'bad_sig',
    });
  });

  it('key_epoch 查无 → unknown_key', async () => {
    const signed = signEnvelope(mustValid(rawOffer()), kpA.priv);
    await expect(verifyEnvelopeSig(signed, () => null)).resolves.toEqual({ ok: false, reason: 'unknown_key' });
  });

  it('signatureInput = JCS(信封剔除 sig),与未签名信封一致', () => {
    const unsigned = mustValid(rawOffer());
    const signed = signEnvelope(unsigned, kpA.priv);
    expect(signatureInput(signed)).toBe(signatureInput(unsigned));
    expect(signatureInput(signed)).toBe(jcs(unsigned));
  });

  it('alg 白名单:非 ed25519 拒绝且不触发密钥查取', async () => {
    const signed = signEnvelope(mustValid(rawOffer()), kpA.priv);
    const evil = { ...signed, sig: { alg: 'ed25519-hax', value: signed.sig?.value ?? '' } };
    let called = false;
    const res = await verifyEnvelopeSig(evil, () => {
      called = true;
      return kpA.publicKey;
    });
    expect(res).toEqual({ ok: false, reason: 'alg_not_allowed' });
    expect(called).toBe(false);
  });

  it('B 钥签 A 钥验 → bad_sig', async () => {
    const signed = signEnvelope(mustValid(rawOffer()), kpB.priv);
    await expect(verifyEnvelopeSig(signed, () => kpA.publicKey)).resolves.toEqual({
      ok: false,
      reason: 'bad_sig',
    });
  });
});