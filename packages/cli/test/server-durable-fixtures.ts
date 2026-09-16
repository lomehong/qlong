import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { WebSocket } from 'ws';
import { expect } from 'vitest';
import { CUSTODY_FEATURES, TRANSPORT_VERSION } from '@qlong/core';
import { CENTER_SCHEMA, type CenterStorageOptions, type EnrollResult } from '../../registry/src/index.js';
import { SESSION_COOKIE } from '../../registry/src/auth.js';
import { SqliteStore } from '../../storage/src/index.js';
import { AUTH_KEY } from '../../gateway/src/ws.js';
import { startQlongServer, type ServerHandles, type ServerOptions } from '../src/server.js';

export interface Owner {
  username: string;
  password: string;
  cookie: string;
  csrf: string;
}

export interface TeamView { team_id: string; name: string; online: number }
export interface NodeView {
  node_id: string;
  team_id: string;
  name: string;
  status: string;
  online: boolean;
  key_epoch: number;
  caps: string[];
  caps_rev: number;
  load: Record<string, unknown> | null;
  platform: string;
  qlong_version: string;
}

export const ownerHeaders = (owner: Owner): Record<string, string> => ({
  Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf,
});
export const nodeHeaders = (node: EnrollResult): Record<string, string> => ({
  Authorization: `Bearer ${node.node_token}`,
});

const tempBase = realpathSync(tmpdir());
const fixtures = new Set<DurableServerFixture>();

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Fixture WebSocket timed out')), 3_000);
    })]);
  } finally { clearTimeout(timer); }
}

export class DurableServerFixture {
  readonly root = mkdtempSync(join(tempBase, 'qlong-server-durable-'));
  readonly dataDir = join(this.root, 'center');
  private readonly servers = new Set<ServerHandles>();
  private readonly sockets = new Set<WebSocket>();
  private current?: ServerHandles;

  constructor() { fixtures.add(this); }

  options(mode: 'create' | 'open' = 'create'): CenterStorageOptions {
    return {
      allowedBase: this.root, dataDir: this.dataDir, mode,
      localFilesystemConfirmed: true, windowsAclConfirmed: true, busyTimeoutMs: 25,
    };
  }

  async launch(options: ServerOptions): Promise<ServerHandles> {
    const handles = await startQlongServer(options);
    this.servers.add(handles);
    this.current = handles;
    return handles;
  }

  start(mode: 'create' | 'open' = 'create', overrides: ServerOptions = {}): Promise<ServerHandles> {
    return this.launch({
      storage: this.options(mode), host: '127.0.0.1', registryPort: 0,
      gatewayPath: '/gateway', seedTeam: false, gcIntervalMs: 0, ...overrides,
    });
  }

  async stop(): Promise<void> {
    for (const server of [...this.servers].reverse()) await server.close();
    this.servers.clear();
    this.current = undefined;
  }

  async reopen(overrides: ServerOptions = {}): Promise<ServerHandles> {
    await this.stop();
    return this.start('open', overrides);
  }

  offline<T>(operation: (storage: SqliteStore) => T, mode: 'create' | 'open' = 'open'): T {
    if (this.servers.size !== 0) throw new Error('Stop the fixture server before offline DB access');
    const storage = SqliteStore.open({ ...this.options(mode), schema: CENTER_SCHEMA, filename: 'center.sqlite' });
    try { return operation(storage); } finally { storage.close(); }
  }

  async call<T = Record<string, unknown>>(method: string, path: string, body?: unknown,
    credentials: Record<string, string> = {}) {
    if (!this.current) throw new Error('Fixture server is not running');
    const response = await fetch(`http://127.0.0.1:${this.current.registryPort}${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...credentials },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3_000),
    });
    const text = await response.text();
    let parsed: T;
    try { parsed = (text ? JSON.parse(text) : null) as T; }
    catch { throw new Error('Fixture HTTP response is not JSON'); }
    return { status: response.status, ok: response.ok, body: parsed, setCookie: response.headers.get('set-cookie') };
  }

  async register(): Promise<Owner> {
    const username = 'fixture-owner';
    const password = randomUUID();
    const response = await this.call<{ csrf: string }>('POST', '/v1/auth/register', { username, password });
    expect(response.status).toBe(200);
    // Never assert raw cookies, CSRF, passwords, or entire credential-bearing responses.
    const setCookie = response.setCookie ?? '';
    expect(setCookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(/; HttpOnly(?:;|$)/i.test(setCookie)).toBe(true);
    expect(/; SameSite=Lax(?:;|$)/i.test(setCookie)).toBe(true);
    expect(typeof response.body.csrf === 'string' && response.body.csrf.length > 0).toBe(true);
    return { username, password, cookie: setCookie.split(';')[0]!, csrf: response.body.csrf };
  }

  async teams(owner: Owner): Promise<TeamView[]> {
    const response = await this.call<{ teams: TeamView[] }>('GET', '/v1/teams', undefined, ownerHeaders(owner));
    expect(response.status).toBe(200);
    return response.body.teams;
  }

  async invite(owner: Owner, teamId: string): Promise<string> {
    const response = await this.call<{ token: string }>('POST', `/v1/teams/${teamId}/enroll-tokens`, {}, ownerHeaders(owner));
    expect(response.status).toBe(200);
    expect(typeof response.body.token === 'string' && response.body.token.length > 0).toBe(true);
    return response.body.token;
  }

  async enroll(token?: string): Promise<EnrollResult> {
    const response = await this.call<EnrollResult>('POST', '/v1/enroll', {
      ...(token ? { token } : {}), pubkey: `fixture-public-key-${randomUUID()}`,
      platform: 'fixture/local', qlong_version: 'test',
    });
    expect(response.status).toBe(200);
    expect(typeof response.body.node_token === 'string' && response.body.node_token.length > 0).toBe(true);
    return response.body;
  }

  async nodes(owner: Owner, teamId: string): Promise<NodeView[]> {
    const response = await this.call<{ nodes: NodeView[] }>('GET', `/v1/teams/${teamId}/nodes`, undefined, ownerHeaders(owner));
    expect(response.status).toBe(200);
    return response.body.nodes;
  }

  async connect(token: string, url?: string) {
    if (!url) {
      if (!this.current) throw new Error('Fixture server is not running');
      const h = this.current;
      url = h.gatewayPath ? `ws://127.0.0.1:${h.registryPort}${h.gatewayPath}` : `ws://127.0.0.1:${h.gatewayPort}`;
    }
    // Credentials travel only in the auth frame, never the URL or a diagnostic.
    const socket = new WebSocket(url);
    this.sockets.add(socket);
    const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
    const authenticated = await bounded(new Promise<boolean>((resolve) => {
      socket.once('open', () => socket.send(JSON.stringify({ frame: 'auth', [AUTH_KEY]: token,
        ...(this.current?.storageMode !== 'ephemeral'
          ? { transport_version: TRANSPORT_VERSION, features: CUSTODY_FEATURES } : {}) })));
      socket.on('message', (data) => {
        try {
          if ((JSON.parse(data.toString()) as { frame?: string }).frame === 'auth_ok') resolve(true);
        } catch { /* Frames are never included in errors. */ }
      });
      socket.on('error', () => resolve(false));
      socket.once('close', () => resolve(false));
    }));
    return { authenticated, close: () => socket.close(), waitClosed: () => bounded(closed),
      send: (frame: unknown) => socket.send(JSON.stringify(frame)),
      observe: (onFrame: () => void) => socket.on('message', onFrame),
    };
  }

  async dispose(): Promise<void> {
    for (const socket of this.sockets) if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    await this.stop();
    if (dirname(this.root) !== tempBase || !basename(this.root).startsWith('qlong-server-durable-')) {
      throw new Error('Unsafe server fixture cleanup target');
    }
    // Only this exact, generated fixture root is ever removed, after all handles close.
    rmSync(this.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

export async function cleanupServerFixtures(): Promise<void> {
  for (const fixture of [...fixtures].reverse()) {
    await fixture.dispose();
    fixtures.delete(fixture);
  }
}

/** Compare this only as a boolean; auth rows contain hashes and CSRF metadata. */
export function persistedSnapshot(storage: SqliteStore): string {
  const tables = [
    'registry_meta', 'registry_teams', 'registry_nodes', 'registry_enroll_tokens',
    'registry_grants', 'registry_tasks', 'registry_audit', 'auth_meta', 'auth_users', 'auth_sessions',
  ];
  return JSON.stringify(tables.map((table) => storage.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
}