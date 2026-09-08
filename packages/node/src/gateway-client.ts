/**
 * 网关客户端(M2):A3 首帧认证(token 不进 URL)、outbox 未获回执不删除(R11)、
 * 指数退避重连、入站信封验签钩子(A4 闸1,验证失败静默计数)。
 */
import WebSocket from 'ws';
import { DEFAULT_PARAMS, newId, validateEnvelope, type EnvelopeV1, type QlongParams } from '@qlong/core';
import { MemoryOutbox, type OutboxStore } from './outbox.js';
import { FileOutbox } from './outbox/file-outbox.js';
import { backoffDelay, shouldReconnect, ConnTracker, DEFAULT_WEAK_NET } from './weak-net.js';

export const AUTH_KEY = 'node_' + 'token';

export interface GatewayClientOptions {
  url: string;
  nodeToken: string;
  params?: QlongParams;
  outbox?: OutboxStore;
  /** v0.2:传入 dataDir 时由调用方创建 FileOutbox 传入(session 工厂辅助) */
  dataDir?: string;
  onEnvelope?: (env: EnvelopeV1) => void;
  onAck?: (ack: { ack_type: string; msg_id: string; reason?: string }) => void;
  onRoutingDenied?: (d: { rule: string; reason_code: string; msg_id: string }) => void;
  /** A4 闸1:入站验签;false/抛错 → 静默丢弃 + 计数(不回调 onEnvelope) */
  verifyInbound?: (env: EnvelopeV1) => Promise<boolean>;
  onClose?: (code: number) => void;
  /** 重连基础退避(指数,封顶 5s) */
  backoffMs?: number;
}

export type SendReceipt = 'delivered' | 'queued' | 'rejected' | 'timeout';

export class GatewayClient {
  state: 'idle' | 'connecting' | 'authed' | 'closed' = 'idle';
  /** A4 静默丢弃计数(可观测性) */
  rejectedInbound = 0;

  private ws?: WebSocket;
  outbox: OutboxStore;
  private ackWaiters = new Map<string, (ack: { ack_type: string }) => void>();
  private reconnectAttempts = 0;
  private closedByUser = false;

  /** 回调为可覆写实例字段(会话层在构造后绑定 onEnvelope) */
  verifyInbound: (env: EnvelopeV1) => Promise<boolean> = async () => false;
  onEnvelope: (env: EnvelopeV1) => void = () => {};
  onAck: (ack: { ack_type: string; msg_id: string; reason?: string }) => void = () => {};
  onRoutingDenied: (d: { rule: string; reason_code: string; msg_id: string }) => void = () => {};
  onClose: (code: number) => void = () => {};
  constructor(private readonly opts: GatewayClientOptions) {
    this.outbox = opts.outbox ?? (opts.dataDir ? new FileOutbox(opts.dataDir) : new MemoryOutbox());
    this.verifyInbound = opts.verifyInbound ?? (async () => false);
    this.onEnvelope = opts.onEnvelope ?? (() => {});
    this.onAck = opts.onAck ?? (() => {});
    this.onRoutingDenied = opts.onRoutingDenied ?? (() => {});
    this.onClose = opts.onClose ?? (() => {});
  }

  /** 建连 + 首帧认证;auth_ok 才 resolve */
  private openPromise?: Promise<void>;
  private reconnectTimer?: NodeJS.Timeout;

  /** 单飞:并发 open 共用同一建连(M2-03 客户端单飞) */
  open(): Promise<void> {
    if (this.openPromise) return this.openPromise;
    const p = this.doOpen().finally(() => {
      this.openPromise = undefined;
    });
    this.openPromise = p;
    return p;
  }

  private doOpen(): Promise<void> {
    this.closedByUser = false;
    this.state = 'connecting';
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.url);
      this.ws = ws;
      let settled = false;
      ws.on('error', (e) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
        if (!this.closedByUser) this.scheduleReconnect();
      });
      ws.on('open', () => {
        this.safeSend({ frame: 'auth', [AUTH_KEY]: this.opts.nodeToken });
      });
      ws.on('message', (data) => {
        const firstOpen = !settled;
        this.handleMessage(String(data), () => {
          if (!settled) {
            settled = true;
            resolve();
          }
          void firstOpen;
        });
      });
      ws.on('close', (code) => {
        this.state = this.closedByUser ? 'closed' : 'idle';
        this.onClose(code);
        if (!settled) {
          settled = true;
          reject(new Error(`gateway closed during handshake (${code})`));
        }
        if (!this.closedByUser) this.scheduleReconnect();
      });
    });
  }

  /**
   * 发送信封:完整校验(含签名域)→ 入 outbox → flush → 等回执。
   * 超时返回 'timeout',信封保留在 outbox,重连后自动重发(同一 msg_id,R11)。
   */
  async send(env: EnvelopeV1, opts: { ackTimeoutMs?: number } = {}): Promise<SendReceipt> {
    const chk = validateEnvelope(env);
    if (!chk.ok) throw new Error('信封校验失败:' + chk.errors.join(';'));
    this.outbox.save({ envelope: env, attempts: 0, lastAt: 0 });
    this.flush();
    const timeoutMs = opts.ackTimeoutMs ?? 5_000;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), timeoutMs);
      this.ackWaiters.set(env.msg_id, (ack) => {
        clearTimeout(timer);
        resolve(ack.ack_type as SendReceipt);
      });
    });
  }

  /** 立即重发 outbox 全部(重连成功/定期调用) */
  flush(): void {
    if (this.state !== 'authed') return;
    for (const e of this.outbox.all()) {
      this.safeSend({ frame: 'envelope', envelope: e.envelope });
    }
  }

  close(): void {
    this.closedByUser = true;
    this.state = 'closed';
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.ws?.close(1000, 'client closing');
  }

  private handleMessage(raw: string, onAuthOk?: () => void): void {
    let f: Record<string, unknown>;
    try {
      f = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (f.frame === 'auth_ok') {
      this.state = 'authed';
      this.reconnectAttempts = 0;
      this.flush();
      onAuthOk?.();
      return;
    }
    if (f.frame === 'ack') {
      const ack = f as unknown as { ack_type: string; msg_id: string; reason?: string };
      this.outbox.remove(ack.msg_id);
      this.onAck(ack);
      const waiter = this.ackWaiters.get(ack.msg_id);
      if (waiter) {
        this.ackWaiters.delete(ack.msg_id);
        waiter(ack);
      }
      return;
    }
    if (f.frame === 'routing.denied') {
      const d = f as unknown as { rule: string; reason_code: string; msg_id: string };
      this.outbox.remove(d.msg_id); // routing.denied = 终局,不重发
      this.onRoutingDenied(d);
      const waiter = this.ackWaiters.get(d.msg_id);
      if (waiter) {
        this.ackWaiters.delete(d.msg_id);
        waiter({ ack_type: 'rejected' });
      }
      return;
    }
    if (f.frame === 'closing') return; // 随后的 ws close 带语义 code
    if (f.frame === 'envelope' && typeof f.envelope === 'object' && f.envelope !== null) {
      const env = f.envelope as EnvelopeV1;
      const chk = validateEnvelope(env);
      if (!chk.ok) {
        this.rejectedInbound += 1;
        return;
      }
      const verify = this.opts.verifyInbound;
      if (!verify) {
        this.onEnvelope(env);
        return;
      }
      verify(env)
        .then((ok) => {
          if (ok) this.onEnvelope(env);
          else this.rejectedInbound += 1;
        })
        .catch(() => {
          this.rejectedInbound += 1;
        });
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer !== undefined || this.openPromise) return;
    this.reconnectAttempts += 1;
    if (!shouldReconnect(this.reconnectAttempts)) return; // §8.6:超上限停止自动重连
    const base = this.opts.backoffMs ?? DEFAULT_WEAK_NET.baseBackoffMs;
    const delay = backoffDelay(this.reconnectAttempts, { ...DEFAULT_WEAK_NET, baseBackoffMs: base });
    this.reconnectTimer = setTimeout(() => {
    this.reconnectTimer = undefined;
    this.openWithRetry();
    }, delay);
  }

  private openWithRetry(): void {
    this.openPromise = this.open().catch(() => { /* 重连失败,下轮 scheduleReconnect */ }).finally(() => {
      this.openPromise = undefined;
    });
  }

  private safeSend(obj: unknown): void {
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
    } catch {
      /* 竞态忽略 */
    }
  }
}

/** 测试/工具用:构造一个最小合法 msg_id */
export function freshMsgId(): string {
  return newId();
}

export { DEFAULT_PARAMS };