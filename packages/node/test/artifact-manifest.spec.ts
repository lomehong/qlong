import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { newKeyPair, publicKeyFromPrivate, jcs } from '@qlong/core';
import {
  buildManifest, signManifest, verifyManifest, manifestDigest, verifyArtifactDelivery,
  type ArtifactManifest,
} from '../src/collab/artifact-manifest.js';

/** 独立 sha256 预言机(不复用被测代码),验证 buildManifest 的哈希/尺寸真实正确。 */
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

const TASK = '66666666-6666-4666-8666-666666666666';
const NODE = '22222222-2222-4222-8222-222222222222';

describe('buildManifest(逐 deliverable 内容寻址)', () => {
  it('逐文件计算 sha256+size,deliverables 按 path 升序稳定排列', () => {
    const report = Buffer.from('# report body');
    const log = Buffer.from('log-lines');
    // 故意乱序传入,buildManifest 须按 path 升序归一(JCS 规范化前稳定排序)
    const m = buildManifest(TASK, 1, NODE, 3, [
      { path: 'dist/report.md', bytes: report },
      { path: 'build.log', bytes: log },
    ]);
    expect(m.task_id).toBe(TASK);
    expect(m.attempt).toBe(1);
    expect(m.node_id).toBe(NODE);
    expect(m.key_epoch).toBe(3);
    expect(m.deliverables.map((d) => d.path)).toEqual(['build.log', 'dist/report.md']);
    const byPath = Object.fromEntries(m.deliverables.map((d) => [d.path, d]));
    expect(byPath['dist/report.md']?.sha256).toBe(sha256(report));
    expect(byPath['dist/report.md']?.size).toBe(report.length);
    expect(byPath['build.log']?.sha256).toBe(sha256(log));
    expect(byPath['build.log']?.size).toBe(log.length);
  });

  it('空产物集 → 空 deliverables(边界,不抛错)', () => {
    const m = buildManifest(TASK, 1, NODE, 3, []);
    expect(m.deliverables).toEqual([]);
  });
});

describe('signManifest / verifyManifest(ed25519 单独签名)', () => {
  it('匹配公钥验签通过(往返)', () => {
    const { priv, publicKey } = newKeyPair();
    const m = buildManifest(TASK, 1, NODE, 3, [{ path: 'a.txt', bytes: Buffer.from('A') }]);
    const signed = signManifest(m, priv);
    expect(signed.alg).toBe('ed25519');
    expect(signed.manifest).toEqual(m);
    expect(verifyManifest(signed, publicKey)).toBe(true);
  });

  it('错误公钥验签失败(防伪造:非登记钥不可冒充)', () => {
    const { priv } = newKeyPair();
    const stranger = newKeyPair();
    const m = buildManifest(TASK, 1, NODE, 3, [{ path: 'a.txt', bytes: Buffer.from('A') }]);
    const signed = signManifest(m, priv);
    expect(verifyManifest(signed, stranger.publicKey)).toBe(false);
  });

  it('清单被篡改(改 sha256)→ 验签失败(防掉包/损坏)', () => {
    const { priv, publicKey } = newKeyPair();
    const m = buildManifest(TASK, 1, NODE, 3, [{ path: 'a.txt', bytes: Buffer.from('A') }]);
    const signed = signManifest(m, priv);
    const tampered: ArtifactManifest = {
      ...signed.manifest,
      deliverables: [{ path: 'a.txt', sha256: 'f'.repeat(64), size: 1 }],
    };
    expect(verifyManifest({ ...signed, manifest: tampered }, publicKey)).toBe(false);
  });

  it('清单被篡改(改 attempt 重放旧产物)→ 验签失败', () => {
    const { priv, publicKey } = newKeyPair();
    const m = buildManifest(TASK, 2, NODE, 3, [{ path: 'a.txt', bytes: Buffer.from('A') }]);
    const signed = signManifest(m, priv);
    expect(verifyManifest({ ...signed, manifest: { ...signed.manifest, attempt: 1 } }, publicKey)).toBe(false);
  });

  it('签名值被篡改 → 验签失败', () => {
    const { priv, publicKey } = newKeyPair();
    const m = buildManifest(TASK, 1, NODE, 3, [{ path: 'a.txt', bytes: Buffer.from('A') }]);
    const signed = signManifest(m, priv);
    const flipped = signed.sig.slice(0, 4) + (signed.sig[4] === 'A' ? 'B' : 'A') + signed.sig.slice(5);
    expect(verifyManifest({ ...signed, sig: flipped }, publicKey)).toBe(false);
  });
});

describe('manifestDigest(JCS 规范化摘要 = 判定关联键)', () => {
  it('等于 sha256(jcs(manifest)),对同一清单稳定', () => {
    const m = buildManifest(TASK, 1, NODE, 3, [{ path: 'a.txt', bytes: Buffer.from('A') }]);
    const expected = createHash('sha256').update(Buffer.from(jcs(m), 'utf8')).digest('hex');
    expect(manifestDigest(m)).toBe(expected);
    expect(manifestDigest(m)).toBe(manifestDigest({ ...m }));
  });

  it('键插入顺序不影响摘要(JCS 规范化)', () => {
    const a: ArtifactManifest = { task_id: TASK, attempt: 1, node_id: NODE, key_epoch: 3, deliverables: [] };
    const b = JSON.parse('{"deliverables":[],"key_epoch":3,"node_id":"' + NODE + '","attempt":1,"task_id":"' + TASK + '"}') as ArtifactManifest;
    expect(manifestDigest(a)).toBe(manifestDigest(b));
  });

  it('不同 attempt → 不同摘要', () => {
    const a = buildManifest(TASK, 1, NODE, 3, []);
    const b = buildManifest(TASK, 2, NODE, 3, []);
    expect(manifestDigest(a)).not.toBe(manifestDigest(b));
  });

  it('由私钥导出的公钥可验签(publicKeyFromPrivate 一致性)', () => {
    const { priv } = newKeyPair();
    const pub = publicKeyFromPrivate(priv);
    const m = buildManifest(TASK, 1, NODE, 3, [{ path: 'a.txt', bytes: Buffer.from('A') }]);
    expect(verifyManifest(signManifest(m, priv), pub)).toBe(true);
  });
});

describe('verifyArtifactDelivery(牵头方完整性判定:验签+钥标识+重新哈希+契约完整性)', () => {
  const reportBytes = Buffer.from('# report body');
  const logBytes = Buffer.from('log-lines');
  const OTHER_NODE = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

  function setup() {
    const { priv, publicKey } = newKeyPair();
    const files = [
      { path: 'dist/report.md', bytes: reportBytes },
      { path: 'build.log', bytes: logBytes },
    ];
    const manifest = buildManifest(TASK, 1, NODE, 3, files);
    const signed = signManifest(manifest, priv);
    const contract = { deliverables: [{ path: 'dist/report.md' }, { path: 'build.log' }] };
    return { priv, publicKey, signed, manifest, files, contract };
  }

  it('全部满足(验签通过+钥标识匹配+逐产物重新哈希+契约完整)→ true', () => {
    const s = setup();
    expect(verifyArtifactDelivery({
      signed: s.signed, pub: s.publicKey, fromNodeId: NODE, fromKeyEpoch: 3,
      taskId: TASK, attempt: 1, collected: s.files, contract: s.contract,
    })).toBe(true);
  });

  it('清单 node_id 与信封署名者不符 → false(防他人清单冒充本次交付)', () => {
    const s = setup();
    expect(verifyArtifactDelivery({
      signed: s.signed, pub: s.publicKey, fromNodeId: OTHER_NODE, fromKeyEpoch: 3,
      taskId: TASK, attempt: 1, collected: s.files, contract: s.contract,
    })).toBe(false);
  });

  it('清单 key_epoch 与信封署名者不符 → false', () => {
    const s = setup();
    expect(verifyArtifactDelivery({
      signed: s.signed, pub: s.publicKey, fromNodeId: NODE, fromKeyEpoch: 4,
      taskId: TASK, attempt: 1, collected: s.files, contract: s.contract,
    })).toBe(false);
  });

  it('错误公钥(非登记钥)→ false(验签防线)', () => {
    const s = setup();
    const stranger = newKeyPair();
    expect(verifyArtifactDelivery({
      signed: s.signed, pub: stranger.publicKey, fromNodeId: NODE, fromKeyEpoch: 3,
      taskId: TASK, attempt: 1, collected: s.files, contract: s.contract,
    })).toBe(false);
  });

  it('收取字节被篡改(等长但哈希不符)→ false(传输损坏/掉包)', () => {
    const s = setup();
    // 等长篡改(13 字节):size 防线不拦,专验重新哈希防线
    const tampered = s.files.map((f) => (f.path === 'dist/report.md' ? { path: f.path, bytes: Buffer.from('# REPORT BODY') } : f));
    expect(verifyArtifactDelivery({
      signed: s.signed, pub: s.publicKey, fromNodeId: NODE, fromKeyEpoch: 3,
      taskId: TASK, attempt: 1, collected: tampered, contract: s.contract,
    })).toBe(false);
  });

  it('清单声明的产物未收到(缺件)→ false', () => {
    const s = setup();
    const partial = s.files.filter((f) => f.path !== 'build.log');
    expect(verifyArtifactDelivery({
      signed: s.signed, pub: s.publicKey, fromNodeId: NODE, fromKeyEpoch: 3,
      taskId: TASK, attempt: 1, collected: partial, contract: { deliverables: [{ path: 'dist/report.md' }] },
    })).toBe(false);
  });

  it('契约声明的 deliverable 不在清单(契约不完整)→ false', () => {
    const s = setup();
    expect(verifyArtifactDelivery({
      signed: s.signed, pub: s.publicKey, fromNodeId: NODE, fromKeyEpoch: 3,
      taskId: TASK, attempt: 1, collected: s.files, contract: { deliverables: [{ path: 'dist/report.md' }, { path: 'extra.md' }] },
    })).toBe(false);
  });

  it('清单 size 被改后重签(哈希仍符但 size 不符)→ false(size 独立校验)', () => {
    const { priv, publicKey } = newKeyPair();
    const files = [{ path: 'a.txt', bytes: Buffer.from('AAA') }];
    const m = buildManifest(TASK, 1, NODE, 3, files);
    const bad: ArtifactManifest = { ...m, deliverables: [{ ...m.deliverables[0]!, size: 999 }] };
    const signed = signManifest(bad, priv); // 重签使签名自洽,唯 size 与真实字节不符
    expect(verifyArtifactDelivery({
      signed, pub: publicKey, fromNodeId: NODE, fromKeyEpoch: 3,
      taskId: TASK, attempt: 1, collected: files, contract: { deliverables: [{ path: 'a.txt' }] },
    })).toBe(false);
  });

  it.each([
    ['其他任务', { task_id: OTHER_NODE }],
    ['旧轮次', { attempt: 2 }],
    ['缺任务', { task_id: undefined }],
    ['缺轮次', { attempt: undefined }],
  ])('P0 清单绑定：%s 的自洽签名仍拒绝', (_name, patch) => {
    const s = setup();
    const manifest = { ...s.manifest, ...patch } as ArtifactManifest;
    expect(verifyArtifactDelivery({
      signed: signManifest(manifest, s.priv), pub: s.publicKey,
      fromNodeId: NODE, fromKeyEpoch: 3, taskId: TASK, attempt: 1, collected: s.files,
    })).toBe(false);
  });

  it.each([
    ['空条目', [null]],
    ['无路径', [{ sha256: sha256(reportBytes), size: reportBytes.length }]],
    ['重复路径', [
      { path: 'dist/report.md', sha256: sha256(reportBytes), size: reportBytes.length },
      { path: 'dist/report.md', sha256: sha256(reportBytes), size: reportBytes.length },
    ]],
  ])('P0 畸形清单：%s 返回 false 而非抛错', (_name, deliverables) => {
    const s = setup();
    const manifest = { ...s.manifest, deliverables } as ArtifactManifest;
    expect(verifyArtifactDelivery({
      signed: signManifest(manifest, s.priv), pub: s.publicKey,
      fromNodeId: NODE, fromKeyEpoch: 3, taskId: TASK, attempt: 1, collected: s.files,
    })).toBe(false);
  });

  it.each([
    { deliverables: [{ artifact: 'report' }] },
    { deliverables: [null] },
    { deliverables: [{}] },
    { deliverables: 'report' },
  ])('P0 契约不能被当成空要求跳过：%j', (contract) => {
    const s = setup();
    expect(verifyArtifactDelivery({
      signed: signManifest(buildManifest(TASK, 1, NODE, 3, []), s.priv), pub: s.publicKey,
      fromNodeId: NODE, fromKeyEpoch: 3, taskId: TASK, attempt: 1, collected: [],
      contract: contract as unknown as Parameters<typeof verifyArtifactDelivery>[0]['contract'],
    })).toBe(false);
  });

  it.each([undefined, {}, { deliverables: [] }])('P0 零交付契约兼容：%j 仍需有效签名', (contract) => {
    const s = setup();
    const input = {
      signed: signManifest(buildManifest(TASK, 1, NODE, 3, []), s.priv), pub: s.publicKey,
      fromNodeId: NODE, fromKeyEpoch: 3, taskId: TASK, attempt: 1, collected: [], contract,
    };
    expect(verifyArtifactDelivery(input)).toBe(true);
    expect(verifyArtifactDelivery({ ...input, signed: { ...input.signed, sig: 'bad' } })).toBe(false);
  });

  it('无契约(contract 缺席)→ 仅验签+重新哈希,完整即 true', () => {
    const s = setup();
    expect(verifyArtifactDelivery({
      signed: s.signed, pub: s.publicKey, fromNodeId: NODE, fromKeyEpoch: 3,
      taskId: TASK, attempt: 1, collected: s.files,
    })).toBe(true);
  });
});
