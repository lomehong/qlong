import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { envelopeDigest, newId, newKeyPair, signEnvelope, toBase64, type EnvelopeV1 } from '@qlong/core';
import { AuthService, SESSION_COOKIE } from '../../registry/src/auth.js';
import { CENTER_SCHEMA, Registry, type EnrollResult } from '../../registry/src/index.js';
import type { TaskRecord } from '../../registry/src/state-store.js';
import { SqliteStore } from '../../storage/src/index.js';
import { createDurableNode } from '../../node/src/runtime/node.js';
import {
  cleanupServerFixtures, nodeHeaders, ownerHeaders, persistedSnapshot, type Owner,
} from './server-durable-fixtures.js';
import {
  centerView, claimTablesExist, CustodyFixture, failCommit, inspectSql, offer, readCenter, readClaim, readCommands,
  repairCommit, setup, wait,
} from './server-custody-helpers.js';

afterEach(async () => { await cleanupServerFixtures(); });

function deliveryStatus(store: SqliteStore, envelope: EnvelopeV1) {
  return store.database.prepare('SELECT status FROM node_delivery WHERE sender = ? AND msg_id = ?')
    .get(envelope.from.node_id, envelope.msg_id)?.status;
}

function unexecuted(store: SqliteStore): void {
  expect(store.database.prepare("SELECT count(*) AS count FROM node_inbox WHERE decision = 'pending' AND payload IS NOT NULL")
    .get()?.count).toBe(1);
  for (const table of ['node_state', 'node_effects', 'node_dedup', 'node_outbox']) {
    expect(store.database.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count).toBe(0);
  }
}

describe('startQlongServer v2 custody with real node runtimes', () => {
  it('persists offline custody through center/node restarts, receipts to a tombstone, and never executes the inbox', async () => {
    const { f, handles, sender, receiver } = await setup();
    const source = f.runtime(sender);
    const target = f.runtime(receiver);
    const a = await f.client(handles, sender, source.runtime);
    const b = await f.client(handles, receiver, target.runtime); // Enrolled but deliberately offline.
    const envelope = offer(sender, receiver);
    await a.client.open();
    source.runtime.save({ envelope, attempts: 0, lastAt: 0 });
    expect(source.runtime.all().length).toBe(1);
    expect(await a.client.send(envelope, { ackTimeoutMs: 3_000 })).toBe('stored');
    expect(a.events.acks).toEqual(['stored']);
    expect(source.runtime.all().length).toBe(0);
    expect(deliveryStatus(source.store, envelope)).toBe('stored');
    expect(target.runtime.pending().length).toBe(0);
    expect(readCenter(f, envelope)).toMatchObject({ status: 'pending', payload: true, digestMatches: true, entries: 1 });
    expect(readCenter(f, envelope).bytes).toBeGreaterThan(0);

    await Promise.all([a.close(), b.close()]);
    await f.stop();
    source.store.close();
    target.store.close();
    f.offline((store) => expect(centerView(store.database, envelope)).toMatchObject({ status: 'pending', payload: true }));

    const reopened = await f.start('open');
    const source2 = f.runtime(sender, 'open');
    const target2 = f.runtime(receiver, 'open');
    expect(source2.runtime.all().length).toBe(0);
    expect(deliveryStatus(source2.store, envelope)).toBe('stored');
    const a2 = await f.client(reopened, sender, source2.runtime);
    const b2 = await f.client(reopened, receiver, target2.runtime);
    await Promise.all([a2.client.open(), b2.client.open()]);
    // onInboxReady is not a center ACK. Observe the committed receiver receipt in a read-only DB view.
    await wait(() => expect(readCenter(f, envelope).status).toBe('received'));
    expect(b2.events.ready).toBe(1);
    expect(b2.events.legacy).toBe(0);
    expect(b2.client.rejectedInbound).toBe(0);
    expect(target2.runtime.pending().length).toBe(1);
    expect(envelopeDigest(target2.runtime.pending()[0]!) === envelopeDigest(envelope)).toBe(true);
    unexecuted(target2.store);
    await Promise.all([a2.close(), b2.close()]);
    await f.stop();
    source2.store.close();
    target2.store.close();
    f.offline((store) => expect(centerView(store.database, envelope)).toEqual({
      status: 'received', payload: false, digestMatches: true, entries: 1, bytes: 0,
    }));

    const finalCenter = await f.start('open');
    const target3 = f.runtime(receiver, 'open');
    const b3 = await f.client(finalCenter, receiver, target3.runtime);
    expect(target3.runtime.pending().length).toBe(1);
    // A stored runtime intentionally cannot resurrect its outbox: replay the exact signed bytes raw.
    const replay = await f.rawSender(finalCenter, sender);
    await replay.send(envelope, 'stored');
    await replay.send(signEnvelope({ ...envelope, body: { ...envelope.body, summary: 'changed after receipt' } }, sender.pair.priv), 'conflict');
    await replay.close();
    expect(replay.successes()).toBe(1);
    // Keep the recipient offline so a fast duplicate receipt cannot conceal payload resurrection.
    expect(readCenter(f, envelope)).toEqual({ status: 'received', payload: false, digestMatches: true, entries: 1, bytes: 0 });
    await b3.client.open();
    await b3.close();
    // Restart notification discovers existing pending work; it is not a redelivery or execution.
    expect(b3.events.ready).toBe(1);
    expect(b3.events.legacy).toBe(0);
    expect(target3.runtime.pending().length).toBe(1);
    unexecuted(target3.store);
    await f.stop();
    f.offline((store) => expect(centerView(store.database, envelope)).toEqual({
      status: 'received', payload: false, digestMatches: true, entries: 1, bytes: 0,
    }));
  }, 20_000);

  it('rejects a re-signed same-ID mutation without source deletion and reconciles a lost stored reply after reopen', async () => {
    const { f, handles, sender, receiver } = await setup();
    const source = f.runtime(sender);
    const envelope = offer(sender, receiver);
    source.runtime.save({ envelope, attempts: 0, lastAt: 0 });
    const raw = await f.rawSender(handles, sender);
    await raw.send(envelope, 'stored'); // Deliberately never hand this reply to the node runtime.
    await raw.close();
    expect(deliveryStatus(source.store, envelope)).toBe('pending');
    await f.stop();
    source.store.close();

    const reopened = await f.start('open');
    const source2 = f.runtime(sender, 'open');
    const conflicting = signEnvelope({ ...envelope, body: { ...envelope.body, summary: 'mutated same ID' } }, sender.pair.priv);
    expect(envelopeDigest(conflicting) !== envelopeDigest(envelope)).toBe(true);
    // The runtime forbids mutation; raw WS exercises the center conflict boundary instead.
    const attacker = await f.rawSender(reopened, sender);
    await attacker.send(conflicting, 'conflict');
    await attacker.close(); // Same-socket close drains any erroneous extra success frames too.
    expect(attacker.successes()).toBe(0);
    expect(source2.runtime.all().length).toBe(1);
    expect(envelopeDigest(source2.runtime.all()[0]!.envelope) === envelopeDigest(envelope)).toBe(true);
    expect(deliveryStatus(source2.store, envelope)).toBe('pending');
    expect(readCenter(f, envelope)).toMatchObject({ status: 'pending', digestMatches: true, payload: true, entries: 1 });

    const a = await f.client(reopened, sender, source2.runtime);
    await a.client.open(); // Real client automatically retries its persisted, unchanged pending ID.
    await wait(() => expect(a.events.acks).toEqual(['stored']));
    expect(source2.runtime.all().length).toBe(0);
    expect(deliveryStatus(source2.store, envelope)).toBe('stored');
    await a.close();
    await f.stop();
    f.offline((store) => expect(centerView(store.database, envelope)).toMatchObject({
      status: 'pending', digestMatches: true, payload: true, entries: 1,
    }));
  }, 20_000);

  it('closes admission on a center COMMIT failure, retains the sender payload, and delivers after offline repair', async () => {
    const { f, sender, receiver } = await setup();
    const source = f.runtime(sender);
    const target = f.runtime(receiver);
    const envelope = offer(sender, receiver);
    await f.stop();
    f.offline((store) => failCommit(store, 'gateway_custody'));
    const broken = await f.start('open');
    const a = await f.client(broken, sender, source.runtime);
    await a.client.open();
    source.runtime.save({ envelope, attempts: 0, lastAt: 0 });
    expect(await a.client.send(envelope, { ackTimeoutMs: 3_000 })).toBe('timeout');
    await wait(() => expect(a.events.closes[0]).toBe(1011));
    await a.close(); // Stop retries before repairing/reopening the authority.
    expect(a.events.acks.length).toBe(0);
    expect(source.runtime.all().length).toBe(1);
    expect(envelopeDigest(source.runtime.all()[0]!.envelope) === envelopeDigest(envelope)).toBe(true);
    expect(deliveryStatus(source.store, envelope)).toBe('pending');
    await f.stop();
    f.offline((store) => {
      expect(centerView(store.database, envelope)).toMatchObject({ status: undefined, entries: 0, bytes: 0 });
      repairCommit(store); // Recovered DB proves the trigger INSERT was rolled back at COMMIT.
    });
    source.store.close();
    target.store.close();

    const recovered = await f.start('open');
    const source2 = f.runtime(sender, 'open');
    const target2 = f.runtime(receiver, 'open');
    expect(source2.runtime.all().length).toBe(1);
    // Reset retry scheduling only, not immutable identity/content or custody status.
    source2.runtime.save({ envelope, attempts: 0, lastAt: 0 });
    const a2 = await f.client(recovered, sender, source2.runtime);
    const b2 = await f.client(recovered, receiver, target2.runtime);
    await a2.client.open();
    await wait(() => expect(a2.events.acks).toEqual(['stored']));
    expect(deliveryStatus(source2.store, envelope)).toBe('stored');
    expect(source2.runtime.all().length).toBe(0);
    await b2.client.open();
    await wait(() => expect(readCenter(f, envelope).status).toBe('received'));
    expect(target2.runtime.pending().length).toBe(1);
    expect(b2.events.legacy).toBe(0);
    await Promise.all([a2.close(), b2.close()]);
    await f.stop();
    f.offline((store) => expect(centerView(store.database, envelope)).toMatchObject({ status: 'received', bytes: 0 }));
  }, 20_000);

  it('withholds receipt when the receiver inbox COMMIT fails and recovers pending center custody after restart', async () => {
    const { f, handles, sender, receiver } = await setup();
    const source = f.runtime(sender);
    const target = f.runtime(receiver);
    const a = await f.client(handles, sender, source.runtime);
    const b = await f.client(handles, receiver, target.runtime);
    const envelope = offer(sender, receiver);
    // No node client is connected yet; use this runtime's sole owning connection for injection.
    failCommit(target.store, 'node_inbox');
    await a.client.open();
    source.runtime.save({ envelope, attempts: 0, lastAt: 0 });
    expect(await a.client.send(envelope, { ackTimeoutMs: 3_000 })).toBe('stored');
    await b.client.open();
    await wait(() => expect(b.events.closes[0]).toBe(1011));
    expect(b.events.faults).toBe(1);
    expect(b.events.ready).toBe(0);
    expect(b.events.legacy).toBe(0);
    expect(b.client.rejectedInbound).toBe(0); // Signature verified; durable admission failed afterwards.
    expect(target.store.state).toBe('faulted');
    expect(inspectSql(target.store.path, (db) => db.prepare('SELECT count(*) AS count FROM node_inbox').get()?.count)).toBe(0);
    expect(readCenter(f, envelope)).toMatchObject({ status: 'pending', payload: true, entries: 1 });
    await Promise.all([a.close(), b.close()]);
    await f.stop();
    source.store.close();
    target.store.close();
    f.offline((store) => expect(centerView(store.database, envelope)).toMatchObject({ status: 'pending', payload: true }));
    const target2 = f.runtime(receiver, 'open');
    expect(target2.runtime.pending().length).toBe(0);
    repairCommit(target2.store);
    const reopened = await f.start('open');
    const b2 = await f.client(reopened, receiver, target2.runtime);
    await b2.client.open();
    await wait(() => expect(readCenter(f, envelope).status).toBe('received'));
    expect(b2.events.ready).toBe(1);
    expect(b2.events.legacy).toBe(0);
    expect(target2.runtime.pending().length).toBe(1);
    unexecuted(target2.store);
    await b2.close();
    await f.stop();
    f.offline((store) => expect(centerView(store.database, envelope)).toMatchObject({ status: 'received', payload: false, bytes: 0 }));
  }, 20_000);

  it('checks real registry signatures before inbox admission and never receipts an envelope signed by another key', async () => {
    const { f, handles, sender, receiver } = await setup();
    const source = f.runtime(sender);
    const target = f.runtime(receiver);
    const a = await f.client(handles, sender, source.runtime);
    const b = await f.client(handles, receiver, target.runtime);
    const forged = signEnvelope(offer(sender, receiver), receiver.pair.priv);
    await a.client.open();
    expect(await a.client.send(forged, { ackTimeoutMs: 3_000 })).toBe('stored');
    await b.client.open();
    await wait(() => expect(b.client.rejectedInbound > 0).toBe(true));
    expect(target.runtime.pending().length).toBe(0);
    expect(b.events.ready).toBe(0);
    expect(readCenter(f, forged)).toMatchObject({ status: 'pending', payload: true });
    const valid = offer(sender, receiver);
    expect(await a.client.send(valid, { ackTimeoutMs: 3_000 })).toBe('stored');
    await wait(() => expect(readCenter(f, valid).status).toBe('received'));
    expect(target.runtime.pending().length).toBe(1);
    expect(envelopeDigest(target.runtime.pending()[0]!) === envelopeDigest(valid)).toBe(true);
    expect(b.events.legacy).toBe(0);
    await Promise.all([a.close(), b.close()]);
    await f.stop();
    f.offline((store) => {
      expect(centerView(store.database, forged)).toMatchObject({ status: 'pending', payload: true });
      expect(centerView(store.database, valid)).toMatchObject({ status: 'received', payload: false });
    });
  }, 20_000);

  it('rejects a legacy GatewayClient with 4004 without fallback or loss of its queued message', async () => {
    const { f, handles, sender, receiver, owner, teamId } = await setup();
    const legacy = await f.client(handles, sender); // No runtime means the real v1 handshake.
    legacy.client.outbox.save({ envelope: offer(sender, receiver), attempts: 0, lastAt: 0 });
    expect(legacy.client.transportVersion).toBe(1);
    await expect(legacy.client.open()).rejects.toThrow('gateway connection failed');
    await wait(() => expect(legacy.events.closes).toEqual([4004]));
    expect(legacy.client.state).toBe('closed');
    await expect(legacy.client.open()).rejects.toThrow('stopped');
    expect(legacy.events.acks.length).toBe(0);
    expect(legacy.client.outbox.all().length).toBe(1);
    expect((await f.nodes(owner, teamId)).every((node) => !node.online)).toBe(true);
    await f.stop();
    f.offline((store) => expect(store.database.prepare('SELECT count(*) AS count FROM gateway_custody').get()?.count).toBe(0));
  }, 20_000);

  it('drives custody retention GC from the server timer: reclaims received tombstones, never pending custody', async () => {
    // retentionMs 0 makes every terminal row eligible immediately; a 20ms GC cadence proves the timer runs.
    const { f, handles, sender, receiver } = await setup({ custodyRetentionMs: 0, gcIntervalMs: 20 });
    const source = f.runtime(sender);
    const target = f.runtime(receiver);
    const a = await f.client(handles, sender, source.runtime);
    const b = await f.client(handles, receiver, target.runtime);
    await a.client.open();
    await b.client.open();
    const delivered = offer(sender, receiver);
    expect(await a.client.send(delivered, { ackTimeoutMs: 3_000 })).toBe('stored');
    await wait(() => expect(readCenter(f, delivered).status).toBe('received'));
    // The retention GC cycle reclaims the received tombstone, freeing center capacity.
    await wait(() => expect(readCenter(f, delivered).entries).toBe(0));
    expect(readCenter(f, delivered).status).toBeUndefined();
    // Take the receiver offline so the next offer stays pending; pending custody must survive every GC cycle.
    await b.close();
    const queued = offer(sender, receiver);
    expect(await a.client.send(queued, { ackTimeoutMs: 3_000 })).toBe('stored');
    await wait(() => expect(readCenter(f, queued).status).toBe('pending'));
    await new Promise((resolve) => setTimeout(resolve, 80)); // Several gcIntervalMs ticks elapse.
    expect(readCenter(f, queued)).toMatchObject({ status: 'pending', payload: true, entries: 1 });
    await a.close();
  }, 20_000);

  it('exposes GET /v1/nodes/me/deliveries/:msgId so the sender alone reads the real custody outcome', async () => {
    const { f, handles, sender, receiver } = await setup();
    const source = f.runtime(sender);
    const target = f.runtime(receiver);
    const a = await f.client(handles, sender, source.runtime);
    const b = await f.client(handles, receiver, target.runtime);
    await a.client.open();
    const envelope = offer(sender, receiver);
    const msgId = envelope.msg_id;
    const digest = envelopeDigest(envelope);
    const path = `/v1/nodes/me/deliveries/${msgId}`;
    const asSender = nodeHeaders(sender.credentials);
    // Nothing offered yet: the center holds no custody record, so the sender gets 404 (no existence oracle).
    expect((await f.call('GET', path, undefined, asSender)).status).toBe(404);
    expect(await a.client.send(envelope, { ackTimeoutMs: 3_000 })).toBe('stored');
    // Receiver is still offline, so the sender's own query reflects the real pending custody row.
    const pending = await f.call('GET', path, undefined, asSender);
    expect(pending.status).toBe(200);
    expect(pending.body).toEqual({ msg_id: msgId, to_node: receiver.credentials.node_id, status: 'pending', digest });
    await b.client.open();
    await wait(() => expect(readCenter(f, envelope).status).toBe('received'));
    // outcome() reads the same committed center DB, so the query now reports the receipted terminal state.
    const received = await f.call('GET', path, undefined, asSender);
    expect(received.status).toBe(200);
    expect(received.body).toEqual({ msg_id: msgId, to_node: receiver.credentials.node_id, status: 'received', digest });
    // The receiver never sent this msgId: the route scopes from_node to the authenticated identity → 404.
    expect((await f.call('GET', path, undefined, nodeHeaders(receiver.credentials))).status).toBe(404);
    // An unknown msgId for the legitimate sender is also 404.
    expect((await f.call('GET', `/v1/nodes/me/deliveries/${randomUUID()}`, undefined, asSender)).status).toBe(404);
    await Promise.all([a.close(), b.close()]);
  }, 20_000);

  it('appends center schema v2+v3+v4+v5 to an actual v1 DB without rewriting v1 checksums or losing registry/auth data', async () => {
    const f = new CustodyFixture();
    const v1 = CENTER_SCHEMA.migrations[0]!;
    const store = SqliteStore.open({ ...f.options(), filename: 'center.sqlite',
      schema: { id: CENTER_SCHEMA.id, migrations: [v1] } });
    let before: string;
    let owner: Owner;
    let node: EnrollResult;
    let pendingInvite: string;
    try {
      const registry = new Registry({ storage: store });
      const auth = new AuthService({ storage: store });
      const username = 'migration-owner';
      const password = randomUUID();
      auth.register(username, password);
      const login = auth.login(username, password);
      owner = { username, password, cookie: `${SESSION_COOKIE}=${login.sessionId}`, csrf: login.csrf };
      const team = registry.createTeam({ name: 'v1-team', owner_user_id: username });
      node = registry.enroll({ token: registry.issueEnrollToken(team.team_id), pubkey: toBase64(newKeyPair().publicKey) });
      pendingInvite = registry.issueEnrollToken(team.team_id);
      before = persistedSnapshot(store); // Contains secrets: equality must only be asserted as a boolean.
      expect(store.version).toBe(1);
      expect(store.database.prepare('SELECT checksum FROM _qlong_migrations WHERE version = 1').get()?.checksum === v1.checksum).toBe(true);
      expect(store.database.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'gateway_custody'").get()?.count).toBe(0);
    } finally { store.close(); }

    const migrated = await f.start('open');
    expect(migrated.storageMode).toBe('sqlite');
    expect(migrated.auth.needsInit).toBe(false);
    await f.stop();
    // Check the migration before authenticated HTTP requests can legitimately touch last_seen.
    f.offline((storage) => {
      expect(storage.version).toBe(5);
      expect(persistedSnapshot(storage) === before).toBe(true);
      expect(storage.database.prepare('SELECT version FROM _qlong_migrations ORDER BY version').all().map((row) => row.version)).toEqual([1, 2, 3, 4, 5]);
      expect(storage.database.prepare('SELECT checksum FROM _qlong_migrations WHERE version = 1').get()?.checksum === v1.checksum).toBe(true);
      expect(storage.database.prepare('SELECT count(*) AS count FROM gateway_custody').get()?.count).toBe(0);
      // v3 claim 双表追加为空(不触碰既有数据);迁移仅追加,绝不重写 v1/v2。
      expect(storage.database.prepare('SELECT count(*) AS count FROM gateway_claim').get()?.count).toBe(0);
      expect(storage.database.prepare('SELECT count(*) AS count FROM gateway_claim_seq').get()?.count).toBe(0);
      // v4 owner 命令表追加为空(E3a);迁移仅追加,绝不重写 v1/v2/v3。
      expect(storage.database.prepare('SELECT count(*) AS count FROM registry_commands').get()?.count).toBe(0);
      // v5 数据导入账本追加为空(F1/P2 slice2);迁移仅追加,绝不重写 v1–v4。
      expect(storage.database.prepare('SELECT count(*) AS count FROM import_ledger').get()?.count).toBe(0);
    });
    await f.start('open');
    const me = await f.call<{ csrf: string }>('GET', '/v1/auth/me', undefined, ownerHeaders(owner));
    expect(me.status).toBe(200);
    expect(me.body.csrf === owner.csrf).toBe(true);
    expect((await f.teams(owner)).length).toBe(1);
    expect((await f.call('GET', '/v1/nodes/me', undefined, nodeHeaders(node))).status).toBe(200);
    expect((await f.call('POST', `/v1/teams/${node.team_id}/enroll-tokens`, {}, ownerHeaders(owner))).status).toBe(200);
    expect((await f.call('POST', '/v1/enroll', { token: pendingInvite, pubkey: toBase64(newKeyPair().publicKey) })).status).toBe(200);
    expect((await f.call('POST', '/v1/auth/register', { username: 'must-not-bootstrap', password: randomUUID() })).status).toBe(403);
  }, 20_000);
});

describe('startQlongServer v2 lead projection through the node default HTTP sink (B1e)', () => {
  // B1 全链收尾:真实 createDurableNode 作牵头方,使用默认 HTTP 上报汇(不注入 taskReportSink),
  // 经真实网关与中心把整条生命周期投影到 POST /v1/teams/:id/tasks。覆盖 b1d 默认汇此前无测试的缺口。
  it('projects a led task lifecycle (offered→running→done) to the real center via the default report sink', async () => {
    const { f, handles, owner, teamId, sender, receiver } = await setup();
    const leadNode = await createDurableNode({
      registryUrl: `http://127.0.0.1:${handles.registryPort}`,
      gatewayUrl: `ws://127.0.0.1:${handles.registryPort}${handles.gatewayPath}`,
      nodeToken: sender.credentials.node_token,
      privKey: sender.pair.priv,
      storage: {
        allowedBase: f.root, dataDir: sender.dataDir, mode: 'create', filename: 'node.sqlite',
        localFilesystemConfirmed: true, windowsAclConfirmed: true, busyTimeoutMs: 25,
      },
      validateAcceptance: () => true,
      reportIntervalMs: 0,
      tickIntervalMs: 50,
      shutdownFlushMs: 2_000,
    });
    try {
      await leadNode.start();
      const path = `/v1/teams/${teamId}/tasks`;
      const taskId = newId();
      const readTask = async (): Promise<TaskRecord> =>
        (await f.call<TaskRecord>('GET', `${path}/${taskId}`, undefined, ownerHeaders(owner))).body;
      const receipt = (type: string, body: Record<string, unknown>): EnvelopeV1 => signEnvelope({
        v: 1, type, msg_id: newId(), task_id: taskId, attempt: 1, hops: 0,
        ts: new Date().toISOString(), exp: new Date(Date.now() + 120_000).toISOString(),
        from: { node_id: receiver.credentials.node_id, team_id: receiver.credentials.team_id, key_epoch: receiver.credentials.key_epoch },
        to: { node_id: sender.credentials.node_id, team_id: sender.credentials.team_id },
        trace: { trace_id: newId(), parent_span: null, origin_node: receiver.credentials.node_id },
        body,
      }, receiver.pair.priv);

      // 牵头方发起并派发;泵经默认汇把 'offered' 修订 POST 到真实中心。
      expect(leadNode.lead.originate(taskId, 'project')).toBe(true);
      expect(leadNode.lead.dispatch(taskId, receiver.credentials.node_id, {
        kind: 'project', summary: 'led end-to-end', offer_ttl_ms: 60_000, lease_ms: 60_000,
      })).toBe(true);
      await expect.poll(async () => (await readTask()).status, { timeout: 4_000, interval: 20 }).toBe('offered');
      expect(await readTask()).toMatchObject({
        task_id: taskId, type: 'project', team_id: teamId, lead: sender.credentials.node_id,
        exec: receiver.credentials.node_id, attempt: 1, status: 'offered', task_seq: 1,
      });

      // 执行方(真实签名)经真实网关回执 accept;牵头方消费后投影单调递增的 'running' 修订。
      const exec = await f.rawSender(handles, receiver);
      await exec.send(receipt('task.accept', { lease_ms: 60_000 }), 'stored');
      await expect.poll(async () => (await readTask()).status, { timeout: 4_000, interval: 20 }).toBe('running');
      expect(await readTask()).toMatchObject({ status: 'running', task_seq: 2, attempt: 1 });

      // 执行方回传 result;牵头方验收通过投影终态 'done',中心按 task_seq 单调见到全部修订。
      await exec.send(receipt('task.result', { summary: 'delivered' }), 'stored');
      await expect.poll(async () => (await readTask()).status, { timeout: 4_000, interval: 20 }).toBe('done');
      expect(await readTask()).toMatchObject({ status: 'done', task_seq: 3, attempt: 1 });
      await exec.close();
    } finally {
      await leadNode.stop().catch(() => { /* 已故障/已停的 stop 在部分断言失败路径下属预期 */ });
    }
  }, 20_000);
});

describe('startQlongServer D1c: durable cross-process claim registry (center schema v3)', () => {
  // d1c-3:中心装配 SqliteClaimStore(共享 storage,authorityId 缺省 'gw1')。价值判别器——generation
  // 高水位持久于 gateway_claim_seq,跨中心重启单调递增;若退回内存 LocalClaimRegistry,重启后归 1(RED)。
  it('lands the claim tables and keeps the generation high-water monotonic across a center restart', async () => {
    const f = new CustodyFixture();
    await f.start('create', { seedTeam: { name: 'claim-team' } });
    expect(claimTablesExist(f)).toBe(true); // v3 迁移:gateway_claim + gateway_claim_seq 随中心 schema 落地
    const owner = await f.register();
    const teamId = (await f.teams(owner))[0]!.team_id;
    const node = await f.enroll(await f.invite(owner, teamId));

    // 连接 → 网关经 SqliteClaimStore 认领 gen1(authorityId 缺省 'gw1');持久表被写。
    const first = await f.connect(node.node_token);
    expect(first.authenticated).toBe(true);
    await wait(() => expect(readClaim(f, node.node_id).seq).toBe(1));
    expect(readClaim(f, node.node_id).active).toMatchObject({ authorityId: 'gw1', generation: 1 });

    // 断连:release 删活跃行(在线只读视图确认已提交),但 seq 高水位保留。
    first.close();
    await first.waitClosed();
    await wait(() => expect(readClaim(f, node.node_id).active).toBeUndefined());
    expect(readClaim(f, node.node_id).seq).toBe(1);

    await f.stop();
    f.offline((storage) => {
      expect(storage.version).toBe(5); // 全量 CENTER_SCHEMA 迁移已应用(至 v5)
      // seq 高水位跨停机持久(fencing token 绝不复用);活跃行已随 release 清空。
      expect(storage.database.prepare('SELECT last_generation FROM gateway_claim_seq WHERE node_id = ?')
        .get(node.node_id)?.last_generation).toBe(1);
      expect(storage.database.prepare('SELECT count(*) AS n FROM gateway_claim').get()?.n).toBe(0);
    });

    // 重启(open)+ 重连:同一节点认领得 gen2(跨重启单调;内存 LocalClaimRegistry 会重置为 1)。
    await f.start('open');
    const second = await f.connect(node.node_token);
    expect(second.authenticated).toBe(true);
    await wait(() => expect(readClaim(f, node.node_id).seq).toBe(2));
    expect(readClaim(f, node.node_id).active).toMatchObject({ authorityId: 'gw1', generation: 2 });
    second.close();
    await second.waitClosed();
  }, 20_000);
});
describe('startQlongServer D1d: custody pump relay (single-port /internal/pump)', () => {
  // 单端口形态的 custody 集群中继:registry http 承载同名路由,fence 守卫在 gw.pumpNotify 内部
  // (有连接时的 delivered 泵路径由 gateway 级 custody-relay.spec 端到端覆盖)。
  it('exposes the fenced pump route behind the relay secret', async () => {
    const f = new CustodyFixture();
    const handles = await f.start('create', { seedTeam: { name: 'relay-team' }, relaySecret: 'test-relay-secret' });
    const base = `http://127.0.0.1:${handles.registryPort}`;
    const post = (secret?: string, body: unknown = { to_node_id: randomUUID(), generation: 1 }): Promise<Response> =>
      fetch(`${base}/internal/pump`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(secret ? { 'x-qlong-relay-secret': secret } : {}) },
        body: JSON.stringify(body),
      });
    expect((await post('wrong')).status).toBe(403);
    expect((await post(undefined)).status).toBe(403);
    expect((await post('test-relay-secret', {})).status).toBe(400);
    expect((await post('test-relay-secret', { to_node_id: 'not-a-uuid', generation: 1 })).status).toBe(400);
    const ok = await post('test-relay-secret');
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { pumped: boolean }).pumped).toBe(false); // 无 claim → 非现主
    await f.stop();
  });

  it('refuses relay configuration without durable storage and legacy cluster config with storage', async () => {
    const f = new CustodyFixture();
    await expect(f.launch({
      host: '127.0.0.1', registryPort: 0, gatewayPath: '/gateway', seedTeam: false,
      ephemeral: true, relaySecret: 'x',
    })).rejects.toThrow(/requires durable storage/i);
    await expect(f.start('create', { relayPeers: ['http://127.0.0.1:1'] }))
      .rejects.toThrow(/relayPeers requires relaySecret/i);
    await expect(f.start('create', { relaySecret: 'x', clusterSecret: 'y' }))
      .rejects.toThrow(/legacy cluster routing/i);
  });
});

describe('startQlongServer E3d: owner command channel end-to-end (owner to center to lead PULL to projection)', () => {
  // E3 全链收尾:真实 owner 会话经授权 API 下 cancel 命令 → 中心持久命令队列 → 真实牵头节点 commandTimer
  // PULL → lead.cancel 单任务事务 → task.report 投影 'cancelling' 回报中心 + 命令 ack。覆盖 e3a(owner 路由)
  // 与 e3c(节点 PULL)之间此前无端到端测试的组成缺口。变异靶点(§6):移除节点 PULL → 投影永停 'running'(RED)。
  it('applies an owner cancel to a running led task, projects cancelling back, and acks the command', async () => {
    const { f, handles, owner, teamId, sender, receiver } = await setup();
    const leadNode = await createDurableNode({
      registryUrl: `http://127.0.0.1:${handles.registryPort}`,
      gatewayUrl: `ws://127.0.0.1:${handles.registryPort}${handles.gatewayPath}`,
      nodeToken: sender.credentials.node_token,
      privKey: sender.pair.priv,
      storage: {
        allowedBase: f.root, dataDir: sender.dataDir, mode: 'create', filename: 'node.sqlite',
        localFilesystemConfirmed: true, windowsAclConfirmed: true, busyTimeoutMs: 25,
      },
      validateAcceptance: () => true,
      reportIntervalMs: 0,
      tickIntervalMs: 50,
      commandIntervalMs: 30, // E3d:命令泵活跃,周期 PULL 中心 owner 命令
      shutdownFlushMs: 2_000,
    });
    try {
      await leadNode.start();
      const path = `/v1/teams/${teamId}/tasks`;
      const taskId = newId();
      const readTask = async (): Promise<TaskRecord> =>
        (await f.call<TaskRecord>('GET', `${path}/${taskId}`, undefined, ownerHeaders(owner))).body;
      const receipt = (type: string, body: Record<string, unknown>): EnvelopeV1 => signEnvelope({
        v: 1, type, msg_id: newId(), task_id: taskId, attempt: 1, hops: 0,
        ts: new Date().toISOString(), exp: new Date(Date.now() + 120_000).toISOString(),
        from: { node_id: receiver.credentials.node_id, team_id: receiver.credentials.team_id, key_epoch: receiver.credentials.key_epoch },
        to: { node_id: sender.credentials.node_id, team_id: sender.credentials.team_id },
        trace: { trace_id: newId(), parent_span: null, origin_node: receiver.credentials.node_id },
        body,
      }, receiver.pair.priv);

      // 牵头方发起并派发;执行方(真实签名)经真实网关回执 accept → 投影单调到 'running'。
      expect(leadNode.lead.originate(taskId, 'project')).toBe(true);
      expect(leadNode.lead.dispatch(taskId, receiver.credentials.node_id, {
        kind: 'project', summary: 'owner-cancel e2e', offer_ttl_ms: 60_000, lease_ms: 60_000,
      })).toBe(true);
      await expect.poll(async () => (await readTask()).status, { timeout: 4_000, interval: 20 }).toBe('offered');
      const exec = await f.rawSender(handles, receiver);
      await exec.send(receipt('task.accept', { lease_ms: 60_000 }), 'stored');
      await expect.poll(async () => (await readTask()).status, { timeout: 4_000, interval: 20 }).toBe('running');

      // owner 经授权 API(会话 Cookie + CSRF)下 cancel → 202 受理;此刻中心投影仍 'running'(投影只读,§1.4)。
      const cmd = await f.call<{ command_id: string; kind: string; task_id: string; lead: string }>(
        'POST', `${path}/${taskId}/cancel`, undefined, ownerHeaders(owner));
      expect(cmd.status).toBe(202);
      expect(cmd.body).toMatchObject({ kind: 'cancel', task_id: taskId, lead: sender.credentials.node_id });

      // 牵头节点命令泵 PULL → lead.cancel(单任务 CAS 事务)→ 投影 'cancelling' 回报中心;命令 ack(pending 清零)。
      await expect.poll(async () => (await readTask()).status, { timeout: 4_000, interval: 20 }).toBe('cancelling');
      await wait(() => expect(readCommands(f, sender.credentials.node_id)).toMatchObject({ pending: 0, acked: 1 }));
      await exec.close();
    } finally {
      await leadNode.stop().catch(() => { /* 已故障/已停的 stop 在部分断言失败路径下属预期 */ });
    }
  }, 20_000);
});
