import { describe, expect, it } from 'vitest';
import { newKeyPair } from '@qlong/core';
import type { DurableLeadTakeoverBundle } from '../src/runtime/lead.js';
import { signTakeoverBundle, verifyTakeoverBundle } from '../src/runtime/takeover-bundle.js';

/**
 * takeover bundle 签名封套:签名域 = JCS(bundle)(与信封签名同一规范化,D23 单一实现)。
 * 任何字段变动(含 attempt 高水位/任务清单)都改变 JCS 字节 → 验签失败,防伪造接管。
 */
const bundle: DurableLeadTakeoverBundle = {
  v: 1,
  exported_at: '2026-09-18T00:00:00.000Z',
  requires_origin_stopped: true,
  tasks: [{
    task_id: '11111111-1111-4111-8111-111111111111',
    task: {
      version: 2, task_id: '11111111-1111-4111-8111-111111111111', kind: 'aid', state: 'drafting',
      attempt: 3, target: null, task_seq: 7, lease_ms: 1000, acceptedThisAttempt: false,
      acceptedFailedBudget: 0,
    } as unknown as DurableLeadTakeoverBundle['tasks'][number]['task'],
  }],
};

describe('takeover bundle 签名封套', () => {
  it('sign → verify 往返;密钥对自洽', () => {
    const { priv, publicKey } = newKeyPair();
    const wrapper = signTakeoverBundle(bundle, priv);
    expect(wrapper.v).toBe(1);
    expect(wrapper.sig.alg).toBe('ed25519');
    const result = verifyTakeoverBundle(JSON.parse(JSON.stringify(wrapper)), publicKey);
    expect(result).toMatchObject({ ok: true });
    expect(result.ok === true && result.bundle.tasks.length).toBe(1);
  });

  it('篡改 bundle 任一字段 → bad_sig;换密钥 → bad_sig', () => {
    const { priv, publicKey } = newKeyPair();
    const wrapper = signTakeoverBundle(bundle, priv);
    const tampered = JSON.parse(JSON.stringify(wrapper)) as typeof wrapper;
    tampered.bundle.tasks[0]!.task.attempt = 99; // 伪造高 attempt 劫持
    expect(verifyTakeoverBundle(tampered, publicKey)).toMatchObject({ ok: false, reason: 'bad_sig' });
    const stranger = newKeyPair();
    expect(verifyTakeoverBundle(wrapper, stranger.publicKey)).toMatchObject({ ok: false, reason: 'bad_sig' });
  });

  it('结构/算法白名单 fail-closed:非对象、缺 bundle、非 ed25519、坏 base64、错种子', () => {
    const { priv, publicKey } = newKeyPair();
    expect(verifyTakeoverBundle(null, publicKey)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifyTakeoverBundle({ v: 1 }, publicKey)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifyTakeoverBundle({ v: 1, bundle, sig: { alg: 'rs256', value: 'AA==' } }, publicKey))
      .toMatchObject({ ok: false, reason: 'alg_not_allowed' });
    expect(signTakeoverBundle.bind(null, bundle, new Uint8Array(16))).toThrow(/32-byte/);
    void priv;
  });
});
