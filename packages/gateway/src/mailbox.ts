/** 网关收件箱(01 §9/02 §8):离线暂存仅 project 类;容量上限,溢出丢最旧。
 *  v0.8(FileMailboxStore 语义,02 §12.1 收件箱落盘):可选 persistFile ——
 *  每次变更后原子写(tmp+rename),构造时自动恢复;网关重启收件箱不丢。 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface InboxEntry<E> {
  msgId: string;
  envelope: E;
  enqueuedAt: number;
}

export interface InboxStoreOptions {
  /** 单节点收件箱容量(默认 200;容量上限是存储保护,不是可靠性机制——可靠性在端上 R11) */
  capacity?: number;
  /** 落盘文件(存在则启动时恢复);缺省纯内存 */
  persistFile?: string;
  /** 时钟注入(测试);默认 Date.now */
  now?: () => number;
}

interface SerializedBox {
  nodeId: string;
  entries: Array<{ msgId: string; envelope: unknown; enqueuedAt: number }>;
}

export class InboxStore<E extends { msg_id: string }> {
  private boxes = new Map<string, InboxEntry<E>[]>();
  private readonly capacity: number;
  private readonly persistFile?: string;
  private readonly clock: () => number = () => Date.now();

  constructor(opts: number | InboxStoreOptions = 200) {
    if (typeof opts === 'number') {
      this.capacity = Math.max(1, opts);
    } else {
      this.capacity = Math.max(1, opts.capacity ?? 200);
      this.persistFile = opts.persistFile;
      this.clock = opts.now ?? (() => Date.now());
      this.load();
    }
  }

  offer(nodeId: string, envelope: E, now: number): 'stored' | 'full' {
    let box = this.boxes.get(nodeId);
    if (!box) {
      box = [];
      this.boxes.set(nodeId, box);
    }
    if (box.length >= this.capacity) {
      box.shift(); // 丢最旧(容量上限是存储保护,不是可靠性机制;可靠性在端上 R11)
    }
    box.push({ msgId: envelope.msg_id, envelope, enqueuedAt: now });
    this.persist();
    return 'stored';
  }

  /** 重连补投:按入队序返回;过期项剔除并由调用方审计(exp_rejected) */
  drain(nodeId: string, isExpired: (e: E) => boolean): { deliver: InboxEntry<E>[]; droppedExpired: InboxEntry<E>[] } {
    const box = this.boxes.get(nodeId) ?? [];
    this.boxes.set(nodeId, []);
    this.persist();
    const deliver: InboxEntry<E>[] = [];
    const droppedExpired: InboxEntry<E>[] = [];
    for (const e of box) {
      if (isExpired(e.envelope)) droppedExpired.push(e);
      else deliver.push(e);
    }
    return { deliver, droppedExpired };
  }

  size(nodeId: string): number {
    return this.boxes.get(nodeId)?.length ?? 0;
  }

  /** 全量落盘(原子写:tmp + rename);仅非空节点入档 */
  private persist(): void {
    if (!this.persistFile) return;
    const boxes: SerializedBox[] = [];
    for (const [nodeId, entries] of this.boxes) {
      if (entries.length > 0) boxes.push({ nodeId, entries: entries.map((e) => ({ ...e })) });
    }
    const tmp = this.persistFile + '.tmp';
    try {
      writeFileSync(tmp, JSON.stringify({ v: 1, savedAt: this.clock(), boxes }), 'utf8');
      renameSync(tmp, this.persistFile);
    } catch {
      /* 落盘失败不阻断投递(正确性由端上 R1/R2 兜底);下次变更重试 */
    }
  }

  private load(): void {
    if (!this.persistFile || !existsSync(this.persistFile)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.persistFile, 'utf8')) as { boxes?: SerializedBox[] };
      for (const b of parsed.boxes ?? []) {
        if (Array.isArray(b.entries) && b.entries.length > 0) {
          this.boxes.set(b.nodeId, b.entries as InboxEntry<E>[]);
        }
      }
    } catch {
      /* 损坏文件视为无历史(端上 R1/R2 兜底正确性) */
    }
  }
}

