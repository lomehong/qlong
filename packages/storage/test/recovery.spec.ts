import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { backup } from 'node:sqlite';
import { fixture, killChild, open, startChild } from './helpers.js';

describe('process crash/WAL recovery (not a power-loss durability proof)', () => {
  it.each(['before-commit', 'after-commit'])('recovers after hard kill %s without deleting any SQLite file', async (phase) => {
    const options = fixture();
    const first = open(options);
    first.transaction((db) => db.prepare('INSERT INTO records VALUES (?, ?)').run('baseline', 'preserved'));
    first.close();
    const lockPath = join(options.dataDir, 'ownership.sqlite');
    const dbPath = join(options.dataDir, 'state.sqlite');
    const lockInode = statSync(lockPath).ino;
    const dbInode = statSync(dbPath).ino;
    const writer = await startChild(options.dataDir, phase);
    expect(writer.message.type).toBe('ready');
    // Autocheckpoint disabled; pre-COMMIT uses cache spill to put uncommitted pages in WAL too.
    expect(statSync(dbPath + '-wal').size).toBeGreaterThan(32);
    await killChild(writer.child);
    if (phase === 'after-commit') expect(existsSync(dbPath + '-wal')).toBe(true);
    const recovered = open({ ...options, mode: 'open' });
    expect(statSync(lockPath).ino).toBe(lockInode);
    expect(statSync(dbPath).ino).toBe(dbInode);
    expect(recovered.database.prepare('SELECT value FROM records WHERE id = ?').get('baseline')?.value).toBe('preserved');
    const row = recovered.database.prepare('SELECT value FROM records WHERE id = ?').get(phase);
    if (phase === 'after-commit') expect(row?.value).toBe('child-committed-or-pending');
    else expect(row).toBeUndefined();
    expect(recovered.database.prepare('SELECT id FROM records WHERE id = ?').get('uncommitted-spill')).toBeUndefined();
    recovered.transaction((db) => db.prepare('INSERT INTO records VALUES (?, ?)').run('after-recovery', 'works'));
  });

  it('bounded business BUSY rolls back without invoking the callback and can retry after release', async () => {
    const options = fixture();
    const store = open(options);
    // Deliberate non-cooperating writer to test the business SQLite lock, not daemon ownership.
    const writer = await startChild(options.dataDir, 'busy-writer');
    expect(writer.message.type).toBe('ready');
    let invoked = false;
    const started = Date.now();
    expect(() => store.transaction(() => { invoked = true; })).toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(invoked).toBe(false);
    expect(store.state).toBe('open');
    await killChild(writer.child);
    store.transaction((db) => db.prepare('INSERT INTO records VALUES (?, ?)').run('retry', 'committed'));
    expect(store.database.prepare('SELECT id FROM records').all()).toEqual([{ id: 'retry' }]);
  });

  it('real SQLITE_FULL from a bounded page budget faults the store, with no physical disk filling', () => {
    const options = fixture();
    const store = open(options);
    const count = store.database.prepare('PRAGMA page_count').get()?.page_count;
    expect(typeof count).toBe('number');
    store.database.exec(`PRAGMA max_page_count=${Number(count)}`);
    expect(() => store.transaction((db) => {
      db.prepare('INSERT INTO records VALUES (?, ?)').run('too-large', 'x'.repeat(256 * 1024));
    })).toThrow(expect.objectContaining({ errcode: 13 }));
    expect(store.state).toBe('faulted');
    store.close();
    expect(open({ ...options, mode: 'open' }).database.prepare('SELECT * FROM records').all()).toEqual([]);
  });

  it('uses the built-in backup API outside transactions and reopens the consistent copy', async () => {
    const options = fixture();
    const store = open(options);
    store.transaction((db) => db.prepare('INSERT INTO records VALUES (?, ?)').run('backup', 'committed'));
    // Not a main-file copy: SQLite includes committed WAL contents. Ownership remains held.
    const destination = join(options.dataDir, 'backup.sqlite');
    await backup(store.database, destination);
    store.close();
    // Backup inherits SQLite file creation permissions; protect the offline copy on POSIX.
    if (process.platform !== 'win32') chmodSync(destination, 0o600);
    const restored = open({ ...options, mode: 'open', filename: 'backup.sqlite' });
    expect(restored.database.prepare('SELECT * FROM records').all()).toEqual([{ id: 'backup', value: 'committed' }]);
  });
});