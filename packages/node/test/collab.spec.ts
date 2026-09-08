import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WorkspaceManager } from '../src/collab/workspace.js';
import { LocalPayloadStore } from '../src/collab/payload-store.js';

describe('WorkspaceManager(D33)', () => {
  it('无 workspace → 一次性临时目录', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlong-ws-'));
    const mgr = new WorkspaceManager({ baseDir: dir });
    const handle = mgr.create('t1', {});
    expect(handle.isTempOnly).toBe(true);
    expect(existsSync(handle.rootPath)).toBe(true);
    mgr.destroy('t1');
    expect(existsSync(handle.rootPath)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('路径安全:工作区外路径被拒绝', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlong-ws-'));
    const mgr = new WorkspaceManager({ baseDir: dir });
    const handle = mgr.create('t2', {});
    expect(mgr.isWithinWorkspace(handle, join(handle.rootPath, 'file.txt'))).toBe(true);
    expect(mgr.isWithinWorkspace(handle, '/etc/passwd')).toBe(false);
    mgr.destroy('t2');
    rmSync(dir, { recursive: true });
  });
});

describe('LocalPayloadStore(R10)', () => {
  it('store → read 往返;sha256 校验', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlong-ps-'));
    const store = new LocalPayloadStore({ baseDir: dir });
    const data = Buffer.from('hello payload');
    const ref = store.store(data);
    expect(ref.sha256).toHaveLength(64);
    expect(ref.size).toBe(data.length);
    const read = store.read(ref);
    expect(read.toString()).toBe('hello payload');
    rmSync(dir, { recursive: true });
  });

  it('sha256 不符 → 拒绝', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlong-ps-'));
    const store = new LocalPayloadStore({ baseDir: dir });
    const data = Buffer.from('real');
    const ref = store.store(data);
    const badRef = { ...ref, sha256: 'f'.repeat(64) };
    expect(() => store.read(badRef)).toThrow('sha256');
    rmSync(dir, { recursive: true });
  });
});