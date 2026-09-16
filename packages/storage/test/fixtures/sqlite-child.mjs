// Built-in SQLite only: fault injection must not depend on a TypeScript loader.
import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';

const [dataDir, action] = process.argv.slice(2);
let owner;
let db;
try {
  if (action !== 'busy-writer') {
    const path = join(dataDir, 'ownership.sqlite');
    owner = new DatabaseSync(path, { timeout: 50, allowExtension: false });
    if (process.platform !== 'win32') chmodSync(path, 0o600);
    owner.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE');
  }
  if (action !== 'lock') {
    db = new DatabaseSync(join(dataDir, 'state.sqlite'), { timeout: 50, allowExtension: false });
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA wal_autocheckpoint=0');
    db.exec('PRAGMA cache_size=5; PRAGMA cache_spill=ON');
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO records(id, value) VALUES (?, ?)').run(action, 'child-committed-or-pending');
    if (action === 'before-commit') {
      // Force uncommitted pages into WAL rather than merely killing an in-memory dirty cache.
      db.prepare('INSERT INTO records(id, value) VALUES (?, ?)').run('uncommitted-spill', 'x'.repeat(256 * 1024));
    }
    if (action === 'after-commit') db.exec('COMMIT');
  }
  process.send({ type: 'ready' });
  setInterval(() => {}, 1_000);
} catch (error) {
  if (db?.isOpen) db.close();
  if (owner?.isOpen) owner.close();
  const code = typeof error.errcode === 'number' ? error.errcode & 0xff : undefined;
  process.send({ type: code === 5 || code === 6 ? 'busy' : 'error', code }, () => process.exit(0));
}