import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newId, type EnvelopeV1 } from '@qlong/core';
import { FileOutbox } from '../src/outbox/file-outbox.js';
import type { OutboxEntry } from '../src/outbox.js';

function mkEntry(msgId?: string): OutboxEntry {
  return {
    envelope: {
      v: 1, type: 'task.offer', msg_id: msgId ?? newId(),
      ts: new Date().toISOString(), exp: new Date(Date.now() + 3_600_000).toISOString(),
      from: { node_id: newId(), team_id: newId(), key_epoch: 1 },
      to: { node_id: newId() },
      trace: { trace_id: newId(), parent_span: null, origin_node: newId() },
      hops: 0, task_id: newId(), attempt: 1,
      sig: { alg: 'ed25519', value: 'x' },
      body: { kind: 'aid', summary: 'test' },
    } as EnvelopeV1,
    attempts: 0, lastAt: 0,
  };
}

describe('FileOutbox', () => {
  it('save/load/remove;文件存在且可 JSON 解析', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlong-ob-'));
    const box = new FileOutbox(dir);
    const e = mkEntry();
    box.save(e);
    expect(box.all()).toHaveLength(1);
    expect(existsSync(join(dir, 'outbox.json'))).toBe(true);
    const raw = JSON.parse(readFileSync(join(dir, 'outbox.json'), 'utf8'));
    expect(Array.isArray(raw)).toBe(true);
    box.remove(e.envelope.msg_id);
    expect(box.all()).toHaveLength(0);
    rmSync(dir, { recursive: true });
  });

  it('崩溃恢复:新实例从同一目录恢复全部条目', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlong-ob-'));
    const box1 = new FileOutbox(dir);
    box1.save(mkEntry());
    box1.save(mkEntry());
    expect(box1.all()).toHaveLength(2);
    const box2 = new FileOutbox(dir);
    expect(box2.all()).toHaveLength(2);
    rmSync(dir, { recursive: true });
  });

  it('remove 后重启不复活', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlong-ob-'));
    const box1 = new FileOutbox(dir);
    const e = mkEntry();
    box1.save(e);
    box1.remove(e.envelope.msg_id);
    const box2 = new FileOutbox(dir);
    expect(box2.all()).toHaveLength(0);
    rmSync(dir, { recursive: true });
  });
});
