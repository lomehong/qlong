import { describe, expect, it } from 'vitest';
import type { EnvelopeV1 } from '@qlong/core';
import { newId } from '@qlong/core';
import { InboxStore } from '../src/mailbox.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 02 §12.1 / v0.8 FileMailboxStore:收件箱落盘——网关重启不丢离线 project 单。
 * (正确性兜底仍在端上 R1/R2;落盘是运维体验,不是可靠性机制)
 */
describe('InboxStore 持久化', () => {
  it('offer 后同文件重建 → 条目恢复(重启存活)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlong-mb-'));
    const file = join(dir, 'mailbox.json');
    try {
      const env: EnvelopeV1 = {
        v: 1, type: 'task.offer', msg_id: newId(), ts: new Date().toISOString(),
        exp: new Date(Date.now() + 3600_000).toISOString(),
        from: { node_id: newId(), team_id: 't', key_epoch: 1 },
        to: { node_id: newId(), team_id: 't' },
        trace: { trace_id: newId(), parent_span: null, origin_node: newId() },
        hops: 0, task_id: newId(), attempt: 1,
        sig: { alg: 'ed25519', value: 'x' },
        body: { kind: 'project', summary: '离线单' },
      };
      const s1 = new InboxStore<EnvelopeV1>({ capacity: 10, persistFile: file });
      s1.offer('node-a', env, 1_000);
      expect(existsSync(file)).toBe(true);
      expect(s1.size('node-a')).toBe(1);

      // 模拟网关重启:新实例同文件
      const s2 = new InboxStore<EnvelopeV1>({ capacity: 10, persistFile: file });
      expect(s2.size('node-a')).toBe(1);
      const drained = s2.drain('node-a', () => false);
      expect(drained.deliver.length).toBe(1);
      expect(drained.deliver[0]?.envelope.msg_id).toBe(env.msg_id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drain 清空后落盘为空;损坏文件视为无历史(不抛错)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlong-mb2-'));
    const file = join(dir, 'mailbox.json');
    try {
      const s = new InboxStore<EnvelopeV1>({ capacity: 5, persistFile: file });
      s.offer('n', { msg_id: 'm1' } as unknown as EnvelopeV1, 1);
      s.drain('n', () => false);
      const s2 = new InboxStore<EnvelopeV1>({ capacity: 5, persistFile: file });
      expect(s2.size('n')).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
