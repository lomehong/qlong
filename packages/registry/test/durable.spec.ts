import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { defineMigration, SqliteStore } from '../../storage/src/index.js';
import type { SqliteStoreOptions } from '../../storage/src/index.js';
import { Registry } from '../src/directory.js';
import type { RegistryOptions } from '../src/directory.js';
import { REGISTRY_SQL } from '../src/state-store.js';

const tempBase = realpathSync(tmpdir());
const roots = new Set<string>();
const stores = new Set<SqliteStore>();
const schema = {
  id: 'qlong.registry-test',
  migrations: [defineMigration({ version: 1, name: 'registry', sql: REGISTRY_SQL })],
};

function fixture(registryOptions: RegistryOptions = {}) {
  const root = mkdtempSync(join(tempBase, 'qlong-registry-'));
  roots.add(root);
  const options: SqliteStoreOptions = {
    allowedBase: root, dataDir: join(root, 'data'), mode: 'create', schema,
    localFilesystemConfirmed: true, windowsAclConfirmed: true, busyTimeoutMs: 25,
  };
  const open = (mode: 'create' | 'open') => {
    const storage = SqliteStore.open({ ...options, mode });
    stores.add(storage);
    return storage;
  };
  let storage = open('create');
  let registry = new Registry({ now: () => 1_000_000, ...registryOptions, storage });
  return {
    get storage() { return storage; },
    get registry() { return registry; },
    reopen() {
      storage.close();
      storage = open('open');
      registry = new Registry({ now: () => 1_000_000, ...registryOptions, storage });
      return registry;
    },
  };
}

afterEach(() => {
  for (const storage of [...stores].reverse()) storage.close();
  stores.clear();
  for (const root of roots) {
    if (dirname(root) !== tempBase || !basename(root).startsWith('qlong-registry-')) {
      throw new Error('Unsafe registry fixture cleanup target');
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  roots.clear();
});

function seed(registry: Registry) {
  const team = registry.createTeam({ name: 'owned', owner_user_id: 'owner' });
  const invite = registry.issueEnrollToken(team.team_id, { created_by: 'owner' });
  const node = registry.enroll({ token: invite, pubkey: 'public-key-1', platform: 'test', qlong_version: '1' });
  const target = registry.createTeam({ name: 'target' });
  const pending = registry.issueEnrollToken(target.team_id);
  const grant = registry.createGrant({ from_team: team.team_id, to_team: target.team_id, caps_visible: ['tool:x'], ttlMs: 5_000 });
  registry.upsertTask({ task_id: 'task-z', type: 'project', team_id: team.team_id, lead: node.node_id, exec: node.node_id, attempt: 1, status: 'running' });
  registry.logAudit('enrolled', node.node_id, team.team_id, 'test event', 'trace');
  return { team, invite, node, target, pending, grant };
}

/** Assertions must never dump credential-bearing records, even on a failing test. */
function fingerprint(registry: Registry, includePresence = true): string {
  return createHash('sha256').update(JSON.stringify({
    teams: [...registry.teams], nodes: [...registry.nodes], grants: [...registry.grants],
    tasks: [...registry.taskIndex], audit: registry.auditLog, epoch: registry.directoryEpoch,
    presence: includePresence ? [...registry.presence] : [],
  })).digest('hex');
}

function rejectWrites(storage: SqliteStore): void {
  // The final metadata statement fails after all row diffs, exercising actual SQL rollback.
  storage.transaction((db) => db.exec(`CREATE TRIGGER reject_registry_write BEFORE UPDATE ON registry_meta
    BEGIN SELECT RAISE(ABORT, 'injected registry write failure'); END`));
}

function allowWrites(storage: SqliteStore): void {
  storage.transaction((db) => db.exec('DROP TRIGGER reject_registry_write'));
}

describe('durable registry', () => {
  it('rejects stale facades sharing one store instead of overwriting a later commit', () => {
    const f = fixture();
    const observer = new Registry({ storage: f.storage });
    f.registry.createTeam({ name: 'committed' });
    expect(() => observer.createTeam({ name: 'stale' })).toThrow('stale');
    expect(() => observer.teams).toThrow('stale');
    expect(f.reopen().teams.size).toBe(1);
  });

  it('reopens teams, keys, consumed/pending invites, revoked mappings, epoch, grants, tasks and audit; presence stays offline', () => {
    let now = 1_000_000;
    const f = fixture({ now: () => now });
    const r = f.registry;
    const s = seed(r);
    r.putCaps(s.node.node_token, ['tool:x']);
    r.putLoad(s.node.node_token, { jobs: { active: 2 } });
    r.updateNodeName(s.node.node_token, 'renamed');
    for (let epoch = 2; epoch <= 7; epoch++) {
      r.rotateKeys(s.node.node_token, { pubkey: `public-key-${epoch}`, sig: 'test-proof' }, () => true);
    }
    now += 100;
    r.authByToken(s.node.node_token);
    r.joinTeam(s.node.node_token, s.pending);
    const unused = r.issueEnrollToken(s.target.team_id);
    const expired = r.issueEnrollToken(s.target.team_id, { ttlMs: -1 });
    const revoked = r.enroll({ pubkey: 'revoked-public-key' });
    r.revoke(revoked.node_id);
    const suspended = r.enroll({ pubkey: 'suspended-public-key' });
    r.suspend(suspended.node_id);
    r.upsertTask({ task_id: 'task-a', type: 'aid', team_id: s.team.team_id, lead: s.node.node_id, exec: revoked.node_id, attempt: 2, status: 'done' });
    r.upsertTask({ task_id: 'task-z', type: 'project', team_id: s.team.team_id, lead: s.node.node_id, exec: s.node.node_id, attempt: 3, status: 'done' });
    const epoch = r.directoryEpoch;
    r.presence.set(s.node.node_id, true);

    const restored = f.reopen();
    expect(restored.directoryEpoch).toBe(epoch);
    expect(restored.teams.get(s.team.team_id)?.owner_user_id).toBe('owner');
    expect(restored.teams.get(revoked.team_id)?.state).toBe('self-owned');
    expect(restored.getNode(s.node.node_id)?.name).toBe('renamed');
    expect(restored.getNode(s.node.node_id)?.last_seen).toBe(new Date(now).toISOString());
    expect(restored.getNode(s.node.node_id)?.keys.map((k) => k.epoch)).toEqual([3, 4, 5, 6, 7]);
    expect(restored.lookupPubkey(s.node.node_id, 3).status).toBe('historical');
    expect(restored.lookupPubkey(s.node.node_id, 7).status).toBe('current');
    expect(restored.getNode(s.node.node_id)?.team_id).toBe(s.target.team_id);
    expect(restored.getNode(s.node.node_id)?.caps).toEqual(['tool:x']);
    expect(restored.getNode(s.node.node_id)?.caps_rev).toBe(2);
    expect(restored.getNode(s.node.node_id)?.load).toEqual({ jobs: { active: 2 } });
    expect(restored.getNode(s.node.node_id)?.platform).toBe('test');
    expect(restored.getNode(s.node.node_id)?.qlong_version).toBe('1');
    expect(restored.presence.size).toBe(0);
    expect(restored.listTeamNodes(s.target.team_id)[0]?.online).toBe(false);
    expect(() => restored.authByToken(revoked.node_token)).toThrow(/吊销/);
    expect(() => restored.authByToken(suspended.node_token)).toThrow(/暂停/);
    expect(() => restored.enroll({ token: s.invite, pubkey: 'public-key' })).toThrow(/已被使用/);
    expect(() => restored.enroll({ token: s.pending, pubkey: 'public-key' })).toThrow(/已被使用/);
    expect(() => restored.enroll({ token: expired, pubkey: 'public-key' })).toThrow(/过期/);
    expect(restored.enroll({ token: unused, pubkey: 'public-key' }).team_id).toBe(s.target.team_id);
    expect(restored.hasGrant(s.team.team_id, s.target.team_id)).toBe(true);
    expect(restored.listTasks(s.team.team_id).map((t) => t.task_id)).toEqual(['task-z', 'task-a']);
    expect(restored.listTasks(s.team.team_id)[0]?.attempt).toBe(3);
    expect(restored.getAuditEvents(s.team.team_id, 10)[0]?.trace_id).toBe('trace');
    restored.revokeGrant(s.grant.grant_id);
    expect(f.reopen().hasGrant(s.team.team_id, s.target.team_id)).toBe(false);
  });

  it('never stores plaintext tokens', () => {
    const f = fixture();
    const s = seed(f.registry);
    for (const token of [s.invite, s.node.node_token, s.pending]) {
      const count = f.storage.database.prepare(`SELECT count(*) AS count FROM (
        SELECT record FROM registry_nodes UNION ALL SELECT record FROM registry_enroll_tokens
      ) WHERE instr(record, ?) > 0`).get(token)?.count;
      expect(count).toBe(0);
    }
  });

  it('rolls back every mutator, including auth last_seen, and publishes no cache/epoch/presence/notification changes', () => {
    let now = 1_000_000;
    const f = fixture({ now: () => now });
    const r = f.registry;
    const s = seed(r);
    const suspended = r.enroll({ pubkey: 'suspended-public-key' });
    r.suspend(suspended.node_id);
    r.presence.set(s.node.node_id, true);
    let notifications = 0;
    r.onDirectoryChange(() => { notifications++; });
    const before = fingerprint(r);
    const persistedBefore = fingerprint(r, false);
    const invitesBefore = f.storage.database.prepare('SELECT count(*) AS count FROM registry_enroll_tokens').get()?.count;
    now += 100;
    rejectWrites(f.storage);
    const writes: Array<() => unknown> = [
      () => r.createTeam(), () => r.issueEnrollToken(s.team.team_id),
      () => r.enroll({ pubkey: 'solo-public-key' }),
      () => r.enroll({ token: s.pending, pubkey: 'invited-public-key' }),
      () => r.joinTeam(s.node.node_token, s.pending), () => r.authByToken(s.node.node_token),
      () => r.updateNodeName(s.node.node_token, 'not-committed'),
      () => r.rotateKeys(s.node.node_token, { pubkey: 'next-public-key', sig: 'proof' }, () => true),
      () => r.suspend(s.node.node_id), () => r.resume(suspended.node_id), () => r.revoke(s.node.node_id),
      () => r.putCaps(s.node.node_token, ['tool:new']), () => r.putLoad(s.node.node_token, { active: 3 }),
      () => r.createGrant({ from_team: s.target.team_id, to_team: s.team.team_id }),
      () => r.revokeGrant(s.grant.grant_id), () => r.logAudit('not-committed', '', '', 'test'),
      () => r.upsertTask({ task_id: 'task-z', type: 'project', team_id: s.team.team_id, lead: s.node.node_id, exec: s.node.node_id, attempt: 9, status: 'done' }),
      () => r.gc(),
    ];
    for (const write of writes) {
      expect(write).toThrow(/injected registry write failure/);
      expect(fingerprint(r) === before).toBe(true);
      expect(notifications).toBe(0);
    }
    expect(f.storage.state).toBe('open');
    allowWrites(f.storage);
    const restored = f.reopen();
    expect(fingerprint(restored, false) === persistedBefore).toBe(true);
    expect(f.storage.database.prepare('SELECT count(*) AS count FROM registry_enroll_tokens').get()?.count).toBe(invitesBefore);
    expect(restored.getNode(s.node.node_id)?.last_seen).toBeUndefined();
    expect(restored.listTasks(s.team.team_id)[0]?.attempt).toBe(1);
    expect(restored.joinTeam(s.node.node_token, s.pending).team_id).toBe(s.target.team_id);
  });

  it('never publishes or notifies when deferred constraints fail at COMMIT', () => {
    const f = fixture();
    let notifications = 0;
    f.registry.onDirectoryChange(() => { notifications++; });
    f.storage.transaction((db) => db.exec(`
      CREATE TABLE registry_test_commit_fault (
        parent TEXT REFERENCES registry_nodes(id) DEFERRABLE INITIALLY DEFERRED
      ) STRICT;
      CREATE TRIGGER registry_test_commit_fault_trigger AFTER UPDATE ON registry_meta
      BEGIN INSERT INTO registry_test_commit_fault (parent) VALUES ('missing-node'); END;
    `));
    expect(() => f.registry.enroll({ pubkey: 'public-key' })).toThrow();
    expect(f.storage.state).toBe('faulted');
    expect(notifications).toBe(0);
    expect(() => f.registry.snapshot()).toThrow();
    const restored = f.reopen();
    expect(restored.teams.size).toBe(0);
    expect(restored.nodes.size).toBe(0);
    expect(restored.directoryEpoch).toBe(0);
  });

  it('notifies once after join+consume+epoch are committed, and after the cache is published', () => {
    const f = fixture();
    const s = seed(f.registry);
    const before = f.registry.directoryEpoch;
    const observations: Array<{ transaction: boolean; epoch: number; team: string | undefined; consumed: number; cacheTeam: string | undefined }> = [];
    f.registry.onDirectoryChange(() => {
      const committed = new Registry({ storage: f.storage });
      observations.push({
        transaction: f.storage.database.isTransaction, epoch: committed.directoryEpoch,
        team: committed.getNode(s.node.node_id)?.team_id,
        cacheTeam: f.registry.getNode(s.node.node_id)?.team_id,
        consumed: Number(f.storage.database.prepare('SELECT count(*) AS count FROM registry_enroll_tokens WHERE used_by = ?').get(s.node.node_id)?.count),
      });
    });
    f.registry.joinTeam(s.node.node_token, s.pending);
    expect(observations).toEqual([{ transaction: false, epoch: before + 1, team: s.target.team_id, cacheTeam: s.target.team_id, consumed: 2 }]);
  });

  it('detaches every read view, result, input object and verifier node; epoch cannot be assigned', () => {
    const f = fixture();
    const r = f.registry;
    const s = seed(r);
    const load = { jobs: { active: 1 } };
    const visible = ['tool:y'];
    r.putLoad(s.node.node_token, load);
    const grant = r.createGrant({ from_team: s.target.team_id, to_team: s.team.team_id, caps_visible: visible });
    const returned = r.authByToken(s.node.node_token);
    const named = r.updateNodeName(s.node.node_token, 'correct');
    r.rotateKeys(s.node.node_token, { pubkey: 'next-public-key', sig: 'proof' }, (node) => {
      node.name = 'verifier-mutation';
      node.keys.length = 0;
      return true;
    });
    const before = fingerprint(r);
    s.team.name = 'bad'; s.grant.caps_visible.push('bad');
    load.jobs.active = 99; visible.push('bad'); grant.caps_visible.push('bad');
    returned.status = 'revoked'; named.name = 'bad';
    r.teams.get(s.team.team_id)!.name = 'bad'; r.teams.clear();
    r.nodes.get(s.node.node_id)!.keys.length = 0; r.nodes.clear();
    r.getNode(s.node.node_id)!.caps.push('bad');
    r.grants.get(s.grant.grant_id)!.caps_visible.length = 0; r.grants.clear();
    r.listGrants(s.team.team_id)[0]!.caps_visible.push('bad');
    r.taskIndex.get('task-z')!.status = 'bad'; r.taskIndex.clear();
    r.listTasks(s.team.team_id)[0]!.status = 'bad';
    r.auditLog[0]!.reason = 'bad'; r.auditLog.length = 0;
    r.getAuditEvents(s.team.team_id, 10)[0]!.reason = 'bad';
    const listed = r.listTeamNodes(s.team.team_id)[0]!;
    (listed.caps as string[]).push('bad');
    (listed.load as typeof load).jobs.active = 99;
    r.snapshot().nodes[0]!.keys.length = 0;
    expect(() => { r.directoryEpoch = 999; }).toThrow(/read-only/);
    expect(fingerprint(r) === before).toBe(true);
    const restored = f.reopen();
    expect(restored.getNode(s.node.node_id)?.name).toBe('correct');
    expect(restored.getNode(s.node.node_id)?.load).toEqual({ jobs: { active: 1 } });
    expect(restored.lookupPubkey(s.node.node_id).status).toBe('current');
  });

  it('fails closed on all read/auth surfaces when storage is faulted or closed', () => {
    const f = fixture();
    const s = seed(f.registry);
    // A non-constraint SQLite failure poisons the real store and closes its connection.
    expect(() => f.storage.transaction((db) => db.exec('SELECT * FROM deliberately_missing_registry_table'))).toThrow();
    expect(f.storage.state).toBe('faulted');
    const reads: Array<() => unknown> = [
      () => f.registry.teams, () => f.registry.nodes, () => f.registry.grants,
      () => f.registry.taskIndex, () => f.registry.auditLog, () => f.registry.directoryEpoch,
      () => f.registry.snapshot(), () => f.registry.getNode(s.node.node_id),
      () => f.registry.lookupPubkey(s.node.node_id), () => f.registry.listTeams(),
      () => f.registry.listTeamNodes(s.team.team_id), () => f.registry.listTasks(s.team.team_id),
      () => f.registry.listGrants(s.team.team_id), () => f.registry.hasGrant(s.team.team_id, s.target.team_id),
      () => f.registry.getAuditEvents(s.team.team_id, 1), () => f.registry.authByToken(s.node.node_token),
      () => f.registry.createTeam(),
    ];
    for (const read of reads) expect(read).toThrow();
    f.storage.close();
    for (const read of reads) expect(read).toThrow();
  });

  it('GC atomically removes only unreferenced teams, retains grant/task/node relations and revoked token mappings', () => {
    let now = 1_000_000;
    const f = fixture({ now: () => now, orphanTeamTtlMs: 100, offlineNodeTtlMs: 100 });
    const r = f.registry;
    const s = seed(r);
    const taskOnly = r.createTeam();
    r.upsertTask({ task_id: 'task-only', type: 'aid', team_id: taskOnly.team_id, lead: s.node.node_id, exec: s.node.node_id, attempt: 1, status: 'done' });
    const empty = r.createTeam();
    const invite = r.issueEnrollToken(empty.team_id);
    r.putCaps(s.node.node_token, ['tool:x']);
    const solo = r.enroll({ pubkey: 'solo-public-key' });
    r.revoke(solo.node_id);
    now += 101;
    const before = fingerprint(r);
    let notifications = 0;
    r.onDirectoryChange(() => { notifications++; });
    rejectWrites(f.storage);
    expect(() => r.gc()).toThrow(/injected/);
    expect(fingerprint(r) === before).toBe(true);
    expect(notifications).toBe(0);
    allowWrites(f.storage);
    expect(r.gc()).toEqual({ removedOrphanTeams: 1, revokedOfflineNodes: 1 });
    expect(notifications).toBe(1);
    expect(r.gc()).toEqual({ removedOrphanTeams: 0, revokedOfflineNodes: 0 });
    expect(notifications).toBe(1);
    const restored = f.reopen();
    expect(restored.teams.has(empty.team_id)).toBe(false);
    expect(restored.teams.has(s.target.team_id)).toBe(true);
    expect(restored.teams.has(taskOnly.team_id)).toBe(true);
    expect(restored.teams.has(solo.team_id)).toBe(true);
    expect(restored.getNode(s.node.node_id)?.caps).toEqual([]);
    expect(restored.listTasks(taskOnly.team_id)).toHaveLength(1);
    expect(restored.listGrants(s.target.team_id)).toHaveLength(1);
    expect(() => restored.authByToken(s.node.node_token)).toThrow(/吊销/);
    expect(() => restored.authByToken(solo.node_token)).toThrow(/吊销/);
    expect(() => restored.enroll({ token: invite, pubkey: 'public-key' })).toThrow(/无效/);
    expect(f.storage.database.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('retains ordered audit records with bounded row-level trimming across reopen', () => {
    const f = fixture();
    f.storage.transaction((db) => {
      const insert = db.prepare('INSERT INTO registry_audit (id, record) VALUES (?, ?)');
      for (let id = 0; id < 10_000; id++) {
        insert.run(id, JSON.stringify({ ts: new Date(1_000_000).toISOString(), event: 'test', node: '', team: 'unknown-team', reason: `event-${id}` }));
      }
    });
    const r = f.reopen();
    r.logAudit('test', '', 'unknown-team', 'latest');
    expect(r.auditLog.length).toBe(10_000);
    expect(r.auditLog[0]?.reason).toBe('event-1');
    const restored = f.reopen();
    expect(restored.getAuditEvents('unknown-team', 1)[0]?.reason).toBe('latest');
    expect(f.storage.database.prepare('SELECT min(id) AS first, max(id) AS last, count(*) AS count FROM registry_audit').get())
      .toEqual({ first: 1, last: 10_000, count: 10_000 });
  });

  it.each([
    `UPDATE registry_nodes SET record = json_set(record, '$.keys', json('[]'))`,
    `UPDATE registry_nodes SET record = json_set(record, '$.keys[0].epoch', 0)`,
    `UPDATE registry_nodes SET record = json_set(record, '$.tokenHash', 'malformed')`,
    `UPDATE registry_nodes SET record = json_set(record, '$.team_id', 'missing')`,
    `UPDATE registry_nodes SET record = json_set(record, '$.unexpected', true)`,
    `UPDATE registry_enroll_tokens SET record = json_remove(record, '$.consumed_at') WHERE used_by IS NOT NULL`,
    `UPDATE registry_tasks SET record = json_set(record, '$.attempt', 'invalid')`,
    `UPDATE registry_grants SET record = json_set(record, '$.caps_visible', 1)`,
    `UPDATE registry_teams SET record = '{}'`,
    `UPDATE registry_audit SET record = json_set(record, '$.ts', 'invalid')`,
    `UPDATE registry_meta SET audit_offset = 1`,
    `UPDATE registry_meta SET epoch = 0`,
    `DELETE FROM registry_meta`,
  ])('rejects malformed persisted shapes or relationships on recovery (%#)', (sql) => {
    const f = fixture();
    seed(f.registry);
    f.storage.transaction((db) => db.exec(sql));
    expect(() => f.reopen()).toThrow(/Invalid registry state/);
  });
});