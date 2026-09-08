/**
 * 最小指标集(01 §11,评审 I-34)——调参依据,全部进程内计数。
 * 六项:lost 判定数、drain 命中率分子(completed_before_cancel/reclaim 窗口交付)、
 * attempt 分布、reject/fail reason 直方图、心跳间隔抖动、escalate 率。
 * 导出为快照,采集端(console/日志)决定上报方式;协议层零依赖。
 */

export interface HeartbeatJitter {
  /** 最近一次相邻心跳回执间隔(ms) */
  lastIntervalMs: number;
  /** 观测到的最大间隔(ms)——超过 heartbeat_interval 即接近 lost 判定线 */
  maxIntervalMs: number;
  samples: number;
}

export interface MetricsSnapshot {
  lostCount: number;
  drainHits: number;
  /** 终态时的 attempt 值分布(键为 attempt 值) */
  attemptDistribution: Record<string, number>;
  rejectReasons: Record<string, number>;
  failReasons: Record<string, number>;
  heartbeat: HeartbeatJitter;
  escalateCount: number;
}

export class NodeMetrics {
  private lostCount = 0;
  private drainHits = 0;
  private escalateCount = 0;
  private readonly attemptDistribution = new Map<number, number>();
  private readonly rejectReasons = new Map<string, number>();
  private readonly failReasons = new Map<string, number>();
  private lastHeartbeatAt = 0;
  private readonly heartbeat: HeartbeatJitter = { lastIntervalMs: 0, maxIntervalMs: 0, samples: 0 };

  onLost(): void {
    this.lostCount += 1;
  }

  onDrainHit(): void {
    this.drainHits += 1;
  }

  onTerminal(attempt: number): void {
    this.attemptDistribution.set(attempt, (this.attemptDistribution.get(attempt) ?? 0) + 1);
  }

  onReject(reason: string): void {
    this.rejectReasons.set(reason, (this.rejectReasons.get(reason) ?? 0) + 1);
  }

  onFail(reason: string): void {
    this.failReasons.set(reason, (this.failReasons.get(reason) ?? 0) + 1);
  }

  onEscalate(): void {
    this.escalateCount += 1;
  }

  /** 心跳回执到达(R3 续租即调用);统计相邻间隔与最大间隔 */
  onHeartbeatAcked(nowMs: number): void {
    if (this.lastHeartbeatAt > 0) {
      const interval = nowMs - this.lastHeartbeatAt;
      this.heartbeat.lastIntervalMs = interval;
      this.heartbeat.maxIntervalMs = Math.max(this.heartbeat.maxIntervalMs, interval);
    }
    this.heartbeat.samples += 1;
    this.lastHeartbeatAt = nowMs;
  }

  snapshot(): MetricsSnapshot {
    const toObj = (m: Map<string, number>): Record<string, number> => Object.fromEntries(m);
    const attempts: Record<string, number> = {};
    for (const [k, v] of this.attemptDistribution) attempts[String(k)] = v;
    return {
      lostCount: this.lostCount,
      drainHits: this.drainHits,
      attemptDistribution: attempts,
      rejectReasons: toObj(this.rejectReasons),
      failReasons: toObj(this.failReasons),
      heartbeat: { ...this.heartbeat },
      escalateCount: this.escalateCount,
    };
  }
}
