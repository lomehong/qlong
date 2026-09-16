import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WsGateway } from '../../gateway/src/ws.js';
import { AuthError, AuthService } from '../../registry/src/auth.js';
import type { GrantRecord } from '../../registry/src/directory.js';
import type { TaskRecord } from '../../registry/src/state-store.js';
import { taskProjectionHash, type TaskProjection } from '../../registry/src/task-projection.js';
import {
  cleanupServerFixtures, DurableServerFixture, nodeHeaders, ownerHeaders, persistedSnapshot,
  type NodeView,
} from './server-durable-fixtures.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupServerFixtures();
});

async function ownedFixture() {
  const f = new DurableServerFixture();
  await f.start('create', { seedTeam: { name: 'fixture-team' } });
  const owner = await f.register();
  const teamId = (await f.teams(owner))[0]!.team_id;
  const node = await f.enroll(await f.invite(owner, teamId));
  return { f, owner, teamId, node };
}

function projection(teamId: string, lead: string): TaskProjection {
  return {
    task_id: randomUUID(), type: 'project', team_id: teamId, lead, exec: null,
    attempt: 1, status: 'offered', task_seq: 0,
  };
}

describe('startQlongServer durable authority', () => {
  it('stops cached WS admission after a COMMIT failure and recovers without publishing the failed write', async () => {
    const { f, owner, teamId, node } = await ownedFixture();
    const beforeNode = (await f.nodes(owner, teamId))[0]!;
    await f.stop();
    f.offline((store) => store.transaction((db) => db.exec(`
      CREATE TABLE fixture_deferred_failure (node TEXT REFERENCES registry_nodes(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fixture_commit_failure AFTER UPDATE ON registry_nodes
      WHEN json_extract(NEW.record, '$.name') <> json_extract(OLD.record, '$.name')
      BEGIN INSERT INTO fixture_deferred_failure VALUES ('missing'); END;
    `)));
    await f.start('open');
    const peer = await f.connect(node.node_token);
    expect(peer.authenticated).toBe(true);
    expect((await f.call('PATCH', '/v1/nodes/me', { name: 'must-not-commit' }, nodeHeaders(node))).status).toBe(500);
    let frames = 0;
    peer.observe(() => { frames += 1; });
    peer.send({ frame: 'probe' });
    expect(await peer.waitClosed()).toBe(1011);
    expect(frames).toBe(0);
    expect((await f.call('GET', '/v1/nodes/me', undefined, nodeHeaders(node))).ok).toBe(false);
    await f.reopen();
    expect((await f.nodes(owner, teamId))[0]?.name === beforeNode.name).toBe(true);
  });

  it('registers the owner over HTTP and enforces Cookie/CSRF for owner writes', async () => {
    const f = new DurableServerFixture();
    const handles = await f.start('create', { seedTeam: { name: 'fixture-team' } });
    expect(handles.storageMode).toBe('sqlite');
    expect(handles.auth.needsInit).toBe(true);
    expect((await f.call('GET', '/v1/teams')).status).toBe(401);
    const owner = await f.register();
    expect(handles.auth.needsInit).toBe(false);
    const me = await f.call<{ username: string; csrf: string }>('GET', '/v1/auth/me', undefined, ownerHeaders(owner));
    expect(me.status).toBe(200);
    expect(me.body.username === owner.username && me.body.csrf === owner.csrf).toBe(true);
    const teamId = (await f.teams(owner))[0]!.team_id;
    const path = `/v1/teams/${teamId}/enroll-tokens`;
    expect((await f.call('POST', path, {}, { Cookie: owner.cookie })).status).toBe(403);
    expect((await f.call('POST', path, {}, { Cookie: owner.cookie, 'X-CSRF-Token': randomUUID() })).status).toBe(403);
    await f.invite(owner, teamId);
  });

  it('creates the seed exactly once and reopens the same center.sqlite with the shared schema', async () => {
    const f = new DurableServerFixture();
    await f.start('create', { seedTeam: { name: 'original-seed' } });
    const owner = await f.register();
    const before = await f.teams(owner);
    expect(before.length).toBe(1);
    await f.reopen({ seedTeam: { name: 'must-not-be-created' } });
    expect(JSON.stringify(await f.teams(owner)) === JSON.stringify(before)).toBe(true);
    await f.reopen({ seedTeam: {} });
    expect((await f.teams(owner)).map((team) => team.name)).toEqual(['original-seed']);
    await f.stop();
    expect(existsSync(join(f.dataDir, 'center.sqlite'))).toBe(true);
    expect(existsSync(join(f.dataDir, 'state.sqlite'))).toBe(false);
    f.offline((storage) => {
      expect(storage.path === join(f.dataDir, 'center.sqlite')).toBe(true);
      expect(storage.database.prepare('SELECT count(*) AS count FROM registry_teams').get()?.count).toBe(1);
      expect(storage.database.prepare('SELECT count(*) AS count FROM auth_users').get()?.count).toBe(1);
    });
  });

  it('persists enrolled identity, capabilities/revision, name and load across reopen', async () => {
    const { f, owner, teamId, node } = await ownedFixture();
    expect((await f.call('PUT', '/v1/nodes/me/caps', { caps: ['tool:z', 'tool:a'] }, nodeHeaders(node))).status).toBe(200);
    expect((await f.call('PATCH', '/v1/nodes/me', { name: 'durable-node' }, nodeHeaders(node))).status).toBe(200);
    expect((await f.call('PUT', '/v1/nodes/me/load', { active: 2 }, nodeHeaders(node))).status).toBe(204);
    const before = (await f.nodes(owner, teamId))[0]!;
    await f.reopen();
    expect(JSON.stringify((await f.nodes(owner, teamId))[0]) === JSON.stringify(before)).toBe(true);
    const me = await f.call<NodeView>('GET', '/v1/nodes/me', undefined, nodeHeaders(node));
    expect(me.status).toBe(200);
    expect(me.body.node_id === node.node_id && me.body.team_id === teamId).toBe(true);
    expect(me.body.key_epoch).toBe(node.key_epoch);
    expect(me.body.name).toBe('durable-node');
    expect(me.body.caps).toEqual(['tool:a', 'tool:z']);
    expect(me.body.caps_rev).toBe(2);
    expect(me.body.load).toEqual({ active: 2 });
    expect(me.body.platform).toBe('fixture/local');
    expect(me.body.qlong_version).toBe('test');
    const peer = await f.connect(node.node_token);
    expect(peer.authenticated).toBe(true);
  });

  it('persists grants and keeps a deleted grant absent after another reopen', async () => {
    const { f, owner, teamId } = await ownedFixture();
    const target = await f.enroll();
    const path = `/v1/teams/${teamId}/grants`;
    const created = await f.call<GrantRecord>('POST', path, {
      to_team: target.team_id, caps_visible: ['tool:a'], ttl_ms: 3_600_000,
    }, ownerHeaders(owner));
    expect(created.status).toBe(200);
    await f.reopen();
    const listed = await f.call<{ grants: GrantRecord[] }>('GET', path, undefined, ownerHeaders(owner));
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body.grants) === JSON.stringify([created.body])).toBe(true);
    expect((await f.call('DELETE', `${path}/${created.body.grant_id}`, undefined, ownerHeaders(owner))).status).toBe(200);
    await f.reopen();
    const after = await f.call<{ grants: GrantRecord[] }>('GET', path, undefined, ownerHeaders(owner));
    expect(after.status).toBe(200);
    expect(after.body.grants.length).toBe(0);
  });

  it('restores lead task projections, duplicate semantics and monotonic revisions over HTTP', async () => {
    const { f, owner, teamId, node } = await ownedFixture();
    const path = `/v1/teams/${teamId}/tasks`;
    const task = projection(teamId, node.node_id);
    const created = await f.call<TaskRecord>('POST', path, task, nodeHeaders(node));
    expect(created.status).toBe(200);
    expect(created.body.content_hash === taskProjectionHash(task)).toBe(true);
    await f.reopen();
    const detail = await f.call<TaskRecord>('GET', `${path}/${task.task_id}`, undefined, ownerHeaders(owner));
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body) === JSON.stringify(created.body)).toBe(true);
    const duplicate = await f.call<TaskRecord>('POST', path, task, nodeHeaders(node));
    expect(duplicate.status).toBe(200);
    expect(JSON.stringify(duplicate.body) === JSON.stringify(created.body)).toBe(true);
    const next = { ...task, task_seq: 1, status: 'running' };
    expect((await f.call('POST', path, next, nodeHeaders(node))).status).toBe(200);
    expect((await f.call('POST', path, task, nodeHeaders(node))).status).toBe(409);
    expect((await f.call('POST', path, { ...next, status: 'done' }, nodeHeaders(node))).status).toBe(409);
    await f.reopen();
    const listed = await f.call<{ tasks: TaskRecord[] }>('GET', path, undefined, ownerHeaders(owner));
    expect(listed.status).toBe(200);
    expect(listed.body.tasks.length).toBe(1);
    expect(listed.body.tasks[0]?.task_seq).toBe(1);
    expect(listed.body.tasks[0]?.status).toBe('running');
  });

  it('restores pending enroll invitations and never reuses a consumed invitation', async () => {
    const { f, owner, teamId } = await ownedFixture();
    const used = await f.invite(owner, teamId);
    await f.enroll(used);
    const pending = await f.invite(owner, teamId);
    await f.reopen();
    expect((await f.call('POST', '/v1/enroll', { token: used, pubkey: 'fixture-public-key' })).status).toBe(409);
    const enrolled = await f.enroll(pending);
    expect(enrolled.team_id === teamId).toBe(true);
    await f.reopen();
    expect((await f.call('POST', '/v1/enroll', { token: pending, pubkey: 'fixture-public-key' })).status).toBe(409);
    expect((await f.nodes(owner, teamId)).length).toBe(3);
  });

  it('keeps the same session and CSRF valid after reopen without reopening bootstrap', async () => {
    const { f, owner, teamId } = await ownedFixture();
    const handles = await f.reopen();
    expect(handles.auth.needsInit).toBe(false);
    const me = await f.call<{ csrf: string }>('GET', '/v1/auth/me', undefined, ownerHeaders(owner));
    expect(me.status).toBe(200);
    expect(me.body.csrf === owner.csrf).toBe(true);
    await f.invite(owner, teamId);
    expect((await f.call('POST', '/v1/auth/register', { username: 'another-owner', password: randomUUID() })).status).toBe(403);
  });

  it('persists logout revocation while permitting a fresh password login', async () => {
    const { f, owner, teamId } = await ownedFixture();
    expect((await f.call('POST', '/v1/auth/logout', {}, ownerHeaders(owner))).status).toBe(200);
    expect((await f.call('GET', '/v1/auth/me', undefined, ownerHeaders(owner))).status).toBe(401);
    await f.reopen();
    expect((await f.call('GET', '/v1/auth/me', undefined, ownerHeaders(owner))).status).toBe(401);
    expect((await f.call('POST', `/v1/teams/${teamId}/enroll-tokens`, {}, ownerHeaders(owner))).status).toBe(401);
    const login = await f.call<{ csrf: string }>('POST', '/v1/auth/login', { username: owner.username, password: owner.password });
    expect(login.status).toBe(200);
    const cookie = (login.setCookie ?? '').split(';')[0]!;
    expect(cookie.length > 0 && cookie !== owner.cookie).toBe(true);
    const fresh = { ...owner, cookie, csrf: login.body.csrf };
    await f.reopen();
    expect((await f.call('GET', '/v1/auth/me', undefined, ownerHeaders(owner))).status).toBe(401);
    expect((await f.call('GET', '/v1/auth/me', undefined, ownerHeaders(fresh))).status).toBe(200);
  });

  it.each([
    { action: 'suspend', status: 'suspended', closeCode: 4001, error: 'node_suspended' },
    { action: 'revoke', status: 'revoked', closeCode: 4002, error: 'node_revoked' },
  ])('persists $action enforcement and the directory epoch for HTTP and WS', async ({ action, status, closeCode, error }) => {
    const { f, owner, teamId, node } = await ownedFixture();
    const peer = await f.connect(node.node_token);
    expect(peer.authenticated).toBe(true);
    expect((await f.call('POST', `/v1/nodes/${node.node_id}/${action}`, {}, ownerHeaders(owner))).status).toBe(200);
    expect(await peer.waitClosed()).toBe(closeCode);
    await f.stop();
    const epoch = f.offline((storage) => storage.database.prepare('SELECT epoch FROM registry_meta WHERE id = 1').get()?.epoch);
    expect(typeof epoch === 'number' && epoch >= 2).toBe(true);
    await f.start('open');
    const me = await f.call<{ error: { code: string } }>('GET', '/v1/nodes/me', undefined, nodeHeaders(node));
    expect(me.status).toBe(403);
    expect(me.body.error.code === error).toBe(true);
    const denied = await f.connect(node.node_token);
    expect(denied.authenticated).toBe(false);
    expect(await denied.waitClosed()).toBe(4003);
    expect((await f.nodes(owner, teamId)).every((entry) => entry.online === false)).toBe(true);
    await f.stop();
    f.offline((storage) => {
      expect(storage.database.prepare('SELECT epoch FROM registry_meta WHERE id = 1').get()?.epoch).toBe(epoch);
      const row = storage.database.prepare("SELECT json_extract(record, '$.status') AS status FROM registry_nodes WHERE id = ?").get(node.node_id);
      expect(row?.status).toBe(status);
    });
  });

  it('ignores the replaced WS close but clears presence when the current WS closes', async () => {
    const { f, owner, teamId, node } = await ownedFixture();
    const old = await f.connect(node.node_token);
    expect(old.authenticated).toBe(true);
    expect((await f.nodes(owner, teamId))[0]?.online).toBe(true);
    const current = await f.connect(node.node_token);
    expect(current.authenticated).toBe(true);
    expect(await old.waitClosed()).toBe(4000);
    expect((await f.nodes(owner, teamId))[0]?.online).toBe(true);
    expect((await f.teams(owner))[0]?.online).toBe(1);
    current.close();
    await current.waitClosed();
    await expect.poll(async () => (await f.nodes(owner, teamId))[0]?.online).toBe(false);
    expect((await f.teams(owner))[0]?.online).toBe(0);
  });

  it('starts every restored node offline until a fresh WS authenticates', async () => {
    const { f, owner, teamId, node } = await ownedFixture();
    const peer = await f.connect(node.node_token);
    expect(peer.authenticated).toBe(true);
    expect((await f.nodes(owner, teamId))[0]?.online).toBe(true);
    await f.reopen();
    expect(await peer.waitClosed()).toBe(1001);
    expect((await f.nodes(owner, teamId))[0]?.online).toBe(false);
    expect((await f.teams(owner))[0]?.online).toBe(0);
    expect((await f.call('GET', '/v1/nodes/me', undefined, nodeHeaders(node))).status).toBe(200);
    expect((await f.nodes(owner, teamId))[0]?.online).toBe(false);
    expect((await f.connect(node.node_token)).authenticated).toBe(true);
    expect((await f.nodes(owner, teamId))[0]?.online).toBe(true);
  });

  it('rejects overlapping startup ownership without disturbing the winning server', async () => {
    const f = new DurableServerFixture();
    const results = await Promise.allSettled([f.start(), f.start('open')]);
    expect(results.filter((result) => result.status === 'fulfilled').length).toBe(1);
    const failure = results.find((result) => result.status === 'rejected');
    expect(failure?.status === 'rejected' && (failure.reason as { code?: string }).code === 'OWNERSHIP_BUSY').toBe(true);
    const owner = await f.register();
    expect((await f.call('GET', '/v1/auth/me', undefined, ownerHeaders(owner))).status).toBe(200);
    await f.reopen();
    expect((await f.call('GET', '/v1/auth/me', undefined, ownerHeaders(owner))).status).toBe(200);
  });

  it('drains a separate gateway when the later HTTP listen fails and releases its DB and port', async () => {
    const { f, owner, node } = await ownedFixture();
    await f.stop();
    const blocker = new DurableServerFixture();
    const occupied = await blocker.start('create', { storage: undefined, ephemeral: true });
    const listen = WsGateway.prototype.listen;
    let gatewayPort = 0;
    let admitted: Awaited<ReturnType<DurableServerFixture['connect']>> | undefined;
    // Observe the real first listener and admit a real socket before the second bind fails.
    // No fake server/core/store: the original listen method still binds the gateway.
    const spy = vi.spyOn(WsGateway.prototype, 'listen').mockImplementationOnce(async function (this: WsGateway, port, host) {
      gatewayPort = await listen.call(this, port, host);
      admitted = await f.connect(node.node_token, `ws://127.0.0.1:${gatewayPort}`);
      return gatewayPort;
    });
    try {
      await expect(f.start('open', { gatewayPath: undefined, gatewayPort: 0, registryPort: occupied.registryPort }))
        .rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally { spy.mockRestore(); }
    expect(admitted?.authenticated).toBe(true);
    expect(await admitted?.waitClosed()).toBe(1001);
    const reopened = await f.start('open', { gatewayPath: undefined, gatewayPort });
    expect(reopened.gatewayPort).toBe(gatewayPort);
    expect((await f.connect(node.node_token)).authenticated).toBe(true);
    expect((await f.call('GET', '/v1/auth/me', undefined, ownerHeaders(owner))).status).toBe(200);
  });

  it('rejects a corrupt auth marker without bootstrap and releases ownership after each failure', async () => {
    const f = new DurableServerFixture();
    await f.start();
    await f.register();
    await f.stop();
    const before = f.offline((storage) => {
      storage.transaction((db) => db.exec('UPDATE auth_meta SET initialized = 0 WHERE id = 1'));
      return persistedSnapshot(storage);
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(f.start('open', { seedTeam: { name: 'must-not-bootstrap' } })).rejects.toMatchObject({ httpStatus: 503 });
      f.offline((storage) => {
        expect(persistedSnapshot(storage) === before).toBe(true);
        expect(storage.database.prepare('SELECT count(*) AS count FROM registry_teams').get()?.count).toBe(0);
        let unavailable = false;
        try { new AuthService({ storage }); }
        catch (error) { unavailable = error instanceof AuthError && error.httpStatus === 503; }
        expect(unavailable).toBe(true);
      });
    }
  });

  it.each([
    { field: 'caps', sql: `CREATE TRIGGER reject_fixture_write BEFORE UPDATE ON registry_nodes
      WHEN json_extract(NEW.record, '$.caps_rev') <> json_extract(OLD.record, '$.caps_rev')
      BEGIN SELECT RAISE(ABORT, 'injected caps failure'); END` },
    { field: 'name', sql: `CREATE TRIGGER reject_fixture_write BEFORE UPDATE ON registry_nodes
      WHEN json_extract(NEW.record, '$.name') <> json_extract(OLD.record, '$.name')
      BEGIN SELECT RAISE(ABORT, 'injected name failure'); END` },
    { field: 'task', sql: `CREATE TRIGGER reject_fixture_write BEFORE UPDATE ON registry_tasks
      BEGIN SELECT RAISE(ABORT, 'injected projection failure'); END` },
  ])('does not acknowledge or persist a rejected $field write', async ({ field, sql }) => {
    const { f, owner, teamId, node } = await ownedFixture();
    const task = projection(teamId, node.node_id);
    const path = `/v1/teams/${teamId}/tasks`;
    expect((await f.call('POST', path, task, nodeHeaders(node))).status).toBe(200);
    const beforeNode = (await f.nodes(owner, teamId))[0]!;
    await f.stop();
    const before = f.offline((storage) => {
      storage.transaction((db) => db.exec(sql));
      return persistedSnapshot(storage);
    });
    await f.start('open');
    // Ensure an accidental separately committed auth touch cannot hide in the same millisecond.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const response = field === 'caps'
      ? await f.call('PUT', '/v1/nodes/me/caps', { caps: ['tool:uncommitted'] }, nodeHeaders(node))
      : field === 'name'
        ? await f.call('PATCH', '/v1/nodes/me', { name: 'uncommitted' }, nodeHeaders(node))
        : await f.call('POST', path, { ...task, task_seq: 1, status: 'done' }, nodeHeaders(node));
    expect(response.ok).toBe(false);
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify((await f.nodes(owner, teamId))[0]) === JSON.stringify(beforeNode)).toBe(true);
    const report = await f.call<TaskRecord>('GET', `${path}/${task.task_id}`, undefined, ownerHeaders(owner));
    expect(report.status).toBe(200);
    expect(report.body.task_seq).toBe(0);
    await f.stop();
    // Includes last_seen, epoch, audit, auth and all domain rows; no partial persistence allowed.
    expect(f.offline(persistedSnapshot) === before).toBe(true);
  });
});