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
import { isUuid, jcs, signBytes, verifyBytes, fromBase64, toBase64 } from '@qlong/core';
import { isLeadContract } from '../lead/machine.js';

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

/** 契约声明的单条交付物(01 §5.2:path 或 artifact 命名 + desc);完整性核对按 path 匹配清单。 */
export interface ContractDeliverable {
  path?: string;
  artifact?: string;
  desc?: string;
}

/**
 * 牵头方对一次交付的**完整性判定**(纯逻辑,无 I/O;调用方已 collect 并读取产物字节)。
 * 四道防线全过才 true(fail-closed,ARTIFACT-ACCEPTANCE §4.3):
 *  1. 清单钥标识(node_id/key_epoch)== 信封署名者 —— 防他人清单冒充本次交付;
 *  2. ed25519 验签(登记公钥)—— 防清单伪造/篡改;
 *  3. 逐 manifest deliverable 在收取集存在且 sha256+size 一致 —— 防传输损坏/掉包/缺件;
 *  4. 契约声明的每条 path deliverable 都在清单 —— 防契约不完整(少交)。
 * 收取集的多余文件(不在清单)忽略:清单是权威交付集,契约是完整性下界。
 */
export function verifyArtifactDelivery(input: {
  signed: SignedManifest;
  taskId: string;
  attempt: number;
  pub: Uint8Array;
  fromNodeId: string;
  fromKeyEpoch: number;
  collected: ReadonlyArray<{ path: string; bytes: Uint8Array }>;
  contract?: { deliverables?: ContractDeliverable[] };
}): boolean {
  const { signed, pub, taskId, attempt, fromNodeId, fromKeyEpoch, collected, contract } = input;
  if (!validSignedManifest(signed) || !isLeadContract(contract)) return false;
  if (signed.manifest.task_id !== taskId || signed.manifest.attempt !== attempt) return false;
  // 1. 清单钥标识 == 信封署名者
  if (signed.manifest.node_id !== fromNodeId || signed.manifest.key_epoch !== fromKeyEpoch) return false;
  // 2. ed25519 验签(登记公钥)
  if (!verifyManifest(signed, pub)) return false;
  // 3. 逐 deliverable 重新哈希:收取集存在 + size + sha256 一致
  const byPath = new Map(collected.map((c) => [c.path, c.bytes]));
  for (const d of signed.manifest.deliverables) {
    const bytes = byPath.get(d.path);
    if (bytes === undefined) return false; // 清单声明但未收到 → 缺件
    if (bytes.length !== d.size) return false; // 尺寸不符
    if (hashBytes(bytes) !== d.sha256) return false; // 重新哈希不符 → 损坏/掉包
  }
  // 4. 契约完整性:每条声明 path deliverable 都在清单
  const manifestPaths = new Set(signed.manifest.deliverables.map((d) => d.path));
  for (const c of contract?.deliverables ?? []) {
    // artifact 命名尚无字节映射端口，不能把无法核验的声明当成空要求。
    if (typeof c.path !== 'string' || !manifestPaths.has(c.path)) return false;
  }
  return true;
}

/** 不可信清单的结构准入；重复路径会使内容寻址歧义，统一拒绝。 */
export function validSignedManifest(value: unknown): value is SignedManifest {
  const object = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
  if (!object(value) || value.alg !== 'ed25519' || typeof value.sig !== 'string' || !object(value.manifest)) return false;
  const m = value.manifest;
  if (!isUuid(m.task_id) || !isUuid(m.node_id) || !positive(m.attempt) || !positive(m.key_epoch) || !Array.isArray(m.deliverables)) return false;
  const paths = new Set<string>();
  for (const d of m.deliverables) {
    if (!object(d) || typeof d.path !== 'string' || !d.path.trim() || paths.has(d.path) ||
        typeof d.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(d.sha256) ||
        typeof d.size !== 'number' || !Number.isSafeInteger(d.size) || d.size < 0) return false;
    paths.add(d.path);
  }
  return true;
}
