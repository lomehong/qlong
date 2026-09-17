/** Transport custody is NOT task acceptance, completion, or lease renewal. */
import type { EnvelopeV1 } from './envelope.js';
import { jcs } from './jcs.js';
import { sha256Hex } from './hash.js';
import { isPlainObject } from './validate-utils.js';

export const TRANSPORT_VERSION = 2;
// lease-renewal(B2):牵头方回发 task.lease.renew 续业务租约的能力位。生产半落地后才宣称,
// 两端引用同一常量、全量协商(hasCustodyFeatures 要求全部);陈旧对端缺此位即 4004,无静默回退。
export const CUSTODY_FEATURES = Object.freeze(['durable-custody', 'receiver-receipt', 'lease-renewal']);
export const MAX_TRANSPORT_BYTES = 256 * 1024;
export const MAX_TRANSPORT_LIFETIME_MS = 24 * 60 * 60 * 1000;

export function hasCustodyFeatures(value: unknown): boolean {
  return Array.isArray(value) && CUSTODY_FEATURES.every((feature) => value.includes(feature));
}

export function envelopeDigest(envelope: EnvelopeV1): string { return sha256Hex(jcs(envelope)); }

export interface DeliveryIdentity {
  from_node: string;
  msg_id: string;
  digest: string;
}
export interface StoredFrame extends DeliveryIdentity {
  frame: 'stored';
}
export interface ReceiptFrame extends DeliveryIdentity {
  frame: 'receipt';
  ticket: string;
}
export interface TransportNack extends DeliveryIdentity {
  frame: 'nack';
  reason: string;
  retry_after_ms: number;
}
export interface DeliveryFrame {
  frame: 'delivery';
  envelope: EnvelopeV1;
  digest: string;
  ticket: string;
}

export function isDeliveryIdentity(value: unknown): value is DeliveryIdentity {
  return isPlainObject(value) && typeof value.from_node === 'string' && value.from_node.length > 0 &&
    typeof value.msg_id === 'string' && value.msg_id.length > 0 &&
    typeof value.digest === 'string' && /^[0-9a-f]{64}$/.test(value.digest);
}
export function isStoredFrame(value: unknown): value is StoredFrame {
  return isDeliveryIdentity(value) && (value as unknown as StoredFrame).frame === 'stored';
}
export function isReceiptFrame(value: unknown): value is ReceiptFrame {
  return isDeliveryIdentity(value) && (value as unknown as ReceiptFrame).frame === 'receipt' &&
    typeof (value as ReceiptFrame).ticket === 'string' && (value as ReceiptFrame).ticket.length <= 128 &&
    (value as ReceiptFrame).ticket.length > 0;
}