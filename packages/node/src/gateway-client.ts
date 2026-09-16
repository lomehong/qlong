/**
 * 网关客户端(M2):A3 首帧认证(token 不进 URL)、outbox 未获回执不删除(R11)、
 * 指数退避重连、入站信封验签钩子(A4 闸1,验证失败静默计数)。
 */
import WebSocket from 'ws';
import {
  CUSTODY_FEATURES, DEFAULT_PARAMS, MAX_TRANSPORT_BYTES, TRANSPORT_VERSION,
  envelopeDigest, hasCustodyFeatures, isGatewayAck, isRoutingDenied, isStoredFrame,
  newId, validateEnvelope, type DeliveryFrame, type EnvelopeV1, type QlongParams,
} from '@qlong/core';
import { MemoryOutbox, type OutboxStore } from './outbox.js';
import { FileOutbox } from './outbox/file-outbox.js';
import { RuntimeStoreError, type NodeRuntimeStore } from './runtime/store.js';
import { backoffDelay, shouldReconnect, DEFAULT_WEAK_NET } from './weak-net.js';

export const AUTH_KEY = 'node_' + 'token';
const WINDOW = 16;
const WINDOW_MS = 100;
const MAX_RETRY_MS = 5_000;
// Match gateway framing allowance; the envelope itself remains limited separately.
const MAX_FRAME_BYTES = MAX_TRANSPORT_BYTES + 4_096;
const MAX_BUFFERED_BYTES = 4 * MAX_TRANSPORT_BYTES;
const permanentClose = (code: number): boolean => code >= 4000 && code <= 4004;

/** User callbacks are notifications, never part of a storage/network transaction. */
function notify(callback: () => void): void {
  try { void Promise.resolve(callback()).catch(() => {}); } catch { /* Isolate observers. */ }
}

export interface GatewayClientOptions {
  url: string;
  nodeToken: string;
  params?: QlongParams;
  outbox?: OutboxStore;
  /** Requires transport v2; cannot be combined with a legacy outbox/dataDir. */
  runtime?: NodeRuntimeStore;
  /** v0.2:传入 dataDir 时由调用方创建 FileOutbox 传入(session 工厂辅助) */
  dataDir?: string;
  onEnvelope?: (env: EnvelopeV1) => void;
  /** stored reports transport custody only, never task acceptance or lease renewal. */
  onAck?: (ack: { ack_type: string; msg_id: string; reason?: string }) => void;
  onRoutingDenied?: (d: { rule: string; reason_code: string; msg_id: string }) => void;
  /** A4 闸1:入站验签;false/抛错 → 静默丢弃 + 计数(不回调 onEnvelope) */
  verifyInbound?: (env: EnvelopeV1) => Promise<boolean>;
  /** Finite verification deadline (default 5s); a timeout permanently stops this client. */
  verifyTimeoutMs?: number;
  onClose?: (code: number) => void;
  /** Notification only: committed runtime.pending() is the source of custody. */
  onInboxReady?: () => void;
  /** Storage admission stopped. No potentially sensitive Error is exposed. */
  onFault?: () => void;
  handshakeTimeoutMs?: number;
  /** 重连基础退避(指数,封顶 5s) */
  backoffMs?: number;
}

export type SendReceipt = 'stored' | 'delivered' | 'queued' | 'rejected' | 'timeout';

export class GatewayClient {
  state: 'idle' | 'connecting' | 'authed' | 'closed' = 'idle';
  /** A4 静默丢弃计数(可观测性) */
  rejectedInbound = 0;

  private ws?: WebSocket;
  private readonly runtime?: NodeRuntimeStore;
  readonly outbox: OutboxStore;
  private ackWaiters = new Map<string, Set<(receipt: SendReceipt) => void>>();
  private reconnectAttempts = 0;
  private closedByUser = false;
  private stopped = false;
  private faulted = false;
  private retryTimer?: NodeJS.Timeout;
  private windowAt = 0;
  private windowSends = 0;
  private retryNotBefore = new Map<string, number>();
  private inbound: Array<{ ws: WebSocket; envelope: EnvelopeV1; delivery?: DeliveryFrame }> = [];
  private verifying = false;
  private cancelOpen?: () => void;

  /** 回调为可覆写实例字段(会话层在构造后绑定 onEnvelope) */
  verifyInbound: (env: EnvelopeV1) => Promise<boolean> = async () => false;
  onEnvelope: (env: EnvelopeV1) => void = () => {};
  onAck: (ack: { ack_type: string; msg_id: string; reason?: string }) => void = () => {};
  onRoutingDenied: (d: { rule: string; reason_code: string; msg_id: string }) => void = () => {};
  onClose: (code: number) => void = () => {};
  onInboxReady: () => void = () => {};
  onFault: () => void = () => {};
  constructor(private readonly opts: GatewayClientOptions) {
    if (opts.runtime && (opts.outbox !== undefined || opts.dataDir !== undefined)) {
      throw new TypeError('runtime cannot be combined with outbox or dataDir');
    }
    this.runtime = opts.runtime;
    this.outbox = this.runtime ?? opts.outbox ?? (opts.dataDir ? new FileOutbox(opts.dataDir) : new MemoryOutbox());
    this.verifyInbound = opts.verifyInbound ?? (async () => false);
    this.onEnvelope = opts.onEnvelope ?? (() => {});
    this.onAck = opts.onAck ?? (() => {});
    this.onRoutingDenied = opts.onRoutingDenied ?? (() => {});
    this.onClose = opts.onClose ?? (() => {});
    this.onInboxReady = opts.onInboxReady ?? (() => {});
    this.onFault = opts.onFault ?? (() => {});
  }

  get transportVersion(): 1 | 2 { return this.runtime ? TRANSPORT_VERSION : 1; }

  /** 建连 + 首帧认证;auth_ok 才 resolve */
  private openPromise?: Promise<void>;
  private reconnectTimer?: NodeJS.Timeout;

  /** 单飞:并发 open 共用同一建连(M2-03 客户端单飞) */
  open(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('gateway client stopped'));
    if (this.ws && this.isAuthed(this.ws)) return Promise.resolve();
    if (this.openPromise) return this.openPromise;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.closedByUser = false;
    const p = this.doOpen().catch(() => {
      if (this.openPromise === p && this.state === 'connecting') this.state = 'idle';
      throw new Error('gateway connection failed');
    }).finally(() => {
      if (this.openPromise !== p) return;
      this.openPromise = undefined;
      if (this.state === 'idle') this.scheduleReconnect();
    });
    this.openPromise = p;
    return p;
  }

  private doOpen(): Promise<void> {
    this.state = 'connecting';
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.url, { maxPayload: MAX_FRAME_BYTES });
      this.ws = ws;
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.cancelOpen === cancel) this.cancelOpen = undefined;
        if (ok) resolve();
        else reject(new Error('gateway handshake failed'));
      };
      const cancel = (): void => finish(false);
      this.cancelOpen = cancel;
      const timeout = this.opts.handshakeTimeoutMs ?? 5_000;
      const timer = setTimeout(() => {
        if (this.ws !== ws || settled) return;
        finish(false);
        this.state = 'idle';
        ws.terminate();
      }, Number.isFinite(timeout) ? Math.max(1, Math.min(timeout, 30_000)) : 5_000);
      ws.on('error', () => {
        if (this.ws !== ws) return;
        finish(false);
        ws.terminate(); // close/finally arrange retry, including an initial connection failure.
      });
      ws.on('open', () => {
        if (this.ws !== ws || this.closedByUser || this.stopped) return;
        if (!this.safeSend({ frame: 'auth', [AUTH_KEY]: this.opts.nodeToken,
          ...(this.runtime ? { transport_version: TRANSPORT_VERSION, features: CUSTODY_FEATURES } : {}),
        }, ws)) ws.terminate();
      });
      ws.on('message', (data) => {
        if (this.ws === ws && !this.closedByUser && !this.stopped) {
          this.handleMessage(String(data), ws, () => finish(true));
        }
      });
      ws.on('close', (code) => {
        finish(false);
        if (this.ws !== ws) return;
        this.ws = undefined;
        if (permanentClose(code)) this.stopped = true;
        this.state = this.closedByUser || this.stopped ? 'closed' : 'idle';
        this.clearRetry();
        this.retryNotBefore.clear(); // Recompute retries from committed outbox metadata.
        this.inbound.length = 0;
        this.settleAll();
        notify(() => this.onClose(code));
        this.scheduleReconnect();
      });
    });
  }

  /**
   * 发送信封:完整校验(含签名域)→ 入 outbox → flush → 等回执。
   * 超时返回 'timeout',信封保留在 outbox,重连后自动重发(同一 msg_id,R11)。
   */
  async send(env: EnvelopeV1, opts: { ackTimeoutMs?: number } = {}): Promise<SendReceipt> {
    if (this.faulted) throw new Error('gateway storage unavailable');
    if (this.closedByUser || this.stopped) return 'timeout';
    const chk = validateEnvelope(env);
    if (!chk.ok) throw new Error('信封校验失败:' + chk.errors.join(';'));
    const msgId = env.msg_id;
    if (Buffer.byteLength(JSON.stringify(env)) > MAX_TRANSPORT_BYTES) {
      throw new TypeError('Envelope exceeds transport byte limit');
    }
    try {
      const prior = this.outbox.all().find((entry) => entry.envelope.msg_id === msgId);
      this.outbox.save({ envelope: env, attempts: prior?.attempts ?? 0, lastAt: prior?.lastAt ?? 0 });
      // Repeated send after a durable stored tombstone is already complete, including after restart.
      if (this.runtime?.delivery(msgId)?.status === 'stored') return 'stored';
    } catch (error) {
      if (this.runtime && error instanceof RuntimeStoreError && (error.code === 'FULL' || error.code === 'CONFLICT')) {
        this.flush(); // Rolled-back admission must not strand previously committed work.
        throw new RuntimeStoreError(error.code, error.code === 'FULL'
          ? 'gateway outbox capacity exhausted' : 'gateway outbound message identity conflict');
      }
      this.storageFault();
      throw new Error('gateway storage unavailable');
    }
    const timeout = opts.ackTimeoutMs ?? 5_000;
    const timeoutMs = Number.isFinite(timeout) ? Math.max(0, Math.min(timeout, 2_147_483_647)) : 5_000;
    return new Promise((resolve) => {
      const waiters = this.ackWaiters.get(msgId) ?? new Set<(receipt: SendReceipt) => void>();
      const finish = (receipt: SendReceipt): void => {
        clearTimeout(timer);
        waiters.delete(finish);
        if (!waiters.size && this.ackWaiters.get(msgId) === waiters) this.ackWaiters.delete(msgId);
        resolve(receipt);
      };
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      waiters.add(finish);
      this.ackWaiters.set(msgId, waiters);
      this.flush(); // Register first: even an immediate receipt cannot strand a waiter.
    });
  }

  /** Bounded live retries; lastAt ordering prevents old failures starving unsent work. */
  flush(): void {
    const ws = this.ws;
    if (!ws || !this.isAuthed(ws)) return;
    this.clearRetry();
    const now = Date.now();
    if (now - this.windowAt >= WINDOW_MS) { this.windowAt = now; this.windowSends = 0; }
    let pending = false;
    try {
      const entries = this.outbox.all().sort((a, b) => a.lastAt - b.lastAt);
      for (const entry of entries) {
        const id = entry.envelope.msg_id;
        if (entry.envelope.exp && Date.parse(entry.envelope.exp) <= now) {
          this.retryNotBefore.delete(id);
          continue; // Expiry stops attempts, never destroys custody/tracking.
        }
        const frame = { frame: 'envelope', envelope: entry.envelope };
        pending = true;
        if (this.windowSends >= WINDOW || ws.bufferedAmount >= MAX_BUFFERED_BYTES) break;
        if (now < (this.retryNotBefore.get(id) ?? 0) ||
            (entry.lastAt > 0 && now - entry.lastAt < this.retryDelay(entry.attempts))) continue;
        this.outbox.save({ ...entry, attempts: Math.min(Number.MAX_SAFE_INTEGER, entry.attempts + 1), lastAt: now });
        if (!this.safeSend(frame, ws)) break;
        this.windowSends += 1;
      }
    } catch { this.storageFault(); return; }
    if (this.isAuthed(ws)) {
      // Runtime transactions may add an outbox row without calling send().
      this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.flush(); }, pending ? WINDOW_MS : 1_000);
      this.retryTimer.unref();
    }
  }

  close(): void {
    this.closedByUser = true;
    this.state = 'closed';
    this.stopWork();
    const ws = this.ws;
    if (ws?.readyState === WebSocket.CONNECTING) ws.terminate();
    else ws?.close(1000, 'client closing');
  }

  private stopWork(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.clearRetry();
    this.retryNotBefore.clear();
    this.inbound.length = 0;
    this.cancelOpen?.();
    this.openPromise = undefined;
    this.settleAll();
  }

  private stop(code: number, reason: string): void {
    this.stopped = true;
    this.state = 'closed';
    this.stopWork();
    if (this.ws?.readyState === WebSocket.CONNECTING) this.ws.terminate();
    else this.ws?.close(code, reason);
  }

  private storageFault(): void {
    if (this.faulted) return;
    this.faulted = true;
    this.stop(1011, 'storage unavailable');
    notify(() => this.onFault());
  }

  private settle(msgId: string, receipt: SendReceipt, callback: () => void = () => {}): void {
    const waiters = this.ackWaiters.get(msgId);
    this.ackWaiters.delete(msgId);
    notify(callback);
    for (const finish of waiters ?? []) finish(receipt);
  }

  private settleAll(): void {
    for (const id of this.ackWaiters.keys()) this.settle(id, 'timeout');
  }

  private clearRetry(): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private retryDelay(attempts: number): number {
    const base = this.opts.backoffMs ?? 250;
    const bounded = Number.isFinite(base) ? Math.max(WINDOW_MS, Math.min(base, MAX_RETRY_MS)) : 250;
    return Math.min(MAX_RETRY_MS, bounded * 2 ** Math.min(10, Math.max(0, attempts - 1)));
  }

  private isAuthed(ws: WebSocket): boolean {
    return this.ws === ws && this.state === 'authed' && !this.closedByUser && !this.stopped &&
      ws.readyState === WebSocket.OPEN;
  }

  private handleMessage(raw: string, ws: WebSocket, onAuthOk: () => void): void {
    if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) { ws.close(1009, 'frame too large'); return; }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const f = parsed as Record<string, unknown>;
    if (f.frame === 'auth_ok') {
      const compatible = this.runtime
        ? f.transport_version === TRANSPORT_VERSION && hasCustodyFeatures(f.features) && f.node_id === this.runtime.nodeId
        : f.transport_version === undefined || f.transport_version === 1;
      if (!compatible) { this.stop(4004, 'version mismatch'); return; }
      if (this.state !== 'connecting') return;
      this.state = 'authed';
      this.reconnectAttempts = 0;
      this.flush();
      if (this.isAuthed(ws) && this.runtime) {
        let pending: boolean;
        try { pending = this.runtime.pending(1).length > 0; } catch { this.storageFault(); return; }
        if (pending) notify(() => this.onInboxReady());
      }
      if (this.isAuthed(ws)) onAuthOk();
      return;
    }
    if (!this.isAuthed(ws)) return;
    if (f.frame === 'closing') {
      if (typeof f.code === 'number' && permanentClose(f.code)) this.stop(f.code, 'gateway closing');
      return;
    }
    if (this.runtime && isStoredFrame(f)) {
      try {
        if (!this.runtime.stored(f.from_node, f.msg_id, f.digest)) return;
      } catch { this.storageFault(); return; }
      this.retryNotBefore.delete(f.msg_id);
      this.settle(f.msg_id, 'stored', () => this.onAck({ ack_type: 'stored', msg_id: f.msg_id }));
      return;
    }
    if (f.frame === 'ack') {
      if (this.runtime || !isGatewayAck(f)) return;
      const transient = f.ack_type === 'rejected' && (f.reason === 'internal_error' || f.reason === 'cluster_error');
      try { if (!transient) this.outbox.remove(f.msg_id); } catch { this.storageFault(); return; }
      this.settle(f.msg_id, f.ack_type, () => this.onAck(f));
      return;
    }
    if (f.frame === 'routing.denied') {
      if (!isRoutingDenied(f)) return;
      if (this.runtime) { notify(() => this.onRoutingDenied(f)); return; }
      try { this.outbox.remove(f.msg_id); } catch { this.storageFault(); return; }
      this.settle(f.msg_id, 'rejected', () => this.onRoutingDenied(f));
      return;
    }
    if (f.frame === 'nack' && this.runtime) {
      this.handleNack(f);
      return;
    }
    if (f.frame === (this.runtime ? 'delivery' : 'envelope')) this.admitInbound(f, ws);
  }

  private handleNack(f: Record<string, unknown>): void {
    if (f.from_node !== this.runtime!.nodeId || typeof f.msg_id !== 'string' ||
        typeof f.digest !== 'string' || typeof f.reason !== 'string' ||
        typeof f.retry_after_ms !== 'number' || !Number.isFinite(f.retry_after_ms)) return;
    try {
      const entry = this.outbox.all().find((item) => item.envelope.msg_id === f.msg_id);
      if (!entry || envelopeDigest(entry.envelope) !== f.digest) return;
      const delay = Math.max(WINDOW_MS, Math.min(MAX_RETRY_MS, f.retry_after_ms));
      this.retryNotBefore.set(f.msg_id, Date.now() + delay);
    } catch { this.storageFault(); }
  }

  private admitInbound(f: Record<string, unknown>, ws: WebSocket): void {
    if (this.inbound.length + Number(this.verifying) >= WINDOW) { this.rejectedInbound += 1; return; }
    let envelope: EnvelopeV1;
    try {
      const checked = validateEnvelope(f.envelope);
      if (!checked.ok) { this.rejectedInbound += 1; return; }
      envelope = checked.value;
      if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_TRANSPORT_BYTES) { this.rejectedInbound += 1; return; }
    } catch { this.rejectedInbound += 1; return; }
    let delivery: DeliveryFrame | undefined;
    if (this.runtime) {
      try {
        const sig = envelope.sig;
        if (envelope.to.node_id !== this.runtime.nodeId ||
            typeof f.ticket !== 'string' || !f.ticket.length || f.ticket.length > 128 ||
            typeof f.digest !== 'string' || f.digest !== envelopeDigest(envelope) ||
            !sig || sig.alg !== 'ed25519' || typeof sig.value !== 'string' ||
            Buffer.from(sig.value, 'base64').length !== 64 || Buffer.from(sig.value, 'base64').toString('base64') !== sig.value) {
          this.rejectedInbound += 1;
          return;
        }
        delivery = { frame: 'delivery', envelope, digest: f.digest, ticket: f.ticket };
      } catch { this.rejectedInbound += 1; return; }
    }
    this.inbound.push({ ws, envelope, delivery });
    void this.drainInbound();
  }

  private async drainInbound(): Promise<void> {
    if (this.verifying) return;
    this.verifying = true;
    try {
      while (this.inbound.length) {
        const item = this.inbound.shift()!;
        if (!this.isAuthed(item.ws)) continue;
        let verified: boolean | 'timeout' = false;
        let timer: NodeJS.Timeout | undefined;
        const timeout = this.opts.verifyTimeoutMs ?? 5_000;
        const timeoutMs = Number.isFinite(timeout) ? Math.max(1, Math.min(timeout, 30_000)) : 5_000;
        // The CURRENT instance verifier remains authoritative; no verifier means deny.
        try {
          verified = await Promise.race([
            this.verifyInbound(item.envelope),
            new Promise<'timeout'>((resolve) => {
              timer = setTimeout(() => resolve('timeout'), timeoutMs);
              timer.unref();
            }),
          ]);
        } catch { /* Fail closed. */ } finally { clearTimeout(timer); }
        if (verified === 'timeout') {
          this.rejectedInbound += 1;
          // Even across reconnects, never accumulate more unresolved verifier calls.
          this.stop(1011, 'verification timeout');
          return;
        }
        if (!this.isAuthed(item.ws)) continue;
        if (verified !== true) { this.rejectedInbound += 1; continue; }
        if (!item.delivery) { notify(() => this.onEnvelope(item.envelope)); continue; }
        const { digest, ticket } = item.delivery;
        try {
          // A verifier must not change the identity that was validated before awaiting it.
          if (envelopeDigest(item.envelope) !== digest) { this.rejectedInbound += 1; continue; }
        } catch { this.rejectedInbound += 1; continue; }
        let result: ReturnType<NodeRuntimeStore['receive']>;
        try { result = this.runtime!.receive(item.envelope); } catch { this.storageFault(); return; }
        if (result !== 'new' && result !== 'duplicate') { this.rejectedInbound += 1; continue; }
        this.safeSend({ frame: 'receipt', from_node: item.envelope.from.node_id,
          msg_id: item.envelope.msg_id, digest, ticket }, item.ws);
        if (result === 'new') notify(() => this.onInboxReady());
      }
    } finally { this.verifying = false; }
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.stopped || this.reconnectTimer !== undefined || this.openPromise || this.state !== 'idle') return;
    this.reconnectAttempts += 1;
    if (!shouldReconnect(this.reconnectAttempts)) return;
    const base = this.opts.backoffMs ?? DEFAULT_WEAK_NET.baseBackoffMs;
    const baseBackoffMs = Number.isFinite(base) ? Math.max(1, Math.min(base, MAX_RETRY_MS)) : DEFAULT_WEAK_NET.baseBackoffMs;
    const delay = Math.min(MAX_RETRY_MS, backoffDelay(this.reconnectAttempts, { ...DEFAULT_WEAK_NET, baseBackoffMs }));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.open().catch(() => { /* open.finally schedules the next attempt. */ });
    }, delay);
    this.reconnectTimer.unref();
  }

  private safeSend(obj: unknown, ws = this.ws): boolean {
    if (!ws || this.ws !== ws || ws.readyState !== WebSocket.OPEN || this.closedByUser || this.stopped) return false;
    try {
      const raw = JSON.stringify(obj);
      const bytes = Buffer.byteLength(raw);
      if (bytes > MAX_FRAME_BYTES || ws.bufferedAmount + bytes > MAX_BUFFERED_BYTES) return false;
      ws.send(raw, (error) => { if (error && this.ws === ws) ws.terminate(); });
      return true;
    } catch {
      ws.terminate();
      return false;
    }
  }
}

/** 测试/工具用:构造一个最小合法 msg_id */
export function freshMsgId(): string {
  return newId();
}

export { DEFAULT_PARAMS };