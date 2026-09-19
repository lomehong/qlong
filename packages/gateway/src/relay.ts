/**
 * custody 集群中继通知客户端(d1d,设计 docs/repair/CLUSTER-REGISTRY.md §4.4)。
 *
 * 与 legacy HttpClusterBus 的本质区别:**只传 {to_node_id, generation} 通知,不传 payload** ——
 * payload 已在任何推送前落共享 SqliteCustodyStore(store-then-push),通知只是让持有该节点
 * claim 的 authority 立即泵,把跨进程延迟从彼方周期泵上限(≤100ms)压到即时。
 * 通知是 best-effort 延迟优化:丢失/失败不破坏交付正确性(设计 §1 约束 2),故逐 peer 吞错。
 *
 * 传输可替换(同 HttpClusterBus 哲学):本实现为 HTTP;Redis pub/sub 等按同接口替换。
 */
import { QLONG_USER_AGENT } from '@qlong/core';

export interface PumpRelayPeer {
  name: string;
  /** 远端网关 HTTP 基地址(如 https://gw2.internal:7860) */
  url: string;
}

export interface PumpRelayOptions {
  /** 中继共享密钥(须与各 peer 的 relaySecret 一致;独立于 legacy clusterSecret) */
  secret: string;
  peers: PumpRelayPeer[];
  /** 单 peer 超时 ms(默认 1000) */
  timeoutMs?: number;
  /** 测试注入 */
  fetchImpl?: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;
}

export class PumpRelay {
  private readonly peers: PumpRelayPeer[];
  private readonly secret: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

  constructor(opts: PumpRelayOptions) {
    this.peers = opts.peers;
    this.secret = opts.secret;
    this.timeoutMs = opts.timeoutMs ?? 1_000;
    this.fetchImpl = opts.fetchImpl ?? (async (url, init) => {
      const res = await fetch(url, { ...init, headers: { ...init.headers, 'User-Agent': QLONG_USER_AGENT }, signal: AbortSignal.timeout(this.timeoutMs) });
      return { ok: res.ok, status: res.status };
    });
  }

  get peerCount(): number {
    return this.peers.length;
  }

  /**
   * 通知所有 peer "泵节点 N"(携带彼方签发的 generation 供 fence 校验)。
   * 逐 peer 并发、吞错 —— 任何失败都不上抛(调用方 fire-and-forget)。
   */
  async notify(toNodeId: string, generation: number): Promise<void> {
    await Promise.all(this.peers.map(async (peer) => {
      try {
        await this.fetchImpl(joinUrl(peer.url, '/internal/pump'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-qlong-relay-secret': this.secret },
          body: JSON.stringify({ to_node_id: toNodeId, generation }),
        });
      } catch {
        /* peer 不可达:彼方周期泵兜底(≤100ms),正确性不依赖本通知 */
      }
    }));
  }

}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/$/, '') + path;
}
