import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runStorageOptions, type RunStorageEnvironment } from '../src/run-storage-options.js';

// Pure parser cases: virtual paths only. No fixture, mkdir, store, or process.env mutation.
const virtualBase = join(tmpdir(), 'qlong-run-parser-only');
const home = join(virtualBase, 'home');
const defaultDataDir = join(home, 'data');
const required = ['--storage-mode', 'open', '--confirm-local-filesystem'] as const;

describe('runStorageOptions pure parsing', () => {
  it.each(['create', 'open'] as const)('parses explicit %s flags with both operator confirmations', (mode) => {
    expect(runStorageOptions(
      ['--data-dir', virtualDir(), '--data-base', virtualBase, '--storage-mode', mode,
        '--confirm-local-filesystem', '--confirm-windows-acl'],
      {}, home,
    )).toEqual({
      dataDir: virtualDir(), allowedBase: virtualBase, mode,
      localFilesystemConfirmed: true, windowsAclConfirmed: true,
    });
  });

  it.each(['create', 'open'] as const)('parses explicit %s environment settings', (mode) => {
    const env: RunStorageEnvironment = {
      QLONG_DATA_DIR: virtualDir(), QLONG_DATA_BASE: virtualBase, QLONG_STORAGE_MODE: mode,
      QLONG_LOCAL_FS_CONFIRMED: '1', QLONG_WINDOWS_ACL_CONFIRMED: '1',
    };
    expect(runStorageOptions([], env, home)).toEqual({
      dataDir: virtualDir(), allowedBase: virtualBase, mode,
      localFilesystemConfirmed: true, windowsAclConfirmed: true,
    });
  });

  it('defaults the directory under home, the allowed base to dirname, and never defaults the mode', () => {
    const result = runStorageOptions([...required], {}, home);
    expect(result.dataDir).toBe(defaultDataDir);
    expect(result.allowedBase).toBe(dirname(defaultDataDir));
    expect(result.mode).toBe('open');
    expect(result.windowsAclConfirmed).toBeUndefined();
    expect(() => runStorageOptions(['--data-dir', virtualDir(), '--confirm-local-filesystem'], {}, home))
      .toThrow(/create\|open/);
  });

  it('gives explicit flags precedence over environment and leaves both inputs untouched', () => {
    const env: RunStorageEnvironment = {
      QLONG_DATA_DIR: 'relative-invalid-env', QLONG_DATA_BASE: 'invalid-base', QLONG_STORAGE_MODE: 'invalid',
      QLONG_LOCAL_FS_CONFIRMED: '0', QLONG_WINDOWS_ACL_CONFIRMED: '0',
    };
    const argv = ['--data-dir', virtualDir(), '--data-base', virtualBase, '--storage-mode', 'create',
      '--confirm-local-filesystem', '--confirm-windows-acl'];
    const beforeArgv = [...argv];
    const beforeEnv = { ...env };
    expect(runStorageOptions(argv, env, home)).toEqual({
      dataDir: virtualDir(), allowedBase: virtualBase, mode: 'create',
      localFilesystemConfirmed: true, windowsAclConfirmed: true,
    });
    expect(argv).toEqual(beforeArgv);
    expect(env).toEqual(beforeEnv);
  });

  it.each(['--data-dir', '--data-base', '--storage-mode'].flatMap((flag) => [
    { label: `${flag} at end`, argv: [flag] },
    { label: `${flag} followed by another flag`, argv: [flag, '--confirm-local-filesystem'] },
    { label: `${flag} followed by an empty value`, argv: [flag, ''] },
  ]))('rejects missing values: $label', ({ argv }) => {
    expect(() => runStorageOptions(argv, {
      QLONG_DATA_DIR: virtualDir(), QLONG_DATA_BASE: virtualBase, QLONG_STORAGE_MODE: 'open', QLONG_LOCAL_FS_CONFIRMED: '1',
    }, home)).toThrow(/Missing value/);
  });

  it.each([
    { label: 'mode missing', argv: ['--data-dir', virtualDir()] },
    { label: 'relative directory', argv: ['--data-dir', 'relative-node', '--storage-mode', 'open'] },
    { label: 'unknown mode', argv: ['--data-dir', virtualDir(), '--storage-mode', 'auto'] },
    { label: 'uppercase mode', argv: ['--data-dir', virtualDir(), '--storage-mode', 'OPEN'] },
  ])('rejects unsafe or implicit configuration: $label', ({ argv }) => {
    expect(() => runStorageOptions([...argv, '--confirm-local-filesystem'], {}, home))
      .toThrow(/absolute.*create\|open/);
  });

  it.each([undefined, '', '0', 'true', 'yes'])('requires explicit local filesystem admission (value=%s)', (confirmation) => {
    expect(() => runStorageOptions([...required.slice(0, 2)], { QLONG_LOCAL_FS_CONFIRMED: confirmation }, home))
      .toThrow(/Confirm local/);
  });

  it.each([undefined, '', '0', 'true', 'yes', '1'])('only treats Windows ACL environment value 1 as confirmation (value=%s)', (confirmation) => {
    const result = runStorageOptions([...required], { QLONG_WINDOWS_ACL_CONFIRMED: confirmation }, home);
    expect(result.windowsAclConfirmed).toBe(confirmation === '1' ? true : undefined);
  });
});

function virtualDir(): string {
  return join(virtualBase, 'node');
}
