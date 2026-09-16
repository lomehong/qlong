import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { request, type Server } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { jcs, sha256Hex } from '@qlong/core';
import { defineMigration, SqliteStore, type SqliteStoreOptions } from '../../storage/src/index.js';
import { AuthService, SESSION_COOKIE } from '../src/auth.js';
import { Registry } from '../src/directory.js';
import { createRegistryServer, type RegistryServerOptions } from '../src/http.js';
import { REGISTRY_SQL } from '../src/state-store.js';
import { TASK_STATUSES } from '../src/task-projection.js';

const schema = {
  id: 'qlong.task-projection-test',
  migrations: [defineMigration({ version: 1, name: 'registry', sql: REGISTRY_SQL })],
};
const tempBase = realpathSync(tmpdir());
const roots = new Set<string>();
const stores = new Set<SqliteStore>();
const servers = new Set<Server>();
const closeServer = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

afterEach(async () => {
  for (const server of servers) await closeServer(server);
  servers.clear();
  for (const storage of [...stores].reverse()) storage.close();
  stores.clear();
  for (const root of roots) {
    if (dirname(root) !== tempBase || !basename(root).startsWith('qlong-task-projection-')) {
      throw new Error('Unsafe task fixture cleanup target');
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  roots.clear();
});

async function fixture(durable: boolean) {
  let now = 1_000_000;
  let options: SqliteStoreOptions | undefined;
  if (durable) {
    const root = mkdtempSync(join(tempBase, 'qlong-task-projection-'));
    roots.add(root);
    options = {
      allowedBase: root, dataDir: join(root, 'data'), mode: 'create', schema,
      localFilesystemConfirmed: true, windowsAclConfirmed: true, busyTimeoutMs: 25,
    };
  }
  function open(mode: 'create' | 'open') {
    if (!options) return undefined;
    const storage = SqliteStore.open({ ...options, mode });
    stores.add(storage);
    return storage;
  }
  let storage = open('create');
  let registry = new Registry({ storage, now: () => now });
  const team = registry.createTeam({ owner_user_id: 'test-owner' }).team_id;
  const other = registry.createTeam({ owner_user_id: 'other-owner' }).team_id;
  const enroll = (teamId: string) => registry.enroll({ token: registry.issueEnrollToken(teamId), pubkey: 'fixture-public-key' });
  const lead = enroll(team);
  const member = enroll(team);
  const outsider = enroll(other);
  const opts: RegistryServerOptions = { registry, ownerAuth: () => true };
  let server: Server;
  let base: string;
  async function listen() {
    server = createRegistryServer(opts);
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  await listen();
  const path = `/v1/teams/${team}/tasks`;
  const body = { task_id: 'task-1', type: 'project', team_id: team, lead: lead.node_id, attempt: 1, status: 'drafting', task_seq: 0 };
  const headers = { Authorization: `Bearer ${lead.node_token}` };
  async function call(method: string, route = path, input?: unknown, credentials: Record<string, string> = headers) {
    const response = await fetch(base + route, {
      method, headers: { 'Content-Type': 'application/json', ...credentials },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  return {
    get registry() { return registry; }, get storage() { return storage; },
    get server() { return server; }, get base() { return base; },
    team, other, lead, member, outsider, opts, path, body, headers, call,
    advance() { now += 1000; },
    async reopen() {
      await closeServer(server);
      servers.delete(server);
      storage?.close();
      storage = open('open');
      registry = new Registry({ storage, now: () => now });
      opts.registry = registry;
      await listen();
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function ownerSession(f: Fixture) {
  const auth = new AuthService();
  const password = randomUUID();
  auth.register('test-owner', password);
  const session = auth.login('test-owner', password);
  f.opts.auth = auth;
  return {
    auth, headers: { Cookie: `${SESSION_COOKIE}=${session.sessionId}`, 'X-CSRF-Token': session.csrf },
    logout() { auth.logout(session.sessionId); },
  };
}

/** Real chunked HTTP: mutate authorization after headers/partial body, before JSON completes. */
async function delayedWrite(f: Fixture, method: string, path: string, body: unknown, change: () => void,
  headers: Record<string, string> = f.headers): Promise<number> {
  const arrived = new Promise<void>((resolve) => {
    f.server.prependOnceListener('request', (req) => req.once('data', () => resolve()));
  });
  let client: ReturnType<typeof request>;
  const response = new Promise<number>((resolve, reject) => {
    client = request(f.base + path, { method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    client.on('error', () => reject(new Error('Fixture HTTP request failed')));
    client.setTimeout(3000, () => client.destroy(new Error('Fixture HTTP timeout')));
  });
  const json = JSON.stringify(body);
  client!.write(json.slice(0, 1));
  await Promise.race([arrived, response.then(() => { throw new Error('Request ended before its body'); })]);
  try { change(); } finally { client!.end(json.slice(1)); }
  return response;
}

describe.each([false, true])('lead task projection HTTP (SQLite=%s)', (durable) => {
  let f: Fixture;
  beforeEach(async () => { f = await fixture(durable); });

  it('creates an unassigned projection, exposes console type/detail, and accepts each actual lead state', async () => {
    const epoch = f.registry.directoryEpoch;
    const created = await f.call('POST', f.path, f.body);
    expect(created.status).toBe(200);
    expect(created.body).toEqual({
      ...f.body, exec: null, content_hash: sha256Hex(jcs({ ...f.body, exec: null })),
      updated_at: new Date(1_000_000).toISOString(),
    });
    expect((await f.call('GET', f.path)).body).toEqual({ tasks: [created.body] });
    expect((await f.call('GET', `${f.path}/task-1`)).body).toEqual(created.body);
    for (const [task_seq, status] of TASK_STATUSES.entries()) {
      expect((await f.call('POST', f.path, { ...f.body, task_id: 'states', task_seq, status })).status).toBe(200);
    }
    expect(f.registry.directoryEpoch).toBe(epoch); // Projection must not mutate directory/scheduling state.
  });

  it('canonical duplicates normalize key order, kind alias and absent/null exec without changing timestamp', async () => {
    const first = await f.call('POST', f.path, f.body);
    expect(first.status).toBe(200);
    f.advance();
    const { type, ...rest } = f.body;
    const reordered = Object.fromEntries(Object.entries({ ...rest, kind: type, exec: null }).reverse());
    const duplicate = await f.call('POST', f.path, reordered);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toEqual(first.body);
    expect(f.registry.listTasks(f.team)).toHaveLength(1);
    expect(f.registry.getNode(f.lead.node_id)?.last_seen).toBe(new Date(1_001_000).toISOString());
    expect((await f.call('POST', f.path, { ...f.body, task_id: 'aid-task', type: 'aid' })).status).toBe(200);
  });

  it('requires monotonic revision and attempt; stale and same-revision conflicts never overwrite', async () => {
    expect((await f.call('POST', f.path, f.body)).status).toBe(200);
    f.advance();
    const latest = { ...f.body, task_seq: 5, attempt: 2, status: 'running', exec: f.member.node_id };
    const accepted = await f.call('POST', f.path, latest);
    expect(accepted.status).toBe(200);
    for (const changed of [
      { task_seq: 4 }, { task_seq: 4, attempt: 3 }, { task_seq: 6, attempt: 1 },
      { status: 'done' }, { attempt: 3 }, { exec: null },
    ]) {
      const rejected = await f.call('POST', f.path, { ...latest, ...changed });
      expect(rejected.status).toBe(409);
      expect((await f.call('GET', `${f.path}/task-1`)).body).toEqual(accepted.body);
    }
    expect((await f.call('POST', f.path, { ...latest, task_seq: 6, status: 'done' })).status).toBe(200);
  });

  it('serializes concurrent duplicates and conflicting reports of a revision', async () => {
    const duplicate = await Promise.all([f.call('POST', f.path, f.body), f.call('POST', f.path, f.body)]);
    expect(duplicate.map((r) => r.status)).toEqual([200, 200]);
    expect(duplicate[0]!.body).toEqual(duplicate[1]!.body);
    const revisions = await Promise.all([
      f.call('POST', f.path, { ...f.body, task_seq: 1, status: 'offered' }),
      f.call('POST', f.path, { ...f.body, task_seq: 1, status: 'failed' }),
    ]);
    expect(revisions.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await f.call('GET', `${f.path}/task-1`)).body).toEqual(revisions.find((r) => r.status === 200)!.body);
  });

  it('rejects missing/invalid bearer, owner-cookie-only writes, and spoofed team or lead', async () => {
    const denied: Array<Record<string, string>> = [{}, { Authorization: 'Bearer fixture-invalid' }];
    for (const headers of denied) {
      expect((await f.call('POST', f.path, f.body, headers)).status).toBe(401);
      expect((await f.call('GET', `${f.path}/task-1`, undefined, headers)).status).toBe(401);
    }
    const owner = ownerSession(f);
    expect((await f.call('POST', f.path, f.body, owner.headers)).status).toBe(401);
    expect((await f.call('POST', f.path, f.body, { ...f.headers, Cookie: owner.headers.Cookie })).status).toBe(403);
    for (const [path, body, headers] of [
      [f.path, { ...f.body, team_id: f.other }, f.headers],
      [`/v1/teams/${f.other}/tasks`, f.body, f.headers],
      [f.path, { ...f.body, lead: f.member.node_id }, f.headers],
      [f.path, f.body, { Authorization: `Bearer ${f.member.node_token}` }],
      [f.path, f.body, { Authorization: `Bearer ${f.outsider.node_token}` }],
    ] as const) expect((await f.call('POST', path, body, headers)).status).toBe(403);
    expect(f.registry.listTasks(f.team)).toHaveLength(0);
  });

  it('keeps task identity immutable across lead, team, and kind changes', async () => {
    const original = await f.call('POST', f.path, f.body);
    expect(original.status).toBe(200);
    expect((await f.call('POST', f.path, { ...f.body, task_seq: 1, type: 'aid' })).status).toBe(409);
    expect((await f.call('POST', f.path, { ...f.body, task_seq: 1, lead: f.member.node_id },
      { Authorization: `Bearer ${f.member.node_token}` })).status).toBe(403);
    expect((await f.call('POST', `/v1/teams/${f.other}/tasks`, {
      ...f.body, team_id: f.other, lead: f.outsider.node_id, task_seq: 1,
    }, { Authorization: `Bearer ${f.outsider.node_token}` })).status).toBe(403);
    f.registry.joinTeam(f.lead.node_token, f.registry.issueEnrollToken(f.other));
    expect((await f.call('POST', f.path, { ...f.body, task_seq: 1 })).status).toBe(403);
    expect((await f.call('POST', `/v1/teams/${f.other}/tasks`, { ...f.body, team_id: f.other, task_seq: 1 })).status).toBe(403);
    expect(f.registry.getTask(f.team, 'task-1')).toEqual(original.body);
  });

  it('authorizes detail like the team list, conceals other-team tasks, and returns 404 only after access checks', async () => {
    expect((await f.call('POST', f.path, f.body)).status).toBe(200);
    const member = { Authorization: `Bearer ${f.member.node_token}` };
    const outsider = { Authorization: `Bearer ${f.outsider.node_token}` };
    expect((await f.call('GET', `${f.path}/task-1`, undefined, member)).status).toBe(200);
    expect((await f.call('GET', `${f.path}/missing`)).status).toBe(404);
    expect((await f.call('GET', `${f.path}/task-1`, undefined, outsider)).status).toBe(403);
    expect((await f.call('GET', `/v1/teams/${f.other}/tasks/task-1`, undefined, outsider)).status).toBe(404);
    const owner = ownerSession(f);
    expect((await f.call('GET', `${f.path}/task-1`, undefined, owner.headers)).status).toBe(200);
    owner.auth.users.get('test-owner')!.role = 'user';
    expect((await f.call('GET', `${f.path}/task-1`, undefined, owner.headers)).status).toBe(200);
    expect((await f.call('GET', `/v1/teams/${f.other}/tasks/task-1`, undefined, owner.headers)).status).toBe(403);
  });

  it.each(['suspend', 'revoke'] as const)('rejects %s bearer for reports, detail and name PATCH', async (action) => {
    expect((await f.call('POST', f.path, f.body)).status).toBe(200);
    f.registry[action](f.lead.node_id);
    for (const [method, path, body] of [
      ['POST', f.path, { ...f.body, task_seq: 1 }], ['GET', `${f.path}/task-1`, undefined],
      ['PATCH', '/v1/nodes/me', { name: 'denied' }],
    ] as const) {
      const response = await f.call(method, path, body);
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ error: { code: action === 'suspend' ? 'node_suspended' : 'node_revoked' } });
    }
    expect(f.registry.getTask(f.team, 'task-1')?.task_seq).toBe(0);
  });

  it('strictly validates required IDs, sequence, attempt, kind/status, exec and unknown fields', async () => {
    const malformed: unknown[] = [null, [], 1];
    for (const field of ['task_id', 'team_id', 'lead', 'type', 'status', 'task_seq', 'attempt']) {
      const missing: Record<string, unknown> = { ...f.body };
      delete missing[field];
      malformed.push(missing);
    }
    for (const task_seq of [-1, 0.5, '0', null, false, Number.MAX_SAFE_INTEGER + 1]) malformed.push({ ...f.body, task_seq });
    for (const attempt of [-1, 0, 1.5, '1', null, false, Number.MAX_SAFE_INTEGER + 1]) malformed.push({ ...f.body, attempt });
    for (const type of ['unknown', 'task', '', null, 1]) malformed.push({ ...f.body, type });
    for (const field of ['task_id', 'team_id', 'lead']) {
      for (const value of ['', ' ', null, 1]) malformed.push({ ...f.body, [field]: value });
    }
    for (const exec of ['', ' ', 1, false, {}, 'missing-node']) malformed.push({ ...f.body, exec });
    malformed.push({ ...f.body, kind: 'aid' }, { ...f.body, kind: 'project' },
      { ...f.body, status: 'queued' }, { ...f.body, extra: true }, { ...f.body, content_hash: 'forged' });
    for (const body of malformed) expect((await f.call('POST', f.path, body)).status).toBe(400);
    expect(f.registry.listTasks(f.team)).toHaveLength(0);
    if (durable) expect(f.registry.getNode(f.lead.node_id)?.last_seen).toBeUndefined();
  });

  it('validates PATCH instead of silently ignoring malformed names or writing detached records', async () => {
    const before = f.registry.getNode(f.lead.node_id)?.name;
    for (const body of [{}, null, [], { name: '' }, { name: ' ' }, { name: 1 }, { name: null }, { name: 'new', status: 'revoked' }]) {
      expect((await f.call('PATCH', '/v1/nodes/me', body)).status).toBe(400);
      expect(f.registry.getNode(f.lead.node_id)?.name).toBe(before);
    }
    expect((await f.call('PATCH', '/v1/nodes/me', { name: 'new' }, {})).status).toBe(401);
    const updated = await f.call('PATCH', '/v1/nodes/me', { name: 'new' });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe('new');
    expect(updated.body).not.toHaveProperty('tokenHash');
    expect(updated.body).not.toHaveProperty('node_token');
    expect(f.registry.getNode(f.lead.node_id)?.name).toBe('new');
  });

  it.each(['suspend', 'revoke', 'join'] as const)('rechecks bearer/team after awaited POST body (%s)', async (action) => {
    const status = await delayedWrite(f, 'POST', f.path, f.body, () => {
      if (action === 'join') f.registry.joinTeam(f.lead.node_token, f.registry.issueEnrollToken(f.other));
      else f.registry[action](f.lead.node_id);
    });
    expect(status).toBe(403);
    expect(f.registry.listTasks(f.team)).toHaveLength(0);
  });

  it.each(['suspend', 'revoke'] as const)('reauthenticates name PATCH after awaited body (%s)', async (action) => {
    const before = f.registry.getNode(f.lead.node_id)?.name;
    expect(await delayedWrite(f, 'PATCH', '/v1/nodes/me', { name: 'denied' }, () => f.registry[action](f.lead.node_id))).toBe(403);
    expect(f.registry.getNode(f.lead.node_id)?.name).toBe(before);
  });

  it.each(['POST', 'PATCH'])('rechecks accompanying Cookie after awaited %s body', async (method) => {
    const owner = ownerSession(f);
    const path = method === 'POST' ? f.path : '/v1/nodes/me';
    const body = method === 'POST' ? f.body : { name: 'denied' };
    const before = f.registry.getNode(f.lead.node_id)?.name;
    expect(await delayedWrite(f, method, path, body, () => owner.logout(), { ...f.headers, ...owner.headers })).toBe(401);
    expect(f.registry.listTasks(f.team)).toHaveLength(0);
    expect(f.registry.getNode(f.lead.node_id)?.name).toBe(before);
  });

  if (durable) {
    it('reopens null and assigned exec, detail/revision/hash, immutable ownership and PATCH name', async () => {
      const draft = await f.call('POST', f.path, f.body);
      const assigned = { ...f.body, task_id: 'assigned', task_seq: 8, attempt: 2, exec: f.member.node_id, status: 'running' };
      expect((await f.call('POST', f.path, assigned)).status).toBe(200);
      expect((await f.call('PATCH', '/v1/nodes/me', { name: 'persisted' })).status).toBe(200);
      await f.reopen();
      expect((await f.call('GET', `${f.path}/task-1`)).body).toEqual(draft.body);
      expect((await f.call('GET', `${f.path}/assigned`)).body).toMatchObject(assigned);
      expect((await f.call('GET', '/v1/nodes/me')).body.name).toBe('persisted');
      f.advance();
      expect((await f.call('POST', f.path, f.body)).body).toEqual(draft.body);
      expect((await f.call('POST', f.path, { ...assigned, task_seq: 7 })).status).toBe(409);
      expect((await f.call('POST', f.path, { ...assigned, status: 'done' })).status).toBe(409);
      expect((await f.call('POST', f.path, { ...assigned, task_seq: 9, lead: f.member.node_id },
        { Authorization: `Bearer ${f.member.node_token}` })).status).toBe(403);
      expect(f.storage!.database.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      expect(f.storage!.database.prepare('SELECT exec FROM registry_tasks WHERE id = ?').get('task-1')?.exec).toBeNull();
    });

    it('commits report auth/touch/write once; duplicates leave the task row untouched; failures roll everything back', async () => {
      f.storage!.transaction((db) => db.exec(`
        CREATE TABLE task_test_counts (commits INTEGER, writes INTEGER) STRICT;
        INSERT INTO task_test_counts VALUES (0, 0);
        CREATE TRIGGER task_test_commit AFTER UPDATE ON registry_meta BEGIN UPDATE task_test_counts SET commits = commits + 1; END;
        CREATE TRIGGER task_test_insert AFTER INSERT ON registry_tasks BEGIN UPDATE task_test_counts SET writes = writes + 1; END;
        CREATE TRIGGER task_test_update AFTER UPDATE ON registry_tasks BEGIN UPDATE task_test_counts SET writes = writes + 1; END;
      `));
      const first = await f.call('POST', f.path, f.body);
      expect(first.status).toBe(200);
      expect(f.storage!.database.prepare('SELECT * FROM task_test_counts').get()).toEqual({ commits: 1, writes: 1 });
      f.advance();
      expect((await f.call('POST', f.path, f.body)).body).toEqual(first.body);
      expect(f.storage!.database.prepare('SELECT * FROM task_test_counts').get()).toEqual({ commits: 2, writes: 1 });
      const beforeSeen = f.registry.getNode(f.lead.node_id)?.last_seen;
      const beforeName = f.registry.getNode(f.lead.node_id)?.name;
      f.advance();
      expect((await f.call('POST', f.path, { ...f.body, status: 'failed' })).status).toBe(409);
      expect(f.registry.getNode(f.lead.node_id)?.last_seen).toBe(beforeSeen);
      f.storage!.transaction((db) => db.exec(`CREATE TRIGGER task_test_reject BEFORE UPDATE ON registry_meta
        BEGIN SELECT RAISE(ABORT, 'injected projection failure'); END`));
      expect((await f.call('POST', f.path, { ...f.body, task_seq: 1, status: 'offered' })).status).toBe(500);
      expect((await f.call('PATCH', '/v1/nodes/me', { name: 'rolled-back' })).status).toBe(500);
      expect(f.registry.getTask(f.team, 'task-1')).toEqual(first.body);
      expect(f.registry.getNode(f.lead.node_id)?.last_seen).toBe(beforeSeen);
      expect(f.registry.getNode(f.lead.node_id)?.name).toBe(beforeName);
      expect(f.storage!.database.prepare('SELECT * FROM task_test_counts').get()).toEqual({ commits: 2, writes: 1 });
      f.storage!.transaction((db) => db.exec('DROP TRIGGER task_test_reject'));
      await f.reopen();
      expect(f.registry.getTask(f.team, 'task-1')).toEqual(first.body);
      expect(f.registry.getNode(f.lead.node_id)?.last_seen).toBe(beforeSeen);
      expect(f.registry.getNode(f.lead.node_id)?.name).toBe(beforeName);
    });

    it('fails closed on deferred COMMIT failure without publishing the task or auth touch', async () => {
      f.storage!.transaction((db) => db.exec(`
        CREATE TABLE task_test_commit_fault (
          parent TEXT REFERENCES registry_nodes(id) DEFERRABLE INITIALLY DEFERRED
        ) STRICT;
        CREATE TRIGGER task_test_commit_fault_trigger AFTER UPDATE ON registry_meta
        BEGIN INSERT INTO task_test_commit_fault VALUES ('missing-node'); END;
      `));
      expect((await f.call('POST', f.path, f.body)).status).toBe(500);
      expect(f.storage!.state).toBe('faulted');
      expect(() => f.registry.getTask(f.team, 'task-1')).toThrow();
      expect((await f.call('GET', `${f.path}/task-1`)).status).toBe(500);
      await f.reopen();
      expect(f.registry.getTask(f.team, 'task-1')).toBeUndefined();
      expect(f.registry.getNode(f.lead.node_id)?.last_seen).toBeUndefined();
    });

    it.each([
      `json_remove(record, '$.task_seq')`, `json_set(record, '$.task_seq', -1)`,
      `json_set(record, '$.task_seq', 0.5)`, `json_set(record, '$.task_seq', 1)`,
      `json_remove(record, '$.content_hash')`, `json_set(record, '$.content_hash', 'bad')`,
      `json_set(record, '$.content_hash', '${'0'.repeat(64)}')`,
      `json_set(record, '$.attempt', 0)`, `json_set(record, '$.type', 'unknown')`,
      `json_set(record, '$.status', 'queued')`, `json_set(record, '$.status', 'done')`,
      `json_set(record, '$.exec', 'missing-node')`,
    ])('fails closed recovering invalid revision/hash/content (%#)', async (expression) => {
      expect((await f.call('POST', f.path, f.body)).status).toBe(200);
      f.storage!.transaction((db) => db.exec(`UPDATE registry_tasks SET record = ${expression}`));
      await expect(f.reopen()).rejects.toThrow(/Invalid registry state/);
    });
  }
});