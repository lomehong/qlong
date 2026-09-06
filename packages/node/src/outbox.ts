/** R11 发送侧 outbox:关键消息未获回执前持久保留,重发沿用同一 msg_id */
import type { EnvelopeV1 } from '@qlong/core';

export interface OutboxEntry {
  envelope: EnvelopeV1;
  attempts: number;
  lastAt: number;
}

export interface OutboxStore {
  all(): OutboxEntry[];
  save(entry: OutboxEntry): void;
  remove(msgId: string): void;
}

export class MemoryOutbox implements OutboxStore {
  private map = new Map<string, OutboxEntry>();

  all(): OutboxEntry[] {
    return [...this.map.values()];
  }

  save(entry: OutboxEntry): void {
    const prev = this.map.get(entry.envelope.msg_id);
    this.map.set(entry.envelope.msg_id, {
      ...entry,
      attempts: (prev?.attempts ?? 0) + 1,
    });
  }

  remove(msgId: string): void {
    this.map.delete(msgId);
  }
}