/** 网关收件箱(01 §9/02 §8):离线暂存仅 project 类;容量上限,溢出丢最旧 */
export interface InboxEntry<E> {
  msgId: string;
  envelope: E;
  enqueuedAt: number;
}

export class InboxStore<E extends { msg_id: string }> {
  private boxes = new Map<string, InboxEntry<E>[]>();

  constructor(private readonly capacity = 200) {}

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
    return box.length >= this.capacity ? 'stored' : 'stored';
  }

  /** 重连补投:按入队序返回;过期项剔除并由调用方审计(exp_rejected) */
  drain(nodeId: string, isExpired: (e: E) => boolean): { deliver: InboxEntry<E>[]; droppedExpired: InboxEntry<E>[] } {
    const box = this.boxes.get(nodeId) ?? [];
    this.boxes.set(nodeId, []);
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
}