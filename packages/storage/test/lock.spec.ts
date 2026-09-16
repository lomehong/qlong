import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseOwnership, SqliteStore } from '../src/index.js';
import { fixture, killChild, open, own, startChild } from './helpers.js';

describe('daemon database ownership (independent DELETE/BEGIN EXCLUSIVE)', () => {
  it('retains ownership across business commits and failed same-process acquisitions', async () => {
    const options = fixture();
    const store = open(options);
    for (let index = 0; index < 3; index++) {
      expect(() => DatabaseOwnership.acquire(options)).toThrow(expect.objectContaining({ code: 'OWNERSHIP_BUSY' }));
      store.transaction((db) => db.prepare('INSERT INTO records VALUES (?, ?)').run(String(index), 'committed'));
      const contender = await startChild(options.dataDir, 'lock');
      expect(contender.message.type).toBe('busy');
      await killChild(contender.child);
    }
    expect(store.database.prepare('SELECT count(*) AS count FROM records').get()?.count).toBe(3);
  });

  it('closes the business connection before ownership is reusable, without removing the lock file', async () => {
    const options = fixture();
    const store = open(options);
    const db = store.database;
    const lockPath = join(options.dataDir, 'ownership.sqlite');
    const inode = statSync(lockPath).ino;
    store.close();
    expect(db.isOpen).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(statSync(lockPath).ino).toBe(inode);
    const contender = await startChild(options.dataDir, 'lock');
    expect(contender.message.type).toBe('ready');
    await killChild(contender.child);
    expect(open({ ...options, mode: 'open' }).state).toBe('open');
  });

  it('obtains ownership BEFORE opening or migrating a business DB; takes over after hard kill', async () => {
    const options = fixture();
    mkdirSync(options.dataDir, { mode: 0o700 });
    const holder = await startChild(options.dataDir, 'lock');
    expect(holder.message.type).toBe('ready');
    const lockPath = join(options.dataDir, 'ownership.sqlite');
    const inode = statSync(lockPath).ino;
    expect(() => SqliteStore.open(options)).toThrow(expect.objectContaining({ code: 'OWNERSHIP_BUSY' }));
    expect(existsSync(join(options.dataDir, 'state.sqlite'))).toBe(false);
    await killChild(holder.child);
    expect(open(options).state).toBe('open');
    expect(statSync(lockPath).ino).toBe(inode);
  });

  it('allows only one of two independent cold contenders and reuses their existing lock file', async () => {
    const options = fixture();
    mkdirSync(options.dataDir, { mode: 0o700 });
    const contenders = await Promise.all([startChild(options.dataDir, 'lock'), startChild(options.dataDir, 'lock')]);
    expect(contenders.map((entry) => entry.message.type).sort()).toEqual(['busy', 'ready']);
    const lockPath = join(options.dataDir, 'ownership.sqlite');
    const inode = statSync(lockPath).ino;
    await Promise.all(contenders.map((entry) => killChild(entry.child)));
    const owner = own(options);
    expect(() => owner.assertHeld()).not.toThrow();
    expect(statSync(lockPath).ino).toBe(inode);
    owner.close();
    expect(() => owner.assertHeld()).toThrow(expect.objectContaining({ code: 'OWNERSHIP_LOST' }));
  });

  it.skipIf(process.platform === 'win32')('does not steal ownership from a suspended process', async () => {
    const options = fixture();
    mkdirSync(options.dataDir, { mode: 0o700 });
    const holder = await startChild(options.dataDir, 'lock');
    expect(holder.message.type).toBe('ready');
    holder.child.kill('SIGSTOP');
    expect(() => DatabaseOwnership.acquire(options)).toThrow(expect.objectContaining({ code: 'OWNERSHIP_BUSY' }));
    await killChild(holder.child);
    expect(() => own(options).assertHeld()).not.toThrow();
  });

  it('refuses a corrupt lock database rather than deleting/replacing it', () => {
    const options = fixture();
    mkdirSync(options.dataDir, { mode: 0o700 });
    const path = join(options.dataDir, 'ownership.sqlite');
    writeFileSync(path, Buffer.alloc(512, 0x78), { mode: 0o600 });
    expect(() => SqliteStore.open(options)).toThrow(expect.objectContaining({ code: 'DATABASE_CORRUPT' }));
    expect(statSync(path).size).toBe(512);
    expect(existsSync(join(options.dataDir, 'state.sqlite'))).toBe(false);
  });
});