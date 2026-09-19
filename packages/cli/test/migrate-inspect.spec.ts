import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  envelopeDigest, jcs, newId, newKeyPair, signEnvelope, toBase64,
  type Bytes, type EnvelopeV1,
} from '@qlong/core';
import {
  inspectMigration,
  type FileSource, type Inventory, type MigrationSources, type TargetNode, type TargetSnapshot,
} from '../src/migrate/inspect.js';

/* slice1 RED — qlong migrate inspect: dry-run 只读盘点纯函数 inspectMigration。
 * 覆盖 DATA-MIGRATION §4 分类矩阵 + §5 slice1 测试靶点:
 * malformed/NUL/非数组、坏 salt/hash/ISO、非规范 ISO、重复 ID 异体、目标冲突/已存在、
 * 缺 marker、缺 pubkey/inactive/纪元不符→blocked、坏签名→invalid、过期/超寿命→non_migratable、
 * 不输出凭据(salt/hash 绝不出现在 Inventory 任何字段)。 */

const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const TEAM = newId();
const SALT = 'a'.repeat(32); // 32 hex
const HASH = 'b'.repeat(128); // 128 hex scrypt
const ISO = '2025-12-01T00:00:00.000Z'; // canonical

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const userDigest = (u: { username: string; role: string; created_at: string }): string =>
  createHash('sha256').update(jcs({ username: u.username, role: u.role, created_at: u.created_at }), 'utf8').digest('hex');

function mkUser(o: { username?: string; role?: string; salt?: string; hash?: string; created_at?: string; noRole?: boolean } = {}): Record<string, unknown> {
  const u: Record<string, unknown> = {
    username: o.username ?? 'alice', role: o.role ?? 'user',
    salt: o.salt ?? SALT, hash: o.hash ?? HASH, created_at: o.created_at ?? ISO,
  };
  if (o.noRole) delete u.role;
  return u;
}
const usersFile = (records: unknown[], path = '/auth/users.json'): FileSource => ({ path, bytes: enc(JSON.stringify(records)) });

function emptyTarget(o: Partial<TargetSnapshot> = {}): TargetSnapshot {
  return { path: '/center.sqlite', schemaId: 'qlong.center', version: 4, initialized: false, users: [], custody: [], nodes: [], ...o };
}

function keypairNode(status: 'active' | 'suspended' | 'revoked' = 'active'): { pair: ReturnType<typeof newKeyPair>; node: TargetNode } {
  const pair = newKeyPair();
  const node: TargetNode = { node_id: newId(), team_id: TEAM, status, keys: [{ epoch: 1, pubkey: toBase64(pair.publicKey) }] };
  return { pair, node };
}

function signedOffer(from: { node_id: string; key_epoch: number }, priv: Bytes, o: { expMs?: number; msgId?: string; to?: string } = {}): EnvelopeV1 {
  return signEnvelope({
    v: 1, type: 'task.offer', msg_id: o.msgId ?? newId(), task_id: newId(), attempt: 1, hops: 0,
    ts: new Date(NOW).toISOString(), exp: new Date(o.expMs ?? NOW + 120_000).toISOString(),
    from: { node_id: from.node_id, team_id: TEAM, key_epoch: from.key_epoch },
    to: { node_id: o.to ?? newId(), team_id: TEAM },
    trace: { trace_id: newId(), parent_span: null, origin_node: from.node_id },
    body: { kind: 'project', summary: 'migration fixture' },
  }, priv);
}

type Box = { nodeId: string; entries: Array<{ msgId: string; envelope: unknown; enqueuedAt: number }> };
const boxOf = (env: EnvelopeV1): Box => ({ nodeId: env.to.node_id, entries: [{ msgId: env.msg_id, envelope: env, enqueuedAt: NOW }] });
const mailboxFile = (boxes: Box[], path = '/mailbox.json'): FileSource => ({ path, bytes: enc(JSON.stringify({ v: 1, savedAt: NOW, boxes })) });

describe('inspectMigration — users.json', () => {
  it('classifies a role-less legacy admin as migratable global_owner with a non-credential digest', async () => {
    const inv = await inspectMigration({ usersJson: usersFile([mkUser({ username: 'owner', noRole: true })]) }, emptyTarget(), NOW);
    expect(inv.users.records[0]).toMatchObject({ username: 'owner', role: 'global_owner', class: 'migratable', reason: 'ok' });
    expect(inv.users.records[0]!.digest).toBe(userDigest({ username: 'owner', role: 'global_owner', created_at: ISO }));
    expect(inv.users.counts.migratable).toBe(1);
  });

  it('classifies a valid user record as migratable', async () => {
    const inv = await inspectMigration({ usersJson: usersFile([mkUser({ username: 'bob', role: 'user' })]) }, emptyTarget(), NOW);
    expect(inv.users.records[0]).toMatchObject({ username: 'bob', role: 'user', class: 'migratable', reason: 'ok' });
  });

  it('rejects malformed users.json as a file-level invalid without enumerating records', async () => {
    const inv = await inspectMigration({ usersJson: { path: '/auth/users.json', bytes: enc('{not json') } }, emptyTarget(), NOW);
    expect(inv.users.fileError).toMatchObject({ class: 'invalid', reason: 'malformed_json' });
    expect(inv.users.records).toEqual([]);
  });

  it('rejects a NUL byte in users.json as invalid', async () => {
    const json = JSON.stringify([mkUser({ username: 'bob' })]);
    const withNul = enc(json.slice(0, 5) + '\u0000' + json.slice(5));
    const inv = await inspectMigration({ usersJson: { path: '/auth/users.json', bytes: withNul } }, emptyTarget(), NOW);
    expect(inv.users.fileError).toMatchObject({ class: 'invalid', reason: 'malformed_json' });
  });

  it('rejects users.json that is not an array as invalid', async () => {
    const inv = await inspectMigration({ usersJson: { path: '/auth/users.json', bytes: enc(JSON.stringify(mkUser())) } }, emptyTarget(), NOW);
    expect(inv.users.fileError).toMatchObject({ class: 'invalid', reason: 'not_an_array' });
  });

  it('rejects a bad salt regex as invalid', async () => {
    const inv = await inspectMigration({ usersJson: usersFile([mkUser({ username: 'bob', salt: 'a'.repeat(31) })]) }, emptyTarget(), NOW);
    expect(inv.users.records[0]).toMatchObject({ class: 'invalid', reason: 'bad_salt' });
  });

  it('rejects a bad hash regex as invalid', async () => {
    const inv = await inspectMigration({ usersJson: usersFile([mkUser({ username: 'bob', hash: 'b'.repeat(127) })]) }, emptyTarget(), NOW);
    expect(inv.users.records[0]).toMatchObject({ class: 'invalid', reason: 'bad_hash' });
  });

  it('rejects a non-finite created_at as invalid', async () => {
    const inv = await inspectMigration({ usersJson: usersFile([mkUser({ username: 'bob', created_at: 'not-a-date' })]) }, emptyTarget(), NOW);
    expect(inv.users.records[0]).toMatchObject({ class: 'invalid', reason: 'bad_created_at' });
  });

  it('rejects a non-canonical created_at as invalid (target readSnapshot invariant)', async () => {
    const inv = await inspectMigration({ usersJson: usersFile([mkUser({ username: 'bob', created_at: '2025-12-01T00:00:00Z' })]) }, emptyTarget(), NOW);
    expect(inv.users.records[0]).toMatchObject({ class: 'invalid', reason: 'non_canonical_created_at' });
  });

  it('rejects a too-short username as invalid', async () => {
    const inv = await inspectMigration({ usersJson: usersFile([mkUser({ username: 'ab' })]) }, emptyTarget(), NOW);
    expect(inv.users.records[0]).toMatchObject({ class: 'invalid', reason: 'bad_username' });
  });

  it('flags duplicate username variants as invalid (first wins)', async () => {
    const inv = await inspectMigration(
      { usersJson: usersFile([mkUser({ username: 'bob', hash: HASH }), mkUser({ username: 'bob', hash: 'c'.repeat(128) })]) },
      emptyTarget(), NOW,
    );
    expect(inv.users.records[0]).toMatchObject({ username: 'bob', class: 'migratable' });
    expect(inv.users.records[1]).toMatchObject({ username: 'bob', class: 'invalid', reason: 'duplicate_username' });
  });

  it('marks a username already in target with identical content as migratable already_present', async () => {
    const target = emptyTarget({ initialized: true, users: [{ username: 'bob', role: 'user', created_at: ISO, salt: SALT, hash: HASH }] });
    const inv = await inspectMigration({ usersJson: usersFile([mkUser({ username: 'bob', role: 'user' })]) }, target, NOW);
    expect(inv.users.records[0]).toMatchObject({ class: 'migratable', reason: 'already_present' });
  });

  it('marks a username already in target with different content as conflict', async () => {
    const target = emptyTarget({ initialized: true, users: [{ username: 'bob', role: 'user', created_at: ISO, salt: SALT, hash: 'f'.repeat(128) }] });
    const inv = await inspectMigration({ usersJson: usersFile([mkUser({ username: 'bob', role: 'user' })]) }, target, NOW);
    expect(inv.users.records[0]).toMatchObject({ class: 'conflict', reason: 'target_conflict' });
  });
});

describe('inspectMigration — initialized marker', () => {
  it('reports a valid marker as present and valid, listed in sources', async () => {
    const inv = await inspectMigration({ initializedMarker: { path: '/auth/initialized', bytes: enc('initialized-v1\n') } }, emptyTarget(), NOW);
    expect(inv.initialized).toMatchObject({ present: true, valid: true });
    expect(inv.sources.some((s) => s.kind === 'initialized')).toBe(true);
  });

  it('reports an absent marker as not present', async () => {
    const inv = await inspectMigration({}, emptyTarget(), NOW);
    expect(inv.initialized).toMatchObject({ present: false, valid: false });
  });

  it('reports a wrong-content marker as present but invalid', async () => {
    const inv = await inspectMigration({ initializedMarker: { path: '/auth/initialized', bytes: enc('nope') } }, emptyTarget(), NOW);
    expect(inv.initialized).toMatchObject({ present: true, valid: false });
  });
});

describe('inspectMigration — mailbox', () => {
  it('classifies a valid signed, unexpired, resolvable envelope as migratable with envelopeDigest', async () => {
    const { pair, node } = keypairNode();
    const env = signedOffer({ node_id: node.node_id, key_epoch: 1 }, pair.priv);
    const inv = await inspectMigration({ mailbox: mailboxFile([boxOf(env)]) }, emptyTarget({ nodes: [node] }), NOW);
    expect(inv.mailbox.entries[0]).toMatchObject({ from_node: node.node_id, msg_id: env.msg_id, class: 'migratable', reason: 'ok', digest: envelopeDigest(env) });
    expect(inv.mailbox.counts.migratable).toBe(1);
  });

  it('rejects malformed mailbox JSON as a file-level invalid', async () => {
    const inv = await inspectMigration({ mailbox: { path: '/mailbox.json', bytes: enc('{oops') } }, emptyTarget(), NOW);
    expect(inv.mailbox.fileError).toMatchObject({ class: 'invalid', reason: 'malformed_json' });
  });

  it('rejects mailbox v≠1 as invalid', async () => {
    const inv = await inspectMigration({ mailbox: { path: '/mailbox.json', bytes: enc(JSON.stringify({ v: 2, savedAt: NOW, boxes: [] })) } }, emptyTarget(), NOW);
    expect(inv.mailbox.fileError).toMatchObject({ class: 'invalid', reason: 'bad_version' });
  });

  it('rejects an envelope failing validateEnvelope as invalid', async () => {
    const { pair, node } = keypairNode();
    const env = signedOffer({ node_id: node.node_id, key_epoch: 1 }, pair.priv);
    const bad = { ...env, msg_id: 'not-a-uuid' };
    const box: Box = { nodeId: env.to.node_id, entries: [{ msgId: 'not-a-uuid', envelope: bad, enqueuedAt: NOW }] };
    const inv = await inspectMigration({ mailbox: mailboxFile([box]) }, emptyTarget({ nodes: [node] }), NOW);
    expect(inv.mailbox.entries[0]).toMatchObject({ class: 'invalid', reason: 'invalid_envelope' });
  });

  it('blocks an envelope whose signer node is unknown', async () => {
    const { pair, node } = keypairNode();
    const env = signedOffer({ node_id: node.node_id, key_epoch: 1 }, pair.priv);
    const inv = await inspectMigration({ mailbox: mailboxFile([boxOf(env)]) }, emptyTarget({ nodes: [] }), NOW);
    expect(inv.mailbox.entries[0]).toMatchObject({ class: 'blocked', reason: 'node_unknown' });
  });

  it('blocks an envelope whose signer node is inactive (revoked)', async () => {
    const { pair, node } = keypairNode('revoked');
    const env = signedOffer({ node_id: node.node_id, key_epoch: 1 }, pair.priv);
    const inv = await inspectMigration({ mailbox: mailboxFile([boxOf(env)]) }, emptyTarget({ nodes: [node] }), NOW);
    expect(inv.mailbox.entries[0]).toMatchObject({ class: 'blocked', reason: 'node_inactive' });
  });

  it('blocks an envelope whose signer key epoch is unknown', async () => {
    const { pair, node } = keypairNode();
    const env = signedOffer({ node_id: node.node_id, key_epoch: 2 }, pair.priv);
    const inv = await inspectMigration({ mailbox: mailboxFile([boxOf(env)]) }, emptyTarget({ nodes: [node] }), NOW);
    expect(inv.mailbox.entries[0]).toMatchObject({ class: 'blocked', reason: 'unknown_epoch' });
  });

  it('rejects an envelope whose signature does not verify as invalid (bad_sig)', async () => {
    const { node } = keypairNode(); // registered key A
    const pairB = newKeyPair(); // signed with key B
    const env = signedOffer({ node_id: node.node_id, key_epoch: 1 }, pairB.priv);
    const inv = await inspectMigration({ mailbox: mailboxFile([boxOf(env)]) }, emptyTarget({ nodes: [node] }), NOW);
    expect(inv.mailbox.entries[0]).toMatchObject({ class: 'invalid', reason: 'bad_sig' });
  });

  it('classifies an expired envelope as non_migratable', async () => {
    const { pair, node } = keypairNode();
    const env = signedOffer({ node_id: node.node_id, key_epoch: 1 }, pair.priv, { expMs: NOW - 1_000 });
    const inv = await inspectMigration({ mailbox: mailboxFile([boxOf(env)]) }, emptyTarget({ nodes: [node] }), NOW);
    expect(inv.mailbox.entries[0]).toMatchObject({ class: 'non_migratable', reason: 'expired' });
  });

  it('classifies an envelope with exp beyond the 24h lifetime as non_migratable', async () => {
    const { pair, node } = keypairNode();
    const env = signedOffer({ node_id: node.node_id, key_epoch: 1 }, pair.priv, { expMs: NOW + 25 * 3_600_000 });
    const inv = await inspectMigration({ mailbox: mailboxFile([boxOf(env)]) }, emptyTarget({ nodes: [node] }), NOW);
    expect(inv.mailbox.entries[0]).toMatchObject({ class: 'non_migratable', reason: 'lifetime_exceeded' });
  });

  it('marks an envelope already in target with the same digest as migratable already_present', async () => {
    const { pair, node } = keypairNode();
    const env = signedOffer({ node_id: node.node_id, key_epoch: 1 }, pair.priv);
    const target = emptyTarget({ nodes: [node], custody: [{ from_node: env.from.node_id, msg_id: env.msg_id, digest: envelopeDigest(env) }] });
    const inv = await inspectMigration({ mailbox: mailboxFile([boxOf(env)]) }, target, NOW);
    expect(inv.mailbox.entries[0]).toMatchObject({ class: 'migratable', reason: 'already_present' });
  });

  it('marks an envelope already in target with a different digest as conflict', async () => {
    const { pair, node } = keypairNode();
    const env = signedOffer({ node_id: node.node_id, key_epoch: 1 }, pair.priv);
    const target = emptyTarget({ nodes: [node], custody: [{ from_node: env.from.node_id, msg_id: env.msg_id, digest: 'f'.repeat(64) }] });
    const inv = await inspectMigration({ mailbox: mailboxFile([boxOf(env)]) }, target, NOW);
    expect(inv.mailbox.entries[0]).toMatchObject({ class: 'conflict', reason: 'target_conflict' });
  });

  it('flags duplicate msg_id variants within the mailbox as invalid (first wins)', async () => {
    const { pair, node } = keypairNode();
    const env = signedOffer({ node_id: node.node_id, key_epoch: 1 }, pair.priv);
    const env2 = signedOffer({ node_id: node.node_id, key_epoch: 1 }, pair.priv, { msgId: env.msg_id, expMs: NOW + 60_000 });
    const box: Box = { nodeId: env.to.node_id, entries: [{ msgId: env.msg_id, envelope: env, enqueuedAt: NOW }, { msgId: env.msg_id, envelope: env2, enqueuedAt: NOW }] };
    const inv = await inspectMigration({ mailbox: mailboxFile([box]) }, emptyTarget({ nodes: [node] }), NOW);
    expect(inv.mailbox.entries[0]).toMatchObject({ class: 'migratable' });
    expect(inv.mailbox.entries[1]).toMatchObject({ class: 'invalid', reason: 'duplicate_msg' });
  });
});

describe('inspectMigration — safety invariants', () => {
  it('never emits salt or hash values anywhere in the inventory', async () => {
    const { pair, node } = keypairNode();
    const env = signedOffer({ node_id: node.node_id, key_epoch: 1 }, pair.priv);
    const inv: Inventory = await inspectMigration(
      { usersJson: usersFile([mkUser({ username: 'carol', salt: SALT, hash: HASH })]), mailbox: mailboxFile([boxOf(env)]) },
      emptyTarget({ nodes: [node] }), NOW,
    );
    const json = JSON.stringify(inv);
    expect(json).not.toContain(SALT);
    expect(json).not.toContain(HASH);
  });

  it('reports empty sections when all sources are absent', async () => {
    const inv = await inspectMigration({}, emptyTarget(), NOW);
    expect(inv.users.records).toEqual([]);
    expect(inv.mailbox.entries).toEqual([]);
    expect(inv.sources).toEqual([]);
    expect(inv.users.counts.migratable).toBe(0);
  });
});
