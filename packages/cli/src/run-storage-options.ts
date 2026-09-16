import { dirname, isAbsolute, join } from 'node:path';

export interface RunStorageEnvironment {
  QLONG_DATA_DIR?: string;
  QLONG_DATA_BASE?: string;
  QLONG_STORAGE_MODE?: string;
  QLONG_LOCAL_FS_CONFIRMED?: string;
  QLONG_WINDOWS_ACL_CONFIRMED?: string;
}

export interface RunStorageOptions {
  dataDir: string;
  allowedBase: string;
  mode: 'create' | 'open';
  localFilesystemConfirmed: true;
  windowsAclConfirmed?: true;
}

/**
 * Parse only non-secret node storage settings. No implicit bootstrap: `qlong run` refuses to start
 * without explicit create/open admission, mirroring the center (`--ephemeral` does not exist here —
 * the legacy in-memory demo remains available only via the old factory API, never via this CLI).
 */
export function runStorageOptions(argv: string[], env: RunStorageEnvironment = {}, home: string): RunStorageOptions {
  const value = (name: string, fallback?: string): string | undefined => {
    const index = argv.indexOf(name);
    if (index < 0) return fallback;
    const result = argv[index + 1];
    if (!result || result.startsWith('--')) throw new Error(`Missing value for ${name}`);
    return result;
  };
  const dataDir = value('--data-dir', env.QLONG_DATA_DIR) ?? join(home, 'data');
  const allowedBase = value('--data-base', env.QLONG_DATA_BASE) ?? dirname(dataDir);
  const mode = value('--storage-mode', env.QLONG_STORAGE_MODE);
  if (!isAbsolute(dataDir) || (mode !== 'create' && mode !== 'open')) {
    throw new Error('Set absolute --data-dir and --storage-mode create|open (first run: create, afterwards: open)');
  }
  if (!argv.includes('--confirm-local-filesystem') && env.QLONG_LOCAL_FS_CONFIRMED !== '1') {
    throw new Error('Confirm local, non-shared storage with --confirm-local-filesystem after checking the filesystem');
  }
  return {
    dataDir, allowedBase, mode, localFilesystemConfirmed: true,
    windowsAclConfirmed: argv.includes('--confirm-windows-acl') || env.QLONG_WINDOWS_ACL_CONFIRMED === '1' ? true : undefined,
  };
}
