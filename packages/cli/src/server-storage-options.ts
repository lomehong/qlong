import { dirname, isAbsolute } from 'node:path';
import type { ServerOptions } from './server.js';

export interface StorageEnvironment {
  QLONG_DATA_DIR?: string;
  QLONG_DATA_BASE?: string;
  QLONG_STORAGE_MODE?: string;
  QLONG_LOCAL_FS_CONFIRMED?: string;
  QLONG_WINDOWS_ACL_CONFIRMED?: string;
}

/** Parse only non-secret storage settings. No filesystem writes or implicit bootstrap. */
export function serverStorageOptions(argv: string[], env: StorageEnvironment = {}): Pick<ServerOptions, 'storage' | 'ephemeral'> {
  const value = (name: string, fallback?: string): string | undefined => {
    const index = argv.indexOf(name);
    if (index < 0) return fallback;
    const result = argv[index + 1];
    if (!result || result.startsWith('--')) throw new Error(`Missing value for ${name}`);
    return result;
  };
  const dataDir = value('--data-dir', env.QLONG_DATA_DIR);
  const allowedBase = value('--data-base', env.QLONG_DATA_BASE);
  const mode = value('--storage-mode', env.QLONG_STORAGE_MODE);
  if (argv.includes('--ephemeral')) {
    if (dataDir !== undefined || allowedBase !== undefined || mode !== undefined) {
      throw new Error('Ephemeral mode cannot ignore configured center storage');
    }
    return { ephemeral: true };
  }
  if (!dataDir || !isAbsolute(dataDir) || (mode !== 'create' && mode !== 'open')) {
    throw new Error('Set absolute --data-dir and --storage-mode create|open; --ephemeral is local demo only');
  }
  if (!argv.includes('--confirm-local-filesystem') && env.QLONG_LOCAL_FS_CONFIRMED !== '1') {
    throw new Error('Confirm local, non-shared storage with --confirm-local-filesystem after checking the filesystem');
  }
  return { storage: {
    dataDir, allowedBase: allowedBase ?? dirname(dataDir), mode, localFilesystemConfirmed: true,
    windowsAclConfirmed: argv.includes('--confirm-windows-acl') || env.QLONG_WINDOWS_ACL_CONFIRMED === '1' ? true : undefined,
  } };
}