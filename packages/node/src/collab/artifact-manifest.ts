/**
 * 产物清单与单独签名(E2 / ARTIFACT-ACCEPTANCE §4.1)。
 *
 * 逐 deliverable 内容寻址(sha256+size),以执行方 ed25519 私钥**单独签名**(core signBytes over JCS
 * 规范化字节,复用 D23 同一信任根与算法白名单),牵头方按注册中心登记公钥验签(verifyBytes)。签名清单
 * commit 进 qlong/<task> 产物分支 → 即使 task.result 信封被剥离 / 产物离线搬运,仍可独立验签(§1.2)。
 *
 * 纯原语:无 git / 网络 I/O(buildManifest 接收调用方已读的字节)。git 集成见 payload-git.ts(§4.2),
 * 牵头方验收编排见 DurableLead(§4.3)。哈希用 node:crypto sha256(同 payload-git.ts / fetcher.ts)。
 */
import { createHash } from 'node:crypto';
import { jcs, signBytes, verifyBytes, fromBase64, toBase64 } from '@qlong/core';

/** 单个交付物的内容寻址条目(path 相对工作区根;sha256/size 为字节级校验值)。 */
export interface ArtifactEntry {
  path: string;
  sha256: string;
  size: number;
}

/** 产物清单:一次 attempt 的全部交付物 + 签名钥标识(node_id/key_epoch 须 == task.result 信封 from)。 */
export interface ArtifactManifest {
  task_id: string;
  attempt: number;
  node_id: string;
  key_epoch: number;
  deliverables: ArtifactEntry[];
}

/** 已签名清单:sig = base64(ed25519(JCS(manifest)));随产物 commit 进 git 分支并内联于 task.result。 */
export interface SignedManifest {
  alg: 'ed25519';
  manifest: ArtifactManifest;
  sig: string;
}

const te = new TextEncoder();

/** 字节 sha256 十六进制(独立于 core 的字符串版 sha256Hex;与 payload-git.ts:94/175 同款)。 */
function hashBytes(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}

/**
 * 逐文件计算 sha256+size,deliverables 按 path 升序归一(JCS 规范化前的稳定排序,保证同一批产物
 * 无论读入顺序都得到字节一致的清单 → 摘要/签名可复现)。
 */
export function buildManifest(
  taskId: string,
  attempt: number,
  nodeId: string,
  keyEpoch: number,
  files: ReadonlyArray<{ path: string; bytes: Uint8Array }>,
): ArtifactManifest {
  const deliverables = files
    .map((f) => ({ path: f.path, sha256: hashBytes(f.bytes), size: f.bytes.length }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { task_id: taskId, attempt, node_id: nodeId, key_epoch: keyEpoch, deliverables };
}

/** ed25519 单独签名(core signBytes over JCS 规范化字节)。 */
export function signManifest(manifest: ArtifactManifest, priv: Uint8Array): SignedManifest {
  const sig = signBytes(te.encode(jcs(manifest)), priv);
  return { alg: 'ed25519', manifest, sig: toBase64(sig) };
}

/**
 * 验签(core verifyBytes over JCS 规范化字节)。算法非白名单 / 签名损坏 / 清单被篡改 / 公钥不符
 * 一律 false(fail-closed);绝不抛出到验收编排层。
 */
export function verifyManifest(signed: SignedManifest, pub: Uint8Array): boolean {
  if (signed.alg !== 'ed25519') return false;
  try {
    return verifyBytes(fromBase64(signed.sig), te.encode(jcs(signed.manifest)), pub);
  } catch {
    return false;
  }
}

/** JCS 规范化摘要 = 牵头方预置判定与机器内验收器的关联键(§4.3)。 */
export function manifestDigest(manifest: ArtifactManifest): string {
  return hashBytes(te.encode(jcs(manifest)));
}
