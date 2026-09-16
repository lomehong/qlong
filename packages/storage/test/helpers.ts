import { afterEach } from 'vitest';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseOwnership, defineMigration, SqliteStore } from '../src/index.js';
import type { SqliteStoreOptions, StorageSchema } from '../src/index.js';

export const schema: StorageSchema = {
  id: 'qlong.storage-test',
  migrations: [defineMigration({ version: 1, name: 'records', sql: `
    CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES records(id)) STRICT;
    CREATE TABLE deferred_children (
      id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES records(id) DEFERRABLE INITIALLY DEFERRED
    ) STRICT;
  ` })],
};

const roots = new Set<string>();
const handles = new Set<{ close(): void }>();
const children = new Map<ChildProcess, Promise<void>>();
const tempBase = realpathSync(tmpdir());

export function fixture(): SqliteStoreOptions {
  const root = mkdtempSync(join(tempBase, 'qlong-storage-'));
  roots.add(root);
  return {
    allowedBase: root, dataDir: join(root, 'data'), mode: 'create', schema,
    localFilesystemConfirmed: true, windowsAclConfirmed: true, busyTimeoutMs: 25,
  };
}

export function open(options: SqliteStoreOptions): SqliteStore {
  const store = SqliteStore.open(options);
  handles.add(store);
  return store;
}

export function own(options: SqliteStoreOptions): DatabaseOwnership {
  const owner = DatabaseOwnership.acquire(options);
  handles.add(owner);
  return owner;
}

export interface ChildMessage { type: 'ready' | 'busy' | 'error'; code?: number }

export async function startChild(dataDir: string, action: string): Promise<{ child: ChildProcess; message: ChildMessage }> {
  const child = fork(fileURLToPath(new URL('./fixtures/sqlite-child.mjs', import.meta.url)), [dataDir, action], {
    execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  children.set(child, new Promise((resolve) => { child.once('close', () => resolve()); }));
  const message = await new Promise<ChildMessage>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('SQLite child readiness timeout')); }, 8_000);
    function cleanup(): void {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
    }
    function onMessage(value: unknown): void { cleanup(); resolve(value as ChildMessage); }
    function onError(error: Error): void { cleanup(); reject(error); }
    function onExit(): void { cleanup(); reject(new Error('SQLite child exited before readiness')); }
    child.once('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
  return { child, message };
}

export async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await children.get(child);
  children.delete(child);
}

afterEach(async () => {
  // Stop our exact child handles, then close DBs BEFORE deleting fixture directories.
  await Promise.all([...children.keys()].map(killChild));
  for (const handle of [...handles].reverse()) handle.close();
  handles.clear();
  for (const root of roots) {
    if (dirname(root) !== tempBase || !basename(root).startsWith('qlong-storage-')) {
      throw new Error('Unsafe test cleanup target');
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  roots.clear();
});