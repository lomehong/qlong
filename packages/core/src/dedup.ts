/**
 * R1 幂等去重(01 §6 R1,评审 I-01/I-02)。
 * 除 task.progress 外按 (task_id, attempt, type) 去重;progress 每条均处理(续租幂等),
 * 可选 seq 乱序丢弃由调用方处理。同键不同 body → mismatch(审计 dedup_mismatch 后丢弃)。
 * 去重状态保留期 ≥ max(offer_ttl, lease) × max_attempts + drain_ms(R1 下限)。
 */
import { jcs } from './jcs.js';
import { sha256Hex } from './hash.js';
import { dedupRetentionMs, type TaskKind } from './params.js';

export type DedupVerdict = { verdict: 'first' } | { verdict: 'duplicate' } | { verdict: 'mismatch' };

export interface DedupEntry {
  bodyHash: string;
  recordedAtMs: number;
}

export class DedupStore {
  private readonly map = new Map<string, DedupEntry>();
  private readonly retentionMs: number;
  private readonly clock: () => number;

  constructor(
    kindOrRetention: TaskKind | number = 'project',
    clock: () => number = () => Date.now(),
    paramsForRetention?: Parameters<typeof dedupRetentionMs>[1],
  ) {
    this.retentionMs =
      typeof kindOrRetention === 'number' ? kindOrRetention : dedupRetentionMs(kindOrRetention, paramsForRetention);
    this.clock = clock;
  }

  checkAndRecord(taskId: string, attempt: number, type: string, body: unknown): DedupVerdict {
    // R1:progress 豁免去重 —— 心跳即续租,每条均处理
    if (type === 'task.progress') return { verdict: 'first' };
    this.evict();
    const key = `${taskId}:${attempt}:${type}`;
    const bodyHash = sha256Hex(jcs(body));
    const prev = this.map.get(key);
    if (!prev) {
      this.map.set(key, { bodyHash, recordedAtMs: this.clock() });
      return { verdict: 'first' };
    }
    if (prev.bodyHash !== bodyHash) return { verdict: 'mismatch' };
    return { verdict: 'duplicate' };
  }

  private evict(): void {
    const now = this.clock();
    for (const [k, e] of this.map) {
      if (now - e.recordedAtMs > this.retentionMs) this.map.delete(k);
    }
  }

  get size(): number {
    return this.map.size;
  }
}