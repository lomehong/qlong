/** Trusted registry boundary: no redirects, bounded requests, no response bodies in errors. */
import { isUuid, validateEnvelope, verifyEnvelopeSig, type EnvelopeV1 } from '@qlong/core';
import { QLONG_USER_AGENT } from '@qlong/core';

export const REGISTRY_TIMEOUT_MS = 5_000;

interface RegistryConnection {
  registryUrl: string;
  nodeToken: string;
}

export interface RegistryIdentity {
  node_id: string;
  team_id: string;
  key_epoch: number;
  pubkey: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function epoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function publicKey(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || value.length !== 44) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === 32 && bytes.toString('base64') === value ? bytes : null;
}

export async function fetchRegistryJson(opts: RegistryConnection, path: string): Promise<unknown> {
  let res: Response;
  try {
    const url = new URL(opts.registryUrl.replace(/\/+$/, '') + path);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new Error('invalid registry URL');
    }
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${opts.nodeToken}`, 'User-Agent': QLONG_USER_AGENT },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch {
    throw new Error('registry 请求失败:无法获取可信节点身份');
  }
  if (!res.ok) throw new Error(`registry 返回 ${res.status}:无法获取可信节点身份`);
  try {
    return await res.json();
  } catch {
    throw new Error('registry 响应格式错误:无法获取可信节点身份');
  }
}

function keyEntries(value: unknown): Map<number, string> | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const keys = new Map<number, string>();
  for (const entry of value) {
    if (!record(entry) || !epoch(entry.epoch) || !publicKey(entry.pubkey) || keys.has(entry.epoch)) return null;
    keys.set(entry.epoch, entry.pubkey as string);
  }
  return keys;
}

export async function loadRegistryIdentity(opts: RegistryConnection): Promise<RegistryIdentity> {
  const me = await fetchRegistryJson(opts, '/v1/nodes/me');
  const invalid = () => new Error('registry 节点身份无效:需要 active 状态、显式当前纪元和有效公钥');
  if (!record(me) || !isUuid(me.node_id) || !isUuid(me.team_id) || me.status !== 'active' || !epoch(me.key_epoch)) {
    throw invalid();
  }
  // Only the explicit current epoch is authoritative, never array order/max/epoch 1.
  // Legacy `keys` is accepted only when `pubkeys` is absent, not when it is malformed.
  const keys = keyEntries(me.pubkeys === undefined ? me.keys : me.pubkeys);
  const current = keys?.get(me.key_epoch);
  if (!keys || !current) throw invalid();
  if (me.pubkeys !== undefined && me.keys !== undefined) {
    const legacy = keyEntries(me.keys);
    if (!legacy || legacy.size !== keys.size || [...keys].some(([e, key]) => legacy.get(e) !== key)) throw invalid();
  }
  return { node_id: me.node_id, team_id: me.team_id, key_epoch: me.key_epoch, pubkey: current };
}

export function createRegistryVerifier(
  opts: RegistryConnection,
  identity: RegistryIdentity,
): (env: EnvelopeV1) => Promise<boolean> {
  // Capture immutable identity/config values; callers cannot mutate the trust binding.
  const connection = { registryUrl: opts.registryUrl, nodeToken: opts.nodeToken };
  const { node_id: nodeId, team_id: teamId } = identity;
  return async (env) => {
    try {
      if (!validateEnvelope(env).ok || env.to.node_id !== nodeId || env.to.team_id !== teamId ||
          env.from.team_id !== teamId || !isUuid(env.from.node_id) || !epoch(env.from.key_epoch)) return false;
      // Phase 3 cross-team trust is deliberately not inferred from envelope claims.
      // Exactly one origin lookup per message: no stale positive cache or unknown-epoch retry loop.
      const result = await verifyEnvelopeSig(env, async (sender, keyEpoch) => {
        const key = await fetchRegistryJson(connection, `/v1/nodes/${encodeURIComponent(sender)}/pubkey?epoch=${keyEpoch}`);
        // This authenticated endpoint authorizes same-team access and rejects inactive nodes.
        if (!record(key) || key.node_id !== sender || key.key_epoch !== keyEpoch ||
            (key.status !== 'current' && key.status !== 'historical') ||
            (key.team_id !== undefined && key.team_id !== teamId)) return null;
        return publicKey(key.pubkey);
      });
      return result.ok === true;
    } catch {
      // Includes directory outages, malformed keys/signatures and verifier exceptions.
      return false;
    }
  };
}

/**
 * e2d-3c:牵头方产物验签公钥回源(ARTIFACT-ACCEPTANCE §4.3)。复用 fetchRegistryJson + createRegistryVerifier
 * 内层同款校验(node_id/key_epoch/status current|historical/team),独立导出、返回 Uint8Array|undefined
 * (对齐 lead.ts resolvePubkey 端口)。无额外缓存——verdicts 缓存已保证每个唯一 (context,delivery) 至多解析一次。
 * 失败一律 undefined(fail-closed):非法输入不回源、目录故障/畸形响应/非白名单纪元/跨队均静默降级为无法验签。
 */
export function createPubkeyResolver(
  opts: RegistryConnection,
  identity: RegistryIdentity,
): (nodeId: string, keyEpoch: number) => Promise<Uint8Array | undefined> {
  // Capture immutable config/identity; callers cannot mutate the trust binding after construction.
  const connection = { registryUrl: opts.registryUrl, nodeToken: opts.nodeToken };
  const teamId = identity.team_id;
  return async (nodeId, keyEpoch) => {
    try {
      // Validate inputs before any I/O: non-UUID sender or non-positive-integer epoch never hits the directory.
      if (!isUuid(nodeId) || !epoch(keyEpoch)) return undefined;
      const key = await fetchRegistryJson(connection, `/v1/nodes/${encodeURIComponent(nodeId)}/pubkey?epoch=${keyEpoch}`);
      // Same authenticated-endpoint guards as the envelope verifier: exact sender/epoch, current|historical only,
      // and team match when the directory echoes team_id (defense-in-depth; the live endpoint omits it).
      if (!record(key) || key.node_id !== nodeId || key.key_epoch !== keyEpoch ||
          (key.status !== 'current' && key.status !== 'historical') ||
          (key.team_id !== undefined && key.team_id !== teamId)) return undefined;
      return publicKey(key.pubkey) ?? undefined;
    } catch {
      // Includes directory outages, malformed keys and transport exceptions: never throw into acceptance.
      return undefined;
    }
  };
}