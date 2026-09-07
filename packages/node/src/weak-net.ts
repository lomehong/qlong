/**
 * §8.6 弱网增强(评审 I-42/M3 补充):
 * - 指数退避加随机抖动(防止雷群效应)
 * - 连接状态追踪(供 R11 outbox 判断是否可 flush)
 * - 离线消息持久化阈值:离线超过 offlineThresholdMs 后,不再自动 flush(等待手动/定时触发)
 */
export interface WeakNetConfig {
  /** 基础退避 ms */
  baseBackoffMs: number;
  /** 最大退避 ms */
  maxBackoffMs: number;
  /** 最大重连次数(超过后不再自动重连) */
  maxReconnectAttempts: number;
  /** 抖动比例 0-1(0=无抖动,1=全量随机) */
  jitterRatio: number;
}

export const DEFAULT_WEAK_NET: WeakNetConfig = {
  baseBackoffMs: 25,
  maxBackoffMs: 5_000,
  maxReconnectAttempts: 20,
  jitterRatio: 0.3,
};

/** 计算退避延迟:指数 + 随机抖动 */
export function backoffDelay(attempt: number, cfg: WeakNetConfig = DEFAULT_WEAK_NET): number {
  const exp = Math.min(cfg.baseBackoffMs * 2 ** Math.min(attempt, 10), cfg.maxBackoffMs);
  const jitter = exp * cfg.jitterRatio * Math.random();
  return Math.floor(exp + jitter);
}

/** 是否应继续重连 */
export function shouldReconnect(attempt: number, cfg: WeakNetConfig = DEFAULT_WEAK_NET): boolean {
  return attempt < cfg.maxReconnectAttempts;
}

/** 连接状态追踪器(供 outbox flush 策略) */
export type ConnState = 'connected' | 'connecting' | 'disconnected';

export class ConnTracker {
  private state: ConnState = 'disconnected';
  private disconnectedAt = 0;
  private listeners: Array<(s: ConnState) => void> = [];

  get current(): ConnState { return this.state; }
  get offlineDurationMs(): number {
    return this.state === 'disconnected' ? Date.now() - this.disconnectedAt : 0;
  }

  set(s: ConnState): void {
    if (this.state === s) return;
    const prev = this.state;
    this.state = s;
    if (s === 'disconnected' && prev !== 'disconnected') this.disconnectedAt = Date.now();
    for (const fn of this.listeners) fn(s);
  }

  onStateChange(fn: (s: ConnState) => void): void {
    this.listeners.push(fn);
  }
}