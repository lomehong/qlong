/**
 * FileOutbox:文件持久化 outbox(R11 完整实现)。
 * 原子写(tmp + rename);进程重启后 load 恢复,重发沿用同一 msg_id。
 * 解决评审 M2-09「MemoryOutbox 非持久」。
 */
import { mkdirSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { OutboxEntry, OutboxStore } from '../outbox.js';
import type { EnvelopeV1 } from '@qlong/core';

export class FileOutbox implements OutboxStore {
  private entries = new Map<string, OutboxEntry>();
  private readonly filePath: string;
  private readonly order: string[] = []; // 保持插入序

  constructor(dir: string, fileName = 'outbox.json') {
    const d = dir;
    mkdirSync(d, { recursive: true });
    this.filePath = join(d, fileName);
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Array<{ id: string; entry: OutboxEntry }>;
      for (const r of raw) {
        this.entries.set(r.id, r.entry);
        this.order.push(r.id);
      }
    } catch { /* 损坏文件当作空处理(实现可覆盖以增加恢复逻辑) */ }
  }

  private persist(): void {
    const data = this.order.map((id) => ({ id, entry: this.entries.get(id)! })).filter((x) => x.entry);
    const tmp = this.filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, this.filePath);
  }

  all(): OutboxEntry[] {
    return this.order.map((id) => this.entries.get(id)!).filter(Boolean);
  }

  save(entry: OutboxEntry): void {
    const id = entry.envelope.msg_id;
    if (!this.entries.has(id)) this.order.push(id);
    this.entries.set(id, entry);
    this.persist();
  }

  remove(msgId: string): void {
    this.entries.delete(msgId);
    const idx = this.order.indexOf(msgId);
    if (idx >= 0) this.order.splice(idx, 1);
    this.persist();
  }

  get size(): number { return this.order.length; }
}
