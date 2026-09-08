/**
 * 网关跨进程总线(v0.8,02 §12.1 的可替换传输实现)。
 *
 * 语义约定(与 GatewayCluster.route 对齐):
 * - publish 逐个尝试 peers;远端返回 delivered(节点连在彼处,已推送)或
 *   queued(已入彼处收件箱)即成功;not_here(彼处不认识该节点)→ 尝试下一个;
 * - 全部失败 → false,调用方本地兜底入箱(正确性仍由端上 R1/R2 兜底);
 * - 鉴权:x-qlong-cluster-secret 共享密钥头(集群内部信任域,评审 I-02 网关作恶
 *   缓解的同域假设不变)。
 *
 * 传输可替换:本实现为 HTTP 中继;Redis pub/sub 等传输按同接口替换即可。
 */
import type { EnvelopeV1 } from '@qlong/core';

export interface ClusterPeer {
  name: string;
  /** 远端网关 HTTP 基地址(如 https://gw2.internal:3100) */
  url: string;
}

/** publish 结果:delivered/queued = 远端已接管;false = 无人接管(耗尽/不可达),调用方本地兜底 */
export type BusPublishResult = 'delivered' | 'queued' | false;

export interface HttpClusterBusOptions {
  /** 集群共享密钥(须与各 peer 的 clusterSecret 一致) */
  secret: string;
  peers: ClusterPeer[];
  /** 单 peer 超时 ms(默认 2000) */
  timeoutMs?: number;
  /** 测试注入 */
  fetchImpl?: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
}

export class HttpClusterBus {
  private readonly peers: ClusterPeer[];
  private readonly secret: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

  constructor(opts: HttpClusterBusOptions) {
    this.peers = opts.peers;
    this.secret = opts.secret;
    this.timeoutMs = opts.timeoutMs ?? 2_000;
    this.fetchImpl = opts.fetchImpl ?? (async (url, init) => {
      const res = await fetch(url, init);
      return { ok: res.ok, status: res.status, text: () => res.text() };
    });
  }

  get peerCount(): number {
    return this.peers.length;
  }

  /**
   * 投递到集群:按序尝试 peers,首个 delivered/queued 即成功返回;
   * 全部失败(not_here/不可达/密钥错)→ false(ClusterBus 契约:调用方本地兜底)。
   */
  async publish(toNodeId: string, envelope: EnvelopeV1): Promise<BusPublishResult> {
    for (const peer of this.peers) {
      try {
        const res = await this.fetchImpl(joinUrl(peer.url, '/internal/envelope'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-qlong-cluster-secret': this.secret,
          },
          body: JSON.stringify({ to_node_id: toNodeId, envelope }),
        });
        if (res.status === 200) {
          const data = JSON.parse(await res.text()) as { result?: string };
          if (data.result === 'delivered' || data.result === 'queued') return data.result;
        }
        // 非 200(密钥错/路径错)= 该 peer 不可用 → 尝试下一个
      } catch {
        /* peer 不可达 → 下一个 */
      }
    }
    return false;
  }

}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/$/, '') + path;
}
