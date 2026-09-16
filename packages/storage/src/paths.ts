import { chmodSync, lstatSync, mkdirSync, realpathSync, statfsSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { StorageError } from './errors.js';

export interface DataDirectoryOptions {
  /** Absolute, dedicated leaf directory, strictly inside allowedBase. Parent must exist. */
  dataDir: string;
  allowedBase: string;
  /** Operator admission: local disk, not NFS/SMB/cloud sync/OS or VM shared storage. */
  localFilesystemConfirmed: true;
  /** Node cannot inspect Windows ACLs. Operator must restrict this directory AND its parent. */
  windowsAclConfirmed?: true;
}

function unsafe(message: string): never {
  throw new StorageError('UNSAFE_PATH', message);
}

export function fileInfo(path: string): Stats | undefined {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function privateOwner(info: Stats): void {
  if (process.platform !== 'win32' &&
      (info.uid !== process.getuid!() || (info.mode & 0o077) !== 0)) {
    unsafe('Data directory and database files must be owned by this user and owner-only');
  }
}

function checkAncestors(path: string): void {
  for (let part = path; ; part = dirname(part)) {
    const info = fileInfo(part);
    if (info && (!info.isDirectory() || info.isSymbolicLink())) unsafe('Symlink/non-directory ancestor');
    // A writable ancestor could rename the protected directory. Sticky temp roots are allowed.
    if (info && process.platform !== 'win32' && (info.mode & 0o022) !== 0 &&
        (info.mode & 0o1000) === 0) unsafe('Unprotected writable ancestor');
    if (part === dirname(part)) break;
  }
}

/** Best-effort checks, NOT a proof of mount type, ACLs, storage hardware or fsync semantics. */
export function prepareDataDirectory(options: DataDirectoryOptions): string {
  if (options.localFilesystemConfirmed !== true) unsafe('Local-filesystem admission is required');
  if (process.platform === 'win32' && options.windowsAclConfirmed !== true) {
    unsafe('Windows ACL admission is required; POSIX mode bits do not verify Windows ACLs');
  }
  for (const path of [options.dataDir, options.allowedBase]) {
    if (!isAbsolute(path) || /^[\\/]{2}/.test(path) || path.includes('\0')) unsafe('Absolute local paths required');
    if (process.platform === 'win32' &&
        (!/^[a-z]:[\\/]/i.test(path) || path.slice(2).includes(':'))) {
      unsafe('Drive-qualified local paths required; alternate data streams are forbidden');
    }
    if (path.split(/[\\/]/).includes('..')) unsafe('Parent traversal is forbidden');
    checkAncestors(resolve(path));
  }
  const base = realpathSync(options.allowedBase);
  const target = resolve(options.dataDir);
  const rel = relative(base, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || target === parse(target).root) {
    unsafe('dataDir must be a strict descendant of allowedBase');
  }
  if (!fileInfo(target)) {
    try { mkdirSync(target, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const info = lstatSync(target);
  if (!info.isDirectory() || info.isSymbolicLink()) unsafe('dataDir must be a real directory');
  privateOwner(info);
  const canonical = realpathSync(target);
  // Known Linux remote filesystem magic values. Other mounts require operator admission.
  const type = Number(statfsSync(canonical).type) >>> 0;
  if ([0x6969, 0xff534d42, 0xfe534d42, 0x517b].includes(type)) unsafe('Remote filesystem is unsupported');
  return canonical;
}

/** Metadata-only inspection: never fs.open/read/close an active ownership.sqlite. */
export function checkDatabaseFiles(path: string): boolean {
  const main = fileInfo(path);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const info = suffix ? fileInfo(path + suffix) : main;
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) unsafe('Database files must be regular files without hard links');
    privateOwner(info);
    if (!main && suffix) unsafe('Orphan SQLite sidecar requires explicit recovery');
  }
  return main !== undefined;
}

export function protectNewDatabase(path: string): void {
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

export function databasePath(dataDir: string, name: string): string {
  if (!/^[a-z][a-z0-9_-]*\.sqlite$/.test(name) || name === 'ownership.sqlite') {
    throw new StorageError('INVALID_OPTIONS', 'Database name must be a simple .sqlite filename, not ownership.sqlite');
  }
  return join(dataDir, name);
}