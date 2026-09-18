import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { serverStorageOptions, type StorageEnvironment } from '../src/server-storage-options.js';
import type { ServerOptions } from '../src/server.js';
import {
  cleanupServerFixtures, DurableServerFixture, ownerHeaders, persistedSnapshot,
} from './server-durable-fixtures.js';

afterEach(cleanupServerFixtures);

describe('startQlongServer storage admission', () => {
  it('rejects missing storage rather than implicitly starting an in-memory authority', async () => {
    const f = new DurableServerFixture();
    for (const ephemeral of [undefined, false]) {
      await expect(f.launch({ registryPort: 0, gatewayPath: '/gateway', host: '127.0.0.1', ephemeral }))
        .rejects.toThrow(/storage required/i);
    }
    expect(readdirSync(f.root).length).toBe(0);
  });

  it('allows explicit ephemeral mode only on loopback and never creates a center database', async () => {
    const f = new DurableServerFixture();
    for (const host of ['0.0.0.0', '::', '192.0.2.1', 'localhost']) {
      await expect(f.launch({ ephemeral: true, host, registryPort: 0, gatewayPath: '/gateway' }))
        .rejects.toThrow(/loopback/i);
    }
    // Omitted host must default to loopback, not the durable server wildcard default.
    const handles = await f.launch({ ephemeral: true, registryPort: 0, gatewayPath: '/gateway', seedTeam: false, gcIntervalMs: 0 });
    expect(handles.storageMode).toBe('ephemeral');
    const owner = await f.register();
    expect((await f.call('GET', '/v1/auth/me', undefined, ownerHeaders(owner))).status).toBe(200);
    const node = await f.enroll();
    expect((await f.connect(node.node_token)).authenticated).toBe(true);
    await f.stop();
    expect(readdirSync(f.root).length).toBe(0);
  });

  it('rejects conflicting SQLite and ephemeral options before creating files', async () => {
    const f = new DurableServerFixture();
    await expect(f.start('create', { ephemeral: true })).rejects.toThrow(/not both/i);
    expect(readdirSync(f.root).length).toBe(0);
  });

  it('refuses create on an existing database without changing it or retaining the lock', async () => {
    const f = new DurableServerFixture();
    await f.start();
    const owner = await f.register();
    await f.stop();
    const before = f.offline(persistedSnapshot);
    await expect(f.start('create')).rejects.toMatchObject({ code: 'DATABASE_EXISTS' });
    expect(f.offline(persistedSnapshot) === before).toBe(true);
    await f.start('open');
    expect((await f.call('GET', '/v1/auth/me', undefined, ownerHeaders(owner))).status).toBe(200);
  });

  it('refuses open on a missing database without bootstrap and permits a later explicit create', async () => {
    const f = new DurableServerFixture();
    await expect(f.start('open', { seedTeam: {} })).rejects.toMatchObject({ code: 'DATABASE_MISSING' });
    expect(existsSync(join(f.dataDir, 'center.sqlite'))).toBe(false);
    const handles = await f.start('create');
    expect(handles.auth.needsInit).toBe(true);
    await f.register();
  });

  it('rejects legacy JSON authorities mixed with SQLite before touching either path', async () => {
    const f = new DurableServerFixture();
    const legacy: ServerOptions[] = [
      { authPersistDir: join(f.root, 'legacy-auth') },
      { inboxPersistFile: join(f.root, 'legacy-mailbox.json') },
    ];
    for (const options of legacy) {
      await expect(f.start('create', options)).rejects.toThrow(/mixed storage authorities/i);
      expect(readdirSync(f.root).length).toBe(0);
    }
    await f.start();
    await f.register();
  });

  it('blocks both cluster-secret and peer configurations for a durable authority', async () => {
    const f = new DurableServerFixture();
    const cluster: ServerOptions[] = [
      { clusterSecret: randomUUID() },
      { clusterPeers: ['http://127.0.0.1:1'] },
    ];
    // Loopback peer is never contacted: rejection precedes any store or listener creation.
    for (const options of cluster) {
      await expect(f.start('create', options)).rejects.toThrow(/legacy cluster routing/i);
      expect(readdirSync(f.root).length).toBe(0);
    }
    await f.start();
    await f.register();
  });
});

// Pure parser cases: virtual paths only. No fixture, mkdir, store, listener, or process.env mutation.
const virtualBase = join(tmpdir(), 'qlong-parser-only');
const virtualDir = join(virtualBase, 'center');
const requiredFlags = ['--data-dir', virtualDir, '--storage-mode', 'open'];

describe('serverStorageOptions pure parsing', () => {
  it.each(['create', 'open'] as const)('parses explicit %s flags with both operator confirmations', (mode) => {
    expect(serverStorageOptions([
      '--data-dir', virtualDir, '--data-base', virtualBase, '--storage-mode', mode,
      '--confirm-local-filesystem', '--confirm-windows-acl',
    ])).toEqual({ storage: {
      dataDir: virtualDir, allowedBase: virtualBase, mode,
      localFilesystemConfirmed: true, windowsAclConfirmed: true,
    } });
  });

  it.each(['create', 'open'] as const)('parses explicit %s environment settings', (mode) => {
    const env: StorageEnvironment = {
      QLONG_DATA_DIR: virtualDir, QLONG_DATA_BASE: virtualBase, QLONG_STORAGE_MODE: mode,
      QLONG_LOCAL_FS_CONFIRMED: '1', QLONG_WINDOWS_ACL_CONFIRMED: '1',
    };
    expect(serverStorageOptions([], env)).toEqual({ storage: {
      dataDir: virtualDir, allowedBase: virtualBase, mode,
      localFilesystemConfirmed: true, windowsAclConfirmed: true,
    } });
  });

  it('defaults only the allowed base to dirname and never defaults storage mode', () => {
    const result = serverStorageOptions([...requiredFlags, '--confirm-local-filesystem']);
    expect(result.storage?.allowedBase).toBe(dirname(virtualDir));
    expect(result.storage?.mode).toBe('open');
    expect(result.storage?.windowsAclConfirmed).toBeUndefined();
    expect(() => serverStorageOptions(['--data-dir', virtualDir, '--confirm-local-filesystem'])).toThrow(/create\|open/);
  });

  it('gives explicit flags precedence over environment and leaves both inputs untouched', () => {
    const env: StorageEnvironment = {
      QLONG_DATA_DIR: 'relative-invalid-env', QLONG_DATA_BASE: 'invalid-base', QLONG_STORAGE_MODE: 'invalid',
      QLONG_LOCAL_FS_CONFIRMED: '0', QLONG_WINDOWS_ACL_CONFIRMED: '0',
    };
    const argv = [
      '--data-dir', virtualDir, '--data-base', virtualBase, '--storage-mode', 'create',
      '--confirm-local-filesystem', '--confirm-windows-acl',
    ];
    const beforeArgv = [...argv];
    const beforeEnv = { ...env };
    expect(serverStorageOptions(argv, env)).toEqual({ storage: {
      dataDir: virtualDir, allowedBase: virtualBase, mode: 'create',
      localFilesystemConfirmed: true, windowsAclConfirmed: true,
    } });
    expect(argv).toEqual(beforeArgv);
    expect(env).toEqual(beforeEnv);
  });

  it('combines flag values and environment confirmations without filesystem access', () => {
    const result = serverStorageOptions(['--storage-mode', 'open'], {
      QLONG_DATA_DIR: virtualDir, QLONG_LOCAL_FS_CONFIRMED: '1', QLONG_WINDOWS_ACL_CONFIRMED: '1',
    });
    expect(result.storage).toEqual({
      dataDir: virtualDir, allowedBase: virtualBase, mode: 'open',
      localFilesystemConfirmed: true, windowsAclConfirmed: true,
    });
  });

  it.each(['--data-dir', '--data-base', '--storage-mode'].flatMap((flag) => [
    { label: `${flag} at end`, argv: [flag] },
    { label: `${flag} followed by another flag`, argv: [flag, '--confirm-local-filesystem'] },
    { label: `${flag} followed by an empty value`, argv: [flag, ''] },
  ]))('rejects missing values: $label', ({ argv }) => {
    expect(() => serverStorageOptions(argv, {
      QLONG_DATA_DIR: virtualDir, QLONG_DATA_BASE: virtualBase, QLONG_STORAGE_MODE: 'open', QLONG_LOCAL_FS_CONFIRMED: '1',
    })).toThrow(/Missing value/);
  });

  it.each([
    { label: 'all storage options missing', argv: [] },
    { label: 'directory missing', argv: ['--storage-mode', 'open'] },
    { label: 'mode missing', argv: ['--data-dir', virtualDir] },
    { label: 'relative directory', argv: ['--data-dir', 'relative-center', '--storage-mode', 'open'] },
    { label: 'unknown mode', argv: ['--data-dir', virtualDir, '--storage-mode', 'auto'] },
    { label: 'uppercase mode', argv: ['--data-dir', virtualDir, '--storage-mode', 'OPEN'] },
  ])('rejects unsafe or implicit configuration: $label', ({ argv }) => {
    expect(() => serverStorageOptions([...argv, '--confirm-local-filesystem'])).toThrow(/absolute.*create\|open/);
  });

  it.each([undefined, '', '0', 'true', 'yes'])('requires explicit local filesystem admission (value=%s)', (confirmation) => {
    expect(() => serverStorageOptions(requiredFlags, { QLONG_LOCAL_FS_CONFIRMED: confirmation })).toThrow(/Confirm local/);
  });

  it.each([undefined, '', '0', 'true', 'yes', '1'])('only treats Windows ACL environment value 1 as confirmation (value=%s)', (confirmation) => {
    const result = serverStorageOptions([...requiredFlags, '--confirm-local-filesystem'], { QLONG_WINDOWS_ACL_CONFIRMED: confirmation });
    expect(result.storage?.windowsAclConfirmed).toBe(confirmation === '1' ? true : undefined);
  });

  it('accepts explicit ephemeral alone, without inferring a durable directory or mode', () => {
    expect(serverStorageOptions(['--ephemeral'])).toEqual({ ephemeral: true });
    expect(serverStorageOptions(['--ephemeral', '--confirm-local-filesystem', '--confirm-windows-acl'])).toEqual({ ephemeral: true });
  });

  it.each([
    { label: 'directory flag', argv: ['--data-dir', virtualDir], env: {} },
    { label: 'base flag', argv: ['--data-base', virtualBase], env: {} },
    { label: 'mode flag', argv: ['--storage-mode', 'open'], env: {} },
    { label: 'directory environment', argv: [], env: { QLONG_DATA_DIR: virtualDir } },
    { label: 'base environment', argv: [], env: { QLONG_DATA_BASE: virtualBase } },
    { label: 'mode environment', argv: [], env: { QLONG_STORAGE_MODE: 'create' } },
    { label: 'empty configured directory', argv: [], env: { QLONG_DATA_DIR: '' } },
  ])('does not let ephemeral ignore configured storage: $label', ({ argv, env }) => {
    expect(() => serverStorageOptions(['--ephemeral', ...argv], env)).toThrow(/cannot ignore configured center storage/i);
  });
});