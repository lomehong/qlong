import type { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import {
  envelopeDigest, isUuid, jcs, MAX_TRANSPORT_BYTES, MAX_TRANSPORT_LIFETIME_MS, validateEnvelope,
  type DeliveryIdentity, type EnvelopeV1,
} from '@qlong/core';
import { StorageError, type SqliteStore } from '../../storage/src/index.js';

/** Schema fragment only. The center must append a migration before constructing the store. */
export const CUSTODY_SQL = `
CREATE TABLE gateway_custody (
  from_node TEXT NOT NULL CHECK (length(from_node) = 36),
  msg_id TEXT NOT NULL CHECK (length(msg_id) = 36),
  to_node TEXT NOT NULL CHECK (length(to_node) = 36),
  digest TEXT NOT NULL CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'received', 'expired')),
  stored_at INTEGER NOT NULL CHECK (stored_at BETWEEN -8640000000000000 AND 8640000000000000),
  expires_at INTEGER NOT NULL CHECK (expires_at > stored_at AND expires_at - stored_at <= 86400000),
  payload TEXT,
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes BETWEEN 0 AND 262144),
  PRIMARY KEY (from_node, msg_id),
  CHECK ((status = 'pending' AND payload IS NOT NULL AND payload_bytes > 0
    AND payload_bytes = length(CAST(payload AS BLOB)))
    OR (status IN ('received', 'expired') AND payload IS NULL AND payload_bytes = 0))
) STRICT;
CREATE INDEX gateway_custody_pending ON gateway_custody(to_node, status);
CREATE INDEX gateway_custody_expiry ON gateway_custody(expires_at) WHERE status = 'pending';
`;

type OfferResult = 'stored' | 'full' | 'conflict' | 'expired' | 'invalid';
type Status = 'pending' | 'received' | 'expired';
interface CustodyOptions { maxEntries?: number; maxBytes?: number; perNodeEntries?: number }
interface Row extends DeliveryIdentity {
  to_node: string;
  status: Status;
  stored_at: number;
  expires_at: number;
  payload: string | null;
  payload_bytes: number;
}
interface Encoded { envelope: EnvelopeV1; payload: string; bytes: number; digest: string; expires: number }

function requireValid(condition: unknown): asserts condition {
  // Never include payloads or persisted values in recovery errors.
  if (!condition) throw new StorageError('DATABASE_CORRUPT', 'Invalid custody state; explicit recovery required');
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000;
}

/** RFC3339 absolute time, rejecting Date.parse's calendar rollover and local-time guesses. */
function absoluteTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return;
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1]! || Number(hour) > 23 || Number(minute) > 59 ||
      Number(second) > 59 || Number(offsetHour ?? 0) > 23 || Number(offsetMinute ?? 0) > 59) return;
  const time = Date.parse(value);
  return validTime(time) ? time : undefined;
}

/** Detach JSON without invoking getters/toJSON, or silently losing unsupported values. */
function jsonSnapshot(value: unknown, budget: { left: number }, depth = 0): unknown {
  if (--budget.left < 0 || depth > 64) throw new TypeError('Invalid custody JSON');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string') {
    budget.left -= value.length;
    if (budget.left < 0) throw new TypeError('Invalid custody JSON');
    return value;
  }
  if (typeof value !== 'object' || value === null || types.isProxy(value)) throw new TypeError('Invalid custody JSON');
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError('Invalid custody JSON');
  }
  const keys = Reflect.ownKeys(value);
  if (array && (keys.length !== value.length + 1 || value.length > budget.left)) throw new TypeError('Invalid custody JSON');
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const list: unknown[] = [];
  for (const key of keys) {
    if (array && key === 'length') continue;
    if (typeof key !== 'string') throw new TypeError('Invalid custody JSON');
    const field = Object.getOwnPropertyDescriptor(value, key)!;
    if (!field.enumerable || !('value' in field)) throw new TypeError('Invalid custody JSON');
    if (!array) budget.left -= key.length;
    const child = jsonSnapshot(field.value, budget, depth + 1);
    if (array) {
      if (key !== String(list.length)) throw new TypeError('Invalid custody JSON');
      list.push(child);
    } else result[key] = child;
  }
  return array ? list : result;
}

function encode(value: unknown): Encoded | undefined {
  // Only untrusted input conversion is caught. SQL and transaction failures always propagate.
  try {
    const payload = jcs(jsonSnapshot(value, { left: MAX_TRANSPORT_BYTES }));
    const bytes = Buffer.byteLength(payload, 'utf8');
    if (bytes > MAX_TRANSPORT_BYTES) return;
    const raw: unknown = JSON.parse(payload);
    const checked = validateEnvelope(raw);
    if (!checked.ok) return;
    const envelope = checked.value;
    const sig = envelope.sig;
    if (!sig || sig.alg !== 'ed25519' || typeof sig.value !== 'string' ||
        Buffer.from(sig.value, 'base64').length !== 64 || Buffer.from(sig.value, 'base64').toString('base64') !== sig.value) return;
    const expires = absoluteTime(envelope.exp);
    if (expires === undefined || absoluteTime(envelope.ts) === undefined) return;
    return { envelope, payload, bytes, expires, digest: envelopeDigest(envelope) };
  } catch { return; }
}

function load(raw: Record<string, unknown>): { row: Row; envelope?: EnvelopeV1 } {
  requireValid(isUuid(raw.from_node) && isUuid(raw.msg_id) && isUuid(raw.to_node) &&
    typeof raw.digest === 'string' && /^[0-9a-f]{64}$/.test(raw.digest) &&
    (raw.status === 'pending' || raw.status === 'received' || raw.status === 'expired') &&
    validTime(raw.stored_at) && validTime(raw.expires_at) && raw.expires_at > raw.stored_at &&
    raw.expires_at - raw.stored_at <= MAX_TRANSPORT_LIFETIME_MS);
  const row = raw as unknown as Row;
  if (row.status !== 'pending') {
    requireValid(row.payload === null && row.payload_bytes === 0);
    return { row };
  }
  requireValid(typeof row.payload === 'string' && Buffer.byteLength(row.payload, 'utf8') <= MAX_TRANSPORT_BYTES);
  let parsed: unknown;
  try { parsed = JSON.parse(row.payload); } catch { requireValid(false); }
  const encoded = encode(parsed);
  requireValid(encoded && encoded.payload === row.payload && encoded.bytes === row.payload_bytes &&
    encoded.digest === row.digest && encoded.expires === row.expires_at &&
    encoded.envelope.from.node_id === row.from_node && encoded.envelope.to.node_id === row.to_node &&
    encoded.envelope.msg_id === row.msg_id);
  return { row, envelope: encoded.envelope };
}

function find(db: DatabaseSync, fromNode: string, msgId: string): Row | undefined {
  const raw = db.prepare('SELECT * FROM gateway_custody WHERE from_node = ? AND msg_id = ?').get(fromNode, msgId);
  return raw ? load(raw).row : undefined;
}

function finish(db: DatabaseSync, row: Row, status: 'received' | 'expired'): void {
  const result = db.prepare(`UPDATE gateway_custody SET status = ?, payload = NULL, payload_bytes = 0
    WHERE from_node = ? AND msg_id = ? AND status = 'pending'`).run(status, row.from_node, row.msg_id);
  requireValid(result.changes === 1);
}

function expire(db: DatabaseSync, now: number): void {
  // Validate before releasing payloads: expiry must not conceal damaged records.
  const rows = db.prepare("SELECT * FROM gateway_custody WHERE status = 'pending' AND expires_at <= ?").all(now);
  for (const raw of rows) finish(db, load(raw).row, 'expired');
}

function quota(value: number | undefined, fallback: number): number {
  const limit = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('Custody quotas must be positive safe integers');
  return limit;
}

/**
 * Durable custody, not task acceptance. Caller verifies signatures/ACLs and authenticates receipts.
 * No connection-state distinction, cache, eviction or tombstone GC. Does not own/close storage.
 * Defaults: 10,000 total identities, 64 MiB pending payloads, 1,000 pending per recipient.
 */
export class SqliteCustodyStore {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly perNodeEntries: number;

  constructor(private readonly store: SqliteStore, options: CustodyOptions = {}) {
    this.maxEntries = quota(options.maxEntries, 10_000);
    this.maxBytes = quota(options.maxBytes, 64 * 1024 * 1024);
    this.perNodeEntries = quota(options.perNodeEntries, 1_000);
    store.transaction((db) => {
      for (const row of db.prepare('SELECT * FROM gateway_custody').iterate()) load(row);
    });
  }

  offer(env: EnvelopeV1, now: number): OfferResult {
    const encoded = encode(env);
    if (!encoded || !validTime(now)) return 'invalid';
    return this.store.transaction<OfferResult>((db) => {
      const { envelope, digest, expires, payload, bytes } = encoded;
      const existing = find(db, envelope.from.node_id, envelope.msg_id);
      // Stable operation identity wins over time and quotas, even after terminal receipt/expiry.
      if (existing) return existing.digest === digest ? 'stored' : 'conflict';
      if (now >= expires) return 'expired';
      if (expires - now > MAX_TRANSPORT_LIFETIME_MS) return 'invalid';
      expire(db, now);
      const totals = db.prepare('SELECT count(*) AS entries, coalesce(sum(payload_bytes), 0) AS bytes FROM gateway_custody').get()!;
      const recipient = db.prepare("SELECT count(*) AS entries FROM gateway_custody WHERE to_node = ? AND status = 'pending'")
        .get(envelope.to.node_id)!;
      requireValid(Number.isSafeInteger(totals.entries) && Number.isSafeInteger(totals.bytes) && Number.isSafeInteger(recipient.entries));
      if ((totals.entries as number) >= this.maxEntries || bytes > this.maxBytes - (totals.bytes as number) ||
          (recipient.entries as number) >= this.perNodeEntries) return 'full';
      db.prepare(`INSERT INTO gateway_custody
        (from_node, msg_id, to_node, digest, status, stored_at, expires_at, payload, payload_bytes)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
        .run(envelope.from.node_id, envelope.msg_id, envelope.to.node_id, digest, now, expires, payload, bytes);
      return 'stored';
    });
  }

  pending(toNode: string, now: number, limit: number): Array<{ envelope: EnvelopeV1; digest: string }> {
    if (!isUuid(toNode) || !validTime(now) || !Number.isSafeInteger(limit) || limit < 0) return [];
    return this.store.transaction((db) => {
      expire(db, now);
      const rows = db.prepare("SELECT * FROM gateway_custody WHERE to_node = ? AND status = 'pending' ORDER BY rowid LIMIT ?")
        .all(toNode, limit);
      return rows.map((raw) => {
        const { row, envelope } = load(raw);
        requireValid(envelope);
        return { envelope, digest: row.digest };
      });
    });
  }

  acknowledge(toNode: string, fromNode: string, msgId: string, digest: string, now: number): boolean {
    if (!isUuid(toNode) || !isUuid(fromNode) || !isUuid(msgId) || typeof digest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(digest) || !validTime(now)) return false;
    return this.store.transaction((db) => {
      const row = find(db, fromNode, msgId);
      if (!row || row.to_node !== toNode || row.digest !== digest || row.status === 'expired') return false;
      if (row.status === 'received') return true;
      if (now >= row.expires_at) { finish(db, row, 'expired'); return false; }
      finish(db, row, 'received');
      return true;
    });
  }

  /** Last persisted state; expiry is observed by pending(), new offers, or a matching receipt. */
  outcome(fromNode: string, msgId: string): undefined | { status: Status; digest: string; toNode: string } {
    if (!isUuid(fromNode) || !isUuid(msgId)) return;
    return this.store.transaction((db) => {
      const row = find(db, fromNode, msgId);
      return row ? { status: row.status, digest: row.digest, toNode: row.to_node } : undefined;
    });
  }
}