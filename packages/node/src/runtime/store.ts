import type { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import {
  envelopeDigest, isUuid, jcs, MAX_TRANSPORT_BYTES, sha256Hex, validateEnvelope, type EnvelopeV1,
} from '@qlong/core';
import { StorageError, type SqliteStore } from '../../../storage/src/index.js';
import type { OutboxEntry, OutboxStore } from '../outbox.js';

export type RuntimeJson = null | boolean | number | string | RuntimeJson[] | { [key: string]: RuntimeJson };
export interface RuntimeState { key: string; revision: number; value: RuntimeJson }
export interface EffectIntent { id: string; kind: string; payload: RuntimeJson }
export interface RuntimeEffect extends EffectIntent {
  stateKey: string;
  revision: number;
  status: 'pending' | 'done';
}
export interface ConsumeRequest {
  fromNode: string;
  msgId: string;
  stateKey: string;
  /** 0 means no state yet. A stale caller is rejected before its transform runs. */
  expectedRevision: number;
}
export interface RuntimeTransition {
  state: RuntimeJson;
  /** Already signed, fixed IDs/bytes: no signer or transport is invoked in the transaction. */
  outbox?: EnvelopeV1[];
  effects?: EffectIntent[];
}
export type ConsumeResult = { status: 'missing' } | {
  status: 'applied' | 'duplicate' | 'conflict'; revision: number;
};
export type RuntimeTransform = (input: {
  envelope: EnvelopeV1; state: RuntimeState | undefined;
}) => RuntimeTransition;

export class RuntimeStoreError extends Error {
  constructor(readonly code: 'FULL' | 'CONFLICT' | 'STALE' | 'UNVERIFIED_CUSTODY', message: string) {
    super(message);
    this.name = 'RuntimeStoreError';
  }
}

function integer(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a nonnegative safe integer`);
}

function key(value: string): void {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 1024) {
    throw new TypeError('Runtime key must contain 1..1024 UTF-8 bytes');
  }
}

function usesR1Dedup(type: string): boolean {
  return type.startsWith('task.') && type !== 'task.progress' && type !== 'task.lease.renew';
}

/** Reject lossy JSON, getters, custom serialization and cycles before calling JCS. */
function json(value: unknown): string {
  const seen = new Set<object>();
  function visit(item: unknown, depth: number): void {
    if (depth > 64) throw new TypeError('Runtime JSON nesting exceeds 64');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || seen.has(item)) throw new TypeError('Runtime values must be JSON data');
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Runtime values must be plain JSON data');
    }
    seen.add(item);
    const properties = Reflect.ownKeys(item);
    if (array && properties.length !== item.length + 1) throw new TypeError('Sparse/extended arrays are not JSON data');
    for (const name of properties) {
      if (array && name === 'length') continue;
      const property = Object.getOwnPropertyDescriptor(item, name)!;
      if (typeof name !== 'string' || !property.enumerable || !('value' in property)) {
        throw new TypeError('Runtime values must not contain accessors or hidden properties');
      }
      if (array && (!/^(0|[1-9][0-9]*)$/.test(name) || Number(name) >= item.length)) {
        throw new TypeError('Sparse/extended arrays are not JSON data');
      }
      visit(property.value, depth + 1);
    }
    seen.delete(item);
  }
  visit(value, 0);
  return jcs(value);
}

function envelope(value: EnvelopeV1): { env: EnvelopeV1; payload: string; digest: string } {
  const payload = json(value);
  if (Buffer.byteLength(payload) > MAX_TRANSPORT_BYTES) throw new TypeError('Envelope exceeds transport byte limit');
  const parsed: unknown = JSON.parse(payload);
  const checked = validateEnvelope(parsed);
  if (!checked.ok) throw new TypeError('Invalid runtime envelope');
  // Format only. Authenticity/authorization MUST be verified by the client before receive().
  const env = checked.value;
  if (!env.sig || env.sig.alg !== 'ed25519' || typeof env.sig.value !== 'string' ||
      Buffer.from(env.sig.value, 'base64').length !== 64 ||
      Buffer.from(env.sig.value, 'base64').toString('base64') !== env.sig.value) throw new TypeError('Signed envelope required');
  return { env, payload, digest: envelopeDigest(env) };
}

type Row = Record<string, unknown>;
const DOMAIN_TABLES = ['node_inbox', 'node_delivery', 'node_outbox', 'node_state', 'node_dedup', 'node_effects'] as const;
const OUTBOUND_ROWS = `SELECT d.*, o.sender AS outbox_sender, o.payload, o.attempts, o.last_at
  FROM node_delivery d LEFT JOIN node_outbox o USING (sender, msg_id)`;
// node:sqlite returns TEXT columns truncated at the first NUL, but state keys may embed NULs.
// Every node_state read projects the key as a BLOB so decodeState can recover the exact bytes.
const STATE_ROWS = `SELECT *, CAST(state_key AS BLOB) AS state_key_bytes FROM node_state`;

function valid(condition: unknown): asserts condition {
  // Never expose persisted payloads/values in recovery errors.
  if (!condition) throw new StorageError('DATABASE_CORRUPT', 'Invalid runtime state; explicit recovery required');
}

function query(db: DatabaseSync, sql: string) {
  const statement = db.prepare(sql);
  // Inspect unsafe SQLite integers ourselves rather than leaking ERR_OUT_OF_RANGE without poisoning.
  statement.setReadBigInts(true);
  return statement;
}

function storedInteger(value: unknown, minimum = 0): number {
  valid(typeof value === 'bigint' || typeof value === 'number');
  const number = Number(value);
  valid(Number.isSafeInteger(number) && number >= minimum);
  return number;
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

/** undefined disables retention GC (tombstones persist forever); 0 reclaims terminal rows immediately. */
function retentionWindow(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Runtime retentionMs must be a nonnegative safe integer');
  return value;
}

/** Terminal-age stamp read back from node_delivery; NULL for pending rows and pre-feature tombstones. */
function storedTime(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  valid(typeof value === 'bigint' || typeof value === 'number');
  const number = Number(value);
  valid(Number.isSafeInteger(number) && number >= 0 && number <= 8_640_000_000_000_000);
  return number;
}

function storedKey(value: unknown): asserts value is string {
  valid(typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 1024);
}

function storedIdentity(row: Row): void {
  valid(isUuid(row.sender) && isUuid(row.msg_id) && typeof row.digest === 'string' && /^[0-9a-f]{64}$/.test(row.digest));
}

function storedJson(value: unknown): RuntimeJson {
  valid(typeof value === 'string');
  try {
    const parsed: unknown = JSON.parse(value);
    valid(json(parsed) === value);
    return parsed as RuntimeJson;
  } catch { throw new StorageError('DATABASE_CORRUPT', 'Invalid runtime JSON; explicit recovery required'); }
}

/**
 * One node identity per SQLite database. Every read is detached, every mutation is committed
 * before returning. Capacity includes ALL domain rows (including tombstones, state and effects),
 * with logical bytes as defined by node_runtime_usage; SQLite/WAL disk usage needs external limits.
 * Terminal 'stored' delivery tombstones persist until an optional retentionMs window drives prune();
 * pending deliveries, undelivered payloads, inbox/state/dedup/effects are NEVER reclaimed, so an
 * exhausted budget still requires explicit operational intervention rather than silent data loss.
 * This API does NOT make the existing RemoteNodeSession atomic.
 */
export class NodeRuntimeStore implements OutboxStore {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly retentionMs: number | undefined;
  private readonly clock: () => number;

  constructor(private readonly store: SqliteStore, readonly nodeId: string,
    options: { maxEntries?: number; maxBytes?: number; retentionMs?: number; now?: () => number } = {}) {
    if (!isUuid(nodeId)) throw new TypeError('Runtime nodeId must be a UUID');
    this.maxEntries = options.maxEntries ?? 10_000;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    integer(this.maxEntries, 'maxEntries');
    integer(this.maxBytes, 'maxBytes');
    this.retentionMs = retentionWindow(options.retentionMs);
    this.clock = options.now ?? (() => Date.now());
    store.transaction((db) => {
      if (db.prepare('SELECT schema_id FROM _qlong_storage WHERE id = 1').get()?.schema_id !== 'qlong.node') {
        throw new TypeError('NodeRuntimeStore requires NODE_SCHEMA');
      }
      const identities = query(db, 'SELECT * FROM node_identity').iterate();
      let pinned = false;
      for (const identity of identities) {
        valid(!pinned && storedInteger(identity.id) === 1 && isUuid(identity.node_id));
        if (identity.node_id !== nodeId) throw new TypeError('Runtime database belongs to another node');
        pinned = true;
      }
      if (!pinned) {
        // Only a genuinely empty runtime may bootstrap. Lost identity is not permission to repin.
        for (const table of DOMAIN_TABLES) valid(!db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get());
        db.prepare('INSERT INTO node_identity VALUES (1, ?)').run(nodeId);
      }
      this.validateStartup(db);
    });
  }

  private validateStartup(db: DatabaseSync): void {
    valid(!query(db, 'PRAGMA foreign_key_check').get());
    // Stream one row at a time: no full-table arrays or retained payload/state caches at startup.
    for (const row of query(db, OUTBOUND_ROWS).iterate()) this.readDelivery(row);
    for (const row of query(db, STATE_ROWS).iterate()) this.decodeState(row);
    for (const row of query(db, 'SELECT * FROM node_inbox').iterate()) this.readInbox(db, row);
    for (const row of query(db, 'SELECT * FROM node_dedup').iterate()) this.readDedup(db, row);
    for (const row of query(db, 'SELECT * FROM node_effects').iterate()) this.readEffect(db, row);
  }

  private readEnvelope(row: Row, outbound: boolean): EnvelopeV1 {
    storedIdentity(row);
    valid(typeof row.payload === 'string' && Buffer.byteLength(row.payload) <= MAX_TRANSPORT_BYTES);
    try {
      const encoded = envelope(JSON.parse(row.payload) as EnvelopeV1);
      valid(encoded.payload === row.payload && encoded.digest === row.digest &&
        encoded.env.from.node_id === row.sender && encoded.env.msg_id === row.msg_id &&
        (outbound ? encoded.env.from.node_id : encoded.env.to.node_id) === this.nodeId);
      return encoded.env;
    } catch { throw new StorageError('DATABASE_CORRUPT', 'Invalid runtime envelope; explicit recovery required'); }
  }

  private readDelivery(row: Row): OutboxEntry | undefined {
    storedIdentity(row);
    valid(row.sender === this.nodeId && (row.status === 'pending' || row.status === 'stored'));
    valid((row.status === 'pending') === (row.outbox_sender !== null));
    // stored_at is stamped exactly when a delivery turns terminal: a pending row must not carry it, while a
    // 'stored' tombstone may be NULL only for pre-feature rows migrated in (never reclaimed by retention GC).
    const storedAt = storedTime(row.stored_at);
    if (row.status === 'pending') valid(storedAt === null);
    if (row.status === 'stored') {
      valid(row.payload === null && row.attempts === null && row.last_at === null);
      return;
    }
    valid(row.outbox_sender === row.sender);
    return { envelope: this.readEnvelope(row, true), attempts: storedInteger(row.attempts), lastAt: storedInteger(row.last_at) };
  }

  private findDelivery(db: DatabaseSync, sender: string, msgId: string): Row | undefined {
    const row = query(db, `${OUTBOUND_ROWS} WHERE d.sender = ? AND d.msg_id = ?`).get(sender, msgId);
    if (row) this.readDelivery(row);
    else valid(!db.prepare('SELECT 1 FROM node_outbox WHERE sender = ? AND msg_id = ?').get(sender, msgId));
    return row;
  }

  private readInbox(db: DatabaseSync, row: Row): EnvelopeV1 | undefined {
    storedIdentity(row);
    if (row.decision === 'pending') {
      valid(row.state_key === null && row.revision === null);
      return this.readEnvelope(row, false);
    }
    valid(row.decision === 'applied' || row.decision === 'duplicate' || row.decision === 'conflict');
    valid(row.payload === null);
    storedKey(row.state_key);
    const revision = storedInteger(row.revision, row.decision === 'applied' ? 1 : 0);
    const state = this.readState(db, row.state_key);
    valid(revision === 0 || (state !== undefined && state.revision >= revision));
  }

  private decodeState(row: Row): RuntimeState {
    // Recover the key from its BLOB projection: the TEXT column is truncated at any embedded NUL.
    const bytes = row.state_key_bytes;
    valid(bytes instanceof Uint8Array);
    const stateKey = Buffer.from(bytes).toString('utf8');
    storedKey(stateKey);
    return { key: stateKey, revision: storedInteger(row.revision, 1), value: storedJson(row.value) };
  }

  private readDedup(db: DatabaseSync, row: Row): void {
    valid(isUuid(row.sender) && typeof row.digest === 'string' && /^[0-9a-f]{64}$/.test(row.digest));
    storedKey(row.state_key);
    const parts = storedJson(row.dedup_key);
    valid(Array.isArray(parts) && parts.length === 3 && isUuid(parts[0]) &&
      typeof parts[1] === 'number' && Number.isSafeInteger(parts[1]) && parts[1] > 0 &&
      typeof parts[2] === 'string' && /^task\.[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(parts[2]) && usesR1Dedup(parts[2]));
    valid(this.readState(db, row.state_key) !== undefined);
  }

  private readEffect(db: DatabaseSync, row: Row): { effect: RuntimeEffect; currentRevision: number } {
    storedKey(row.effect_id);
    storedKey(row.state_key);
    storedKey(row.kind);
    valid(row.status === 'pending' || row.status === 'done');
    const revision = storedInteger(row.revision, 1);
    const state = this.readState(db, row.state_key);
    valid(state !== undefined && state.revision >= revision);
    return { effect: { id: row.effect_id, stateKey: row.state_key, revision, kind: row.kind,
      payload: storedJson(row.payload), status: row.status }, currentRevision: state.revision };
  }

  usage(): { entries: number; bytes: number } { return this.store.transaction((db) => this.readUsage(db)); }

  private readUsage(db: DatabaseSync): { entries: number; bytes: number } {
    const row = query(db, 'SELECT entries, bytes FROM node_runtime_usage').get();
    valid(row);
    return { entries: storedInteger(row.entries), bytes: storedInteger(row.bytes) };
  }

  private capacity(db: DatabaseSync): void {
    const { entries, bytes } = this.readUsage(db);
    if (entries > this.maxEntries || bytes > this.maxBytes) {
      throw new RuntimeStoreError('FULL', 'Runtime capacity exhausted; no records evicted');
    }
  }

  all(): OutboxEntry[] {
    return this.store.transaction((db) => {
      valid(!db.prepare(`SELECT 1 FROM node_outbox o LEFT JOIN node_delivery d USING (sender, msg_id)
        WHERE d.sender IS NULL LIMIT 1`).get());
      const entries: OutboxEntry[] = [];
      for (const row of query(db, `${OUTBOUND_ROWS} WHERE d.status != 'stored' OR o.sender IS NOT NULL ORDER BY o.rowid`).iterate()) {
        const entry = this.readDelivery(row);
        if (entry) entries.push(entry);
      }
      return entries;
    });
  }

  save(entry: OutboxEntry): void {
    this.store.transaction((db) => {
      this.saveEntry(db, entry);
      this.capacity(db);
    });
  }

  private saveEntry(db: DatabaseSync, entry: OutboxEntry): void {
    const { env, payload, digest } = envelope(entry.envelope);
    if (env.from.node_id !== this.nodeId) throw new TypeError('Outbox sender must be the local node');
    integer(entry.attempts, 'attempts');
    integer(entry.lastAt, 'lastAt');
    const prior = this.findDelivery(db, this.nodeId, env.msg_id);
    if (prior) {
      if (prior.digest !== digest) throw new RuntimeStoreError('CONFLICT', 'Outbound message identity is immutable');
      if (prior.status === 'stored') return; // Retained delivery identity forbids resurrection.
      db.prepare('UPDATE node_outbox SET attempts = ?, last_at = ? WHERE sender = ? AND msg_id = ?')
        .run(entry.attempts, entry.lastAt, this.nodeId, env.msg_id);
      return;
    }
    db.prepare("INSERT INTO node_delivery (sender, msg_id, digest, status) VALUES (?, ?, ?, 'pending')").run(this.nodeId, env.msg_id, digest);
    db.prepare('INSERT INTO node_outbox VALUES (?, ?, ?, ?, ?)')
      .run(this.nodeId, env.msg_id, payload, entry.attempts, entry.lastAt);
  }

  /** Legacy structural compatibility only: an unverified ACK can NEVER release custody. */
  remove(_msgId: string): never {
    throw new RuntimeStoreError('UNVERIFIED_CUSTODY', 'Use stored(fromNode, msgId, digest), not remove(msgId)');
  }

  /** Detached persisted tracking; does not change custody or require a live connection. */
  delivery(msgId: string): { status: 'pending' | 'stored'; digest: string } | undefined {
    if (!isUuid(msgId)) return;
    return this.store.transaction((db) => {
      const row = this.findDelivery(db, this.nodeId, msgId);
      return row ? { status: row.status as 'pending' | 'stored', digest: row.digest as string } : undefined;
    });
  }

  /** Call only for a verified custody frame from the authenticated gateway. Idempotent. */
  stored(fromNode: string, msgId: string, digest: string): boolean {
    if (fromNode !== this.nodeId || !isUuid(msgId) || !/^[0-9a-f]{64}$/.test(digest)) return false;
    return this.store.transaction((db) => {
      // Validate the joined payload before either updating metadata or releasing custody.
      const row = this.findDelivery(db, fromNode, msgId);
      if (!row || row.digest !== digest) return false;
      const now = this.clock();
      if (!validTime(now)) throw new TypeError('Runtime clock must return a nonnegative safe-integer epoch millisecond');
      // Stamp the terminal age once, guarded on the pending->stored transition, so a replayed verified
      // custody frame cannot reset it and starve retention GC.
      db.prepare("UPDATE node_delivery SET status = 'stored', stored_at = ? WHERE sender = ? AND msg_id = ? AND status = 'pending'")
        .run(now, fromNode, msgId);
      db.prepare('DELETE FROM node_outbox WHERE sender = ? AND msg_id = ?').run(fromNode, msgId);
      return true;
    });
  }

  /**
   * Retention GC: reclaim 'stored' delivery tombstones whose terminal age reached the configured window.
   * Disabled (returns 0) without retentionMs or on an invalid clock; a pending delivery is NEVER reclaimed.
   * Each tombstone is validated before deletion, so corruption faults the store instead of being concealed.
   */
  prune(): number {
    if (this.retentionMs === undefined) return 0;
    const now = this.clock();
    if (!validTime(now)) return 0;
    const cutoff = now - this.retentionMs;
    return this.store.transaction((db) => {
      const rows = query(db, `${OUTBOUND_ROWS} WHERE d.status = 'stored' AND d.stored_at IS NOT NULL AND d.stored_at <= ?`).all(cutoff);
      for (const row of rows) this.readDelivery(row); // validate before release; corruption must not be concealed by GC
      return Number(db.prepare("DELETE FROM node_delivery WHERE status = 'stored' AND stored_at IS NOT NULL AND stored_at <= ?").run(cutoff).changes);
    });
  }

  /** Commit BEFORE issuing the receiver receipt. Malformed/misdirected envelopes throw. */
  receive(value: EnvelopeV1): 'new' | 'duplicate' | 'conflict' | 'full' {
    const { env, payload, digest } = envelope(value);
    if (env.to.node_id !== this.nodeId) throw new TypeError('Inbox target must be the local node');
    try {
      return this.store.transaction<'new' | 'duplicate' | 'conflict'>((db) => {
        const prior = query(db, 'SELECT * FROM node_inbox WHERE sender = ? AND msg_id = ?')
          .get(env.from.node_id, env.msg_id);
        if (prior) {
          this.readInbox(db, prior);
          return prior.digest === digest ? 'duplicate' : 'conflict';
        }
        db.prepare('INSERT INTO node_inbox(sender, msg_id, digest, payload) VALUES (?, ?, ?, ?)')
          .run(env.from.node_id, env.msg_id, digest, payload);
        this.capacity(db);
        return 'new';
      });
    } catch (error) {
      if (error instanceof RuntimeStoreError && error.code === 'FULL') return 'full';
      throw error;
    }
  }

  pending(limit = this.maxEntries): EnvelopeV1[] {
    integer(limit, 'limit');
    return this.store.transaction((db) => {
      const entries: EnvelopeV1[] = [];
      for (const row of query(db, "SELECT * FROM node_inbox WHERE decision = 'pending' ORDER BY rowid LIMIT ?").iterate(limit)) {
        entries.push(this.readInbox(db, row)!);
      }
      return entries;
    });
  }

  state(stateKey: string): RuntimeState | undefined { return this.store.transaction((db) => this.readState(db, stateKey)); }

  /** Detached, validated snapshots in key order. Empty prefix lists all states. */
  states(prefix: string, limit = this.maxEntries): RuntimeState[] {
    if (prefix !== '') key(prefix);
    integer(limit, 'limit');
    return this.store.transaction((db) => {
      const states: RuntimeState[] = [];
      // Byte comparison is literal/case-sensitive, including %, _, quotes and embedded NULs.
      // Empty prefixes skip filtering entirely, so even invalid empty keys reach validation.
      const rows = prefix === '' ? query(db, `${STATE_ROWS} ORDER BY state_key LIMIT ?`).iterate(limit) :
        query(db, `${STATE_ROWS}
          WHERE substr(CAST(state_key AS BLOB), 1, ?) = CAST(? AS BLOB) ORDER BY state_key LIMIT ?`)
          .iterate(Buffer.byteLength(prefix), prefix, limit);
      for (const row of rows) states.push(this.decodeState(row));
      return states;
    });
  }

  private readState(db: DatabaseSync, stateKey: string): RuntimeState | undefined {
    key(stateKey);
    const row = query(db, `${STATE_ROWS} WHERE state_key = ?`).get(stateKey);
    return row ? this.decodeState(row) : undefined;
  }

  /**
   * Local revision CAS with the same data-only, synchronous/no-reentry contract as consume().
   * expectedRevision = 0 requires absent state; stale transforms never run. Returns the next
   * revision only after state, outbox and effects commit, without touching inbox or R1 dedup.
   */
  transition(stateKey: string, expectedRevision: number,
    transform: (state: RuntimeState | undefined) => RuntimeTransition): number {
    key(stateKey);
    integer(expectedRevision, 'expectedRevision');
    if (types.isAsyncFunction(transform)) throw new TypeError('Runtime transform must be synchronous');
    return this.store.transaction((db) => {
      const state = this.readState(db, stateKey);
      const revision = state?.revision ?? 0;
      if (revision !== expectedRevision) throw new RuntimeStoreError('STALE', 'State revision changed');
      const committedRevision = this.applyTransition(db, stateKey, revision, transform(state));
      this.capacity(db);
      return committedRevision;
    });
  }

  private applyTransition(db: DatabaseSync, stateKey: string, revision: number, result: RuntimeTransition): number {
    if (types.isPromise(result)) { void result.catch(() => {}); throw new TypeError('Runtime transform must be synchronous'); }
    // Validate/copy the ENTIRE result, so deferred work and mutable aliases cannot escape.
    const transition = JSON.parse(json(result)) as RuntimeTransition;
    if ((transition.outbox !== undefined && !Array.isArray(transition.outbox)) ||
        (transition.effects !== undefined && !Array.isArray(transition.effects))) {
      throw new TypeError('Runtime outbox and effects must be arrays');
    }
    const value = json(transition.state);
    integer(revision + 1, 'next revision');
    revision += 1;
    db.prepare(`INSERT INTO node_state VALUES (?, ?, ?) ON CONFLICT(state_key)
      DO UPDATE SET revision = excluded.revision, value = excluded.value`).run(stateKey, revision, value);
    for (const outbound of transition.outbox ?? []) this.saveEntry(db, { envelope: outbound, attempts: 0, lastAt: 0 });
    for (const effect of transition.effects ?? []) {
      key(effect.id);
      key(effect.kind);
      db.prepare('INSERT INTO node_effects(effect_id, state_key, revision, kind, payload) VALUES (?, ?, ?, ?, ?)')
        .run(effect.id, stateKey, revision, effect.kind, json(effect.payload));
    }
    return revision;
  }

  /**
   * Atomic inbox + sender-scoped R1 dedup + revision CAS + outbox + effect intents.
   * Dedup is scoped to stateKey; task.progress/lease.renew are exempt. No expiry or attempt/authorization gate.
   * Transform is trusted synchronous DATA-ONLY code: no network/IO, async work, or store re-entry.
   * It receives detached snapshots, NOT a database/session. Do not publish results until return.
   */
  consume(request: ConsumeRequest, transform: RuntimeTransform): ConsumeResult {
    key(request.stateKey);
    integer(request.expectedRevision, 'expectedRevision');
    if (!isUuid(request.fromNode) || !isUuid(request.msgId)) throw new TypeError('Invalid inbound identity');
    if (types.isAsyncFunction(transform)) throw new TypeError('Runtime transform must be synchronous');
    return this.store.transaction<ConsumeResult>((db) => {
      const { fromNode, msgId, stateKey, expectedRevision } = request;
      const row = query(db, 'SELECT * FROM node_inbox WHERE sender = ? AND msg_id = ?').get(fromNode, msgId);
      if (!row) return { status: 'missing' };
      const env = this.readInbox(db, row);
      if (row.decision !== 'pending') {
        if (row.state_key !== stateKey) throw new RuntimeStoreError('CONFLICT', 'Inbox already consumed into another state');
        return { status: row.decision as 'applied' | 'duplicate' | 'conflict', revision: Number(row.revision) };
      }
      const state = this.readState(db, stateKey);
      let revision = state?.revision ?? 0;
      if (revision !== expectedRevision) throw new RuntimeStoreError('STALE', 'State revision changed');
      valid(env);
      let status: 'applied' | 'duplicate' | 'conflict' = 'applied';
      if (usesR1Dedup(env.type)) {
        const dedupKey = jcs([env.task_id, env.attempt, env.type]);
        const digest = sha256Hex(jcs(env.body));
        const prior = query(db, 'SELECT * FROM node_dedup WHERE sender = ? AND state_key = ? AND dedup_key = ?')
          .get(fromNode, stateKey, dedupKey);
        if (prior) {
          this.readDedup(db, prior);
          status = prior.digest === digest ? 'duplicate' : 'conflict';
        } else db.prepare('INSERT INTO node_dedup VALUES (?, ?, ?, ?)').run(fromNode, stateKey, dedupKey, digest);
      }
      if (status === 'applied') {
        revision = this.applyTransition(db, stateKey, revision, transform({ envelope: env, state }));
      }
      db.prepare(`UPDATE node_inbox SET payload = NULL, decision = ?, state_key = ?, revision = ?
        WHERE sender = ? AND msg_id = ?`).run(status, stateKey, revision, fromNode, msgId);
      this.capacity(db);
      return { status, revision };
    });
  }

  /** Older pending revisions are visible only to explicitly fence-aware reconciliation workers. */
  pendingEffects(limit = this.maxEntries, includeSuperseded = false): RuntimeEffect[] {
    integer(limit, 'limit');
    if (typeof includeSuperseded !== 'boolean') throw new TypeError('includeSuperseded must be a boolean');
    return this.store.transaction((db) => {
      const effects: RuntimeEffect[] = [];
      if (limit === 0) return effects;
      // Do not let a current-revision JOIN silently hide orphaned/future-revision effects.
      for (const row of query(db, "SELECT * FROM node_effects WHERE status = 'pending' ORDER BY rowid").iterate()) {
        const { effect, currentRevision } = this.readEffect(db, row);
        if (includeSuperseded || effect.revision === currentRevision) effects.push(effect);
        if (effects.length === limit) break;
      }
      return effects;
    });
  }

  /**
   * Fenced local completion, not exactly-once external IO. Workers must pass id + revision to an
   * idempotent/fence-aware sink; a read of pendingEffects alone is NOT permission for stale IO.
   * allowSuperseded is only for reconciliation that has independently fenced the external work.
   */
  completeEffect(id: string, stateKey: string, revision: number, allowSuperseded = false): boolean {
    key(id);
    key(stateKey);
    integer(revision, 'revision');
    if (typeof allowSuperseded !== 'boolean') throw new TypeError('allowSuperseded must be a boolean');
    return this.store.transaction((db) => {
      const row = query(db, 'SELECT * FROM node_effects WHERE effect_id = ?').get(id);
      if (row) this.readEffect(db, row);
      const result = db.prepare(`UPDATE node_effects SET status = 'done'
        WHERE effect_id = ? AND state_key = ? AND revision = ? AND status = 'pending'
        AND (? = 1 OR EXISTS (SELECT 1 FROM node_state WHERE state_key = ? AND revision = ?))`)
        .run(id, stateKey, revision, allowSuperseded ? 1 : 0, stateKey, revision);
      return result.changes === 1;
    });
  }
}