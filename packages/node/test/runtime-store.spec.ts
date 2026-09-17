import { describe, expect, it, vi } from 'vitest';
import { envelopeDigest, jcs, MAX_TRANSPORT_BYTES, newId } from '@qlong/core';
import type { OutboxStore } from '../src/outbox.js';
import { NODE_SCHEMA } from '../src/runtime/schema.js';
import { NodeRuntimeStore, type RuntimeTransform } from '../src/runtime/store.js';
import {
  env, expectCorrupt, failCommit, fixture, LOCAL, open, OTHER, rawDatabase, request, SENDER, transition,
} from './runtime-store-helpers.js';

describe('NodeRuntimeStore custody', () => {
  it('uses the v2 node schema and pins the local identity across restart', () => {
    const { options, store, runtime } = fixture();
    expect(NODE_SCHEMA.id).toBe('qlong.node');
    expect(store.version).toBe(2);
    expect(runtime.usage()).toEqual({ entries: 0, bytes: 0 });
    expect(() => new NodeRuntimeStore(store, OTHER)).toThrow('another node');
    store.close();
    const reopened = open({ ...options, mode: 'open' });
    expect(() => new NodeRuntimeStore(reopened, OTHER)).toThrow('another node');
    expect(new NodeRuntimeStore(reopened, LOCAL).all()).toEqual([]);
  });

  it('is structurally an OutboxStore but permits only matching verified custody release', () => {
    const { runtime } = fixture();
    const outbox: OutboxStore = runtime;
    const outbound = transition().outbox![0]!;
    const entry = { envelope: outbound, attempts: 0, lastAt: 0 };
    outbox.save(entry);
    outbox.save({ ...entry, attempts: 2, lastAt: 100 });
    expect(outbox.all()).toEqual([{ ...entry, attempts: 2, lastAt: 100 }]);
    expect(() => outbox.remove(outbound.msg_id)).toThrow(expect.objectContaining({ code: 'UNVERIFIED_CUSTODY' }));
    expect(runtime.stored(SENDER, outbound.msg_id, envelopeDigest(outbound))).toBe(false);
    expect(runtime.stored(LOCAL, outbound.msg_id, '0'.repeat(64))).toBe(false);
    expect(runtime.stored(LOCAL, newId(), envelopeDigest(outbound))).toBe(false);
    expect(runtime.stored(LOCAL, outbound.msg_id, 'bad')).toBe(false);
    expect(outbox.all()).toHaveLength(1);
    expect(runtime.stored(LOCAL, outbound.msg_id, envelopeDigest(outbound))).toBe(true);
    expect(runtime.stored(LOCAL, outbound.msg_id, envelopeDigest(outbound))).toBe(true);
    expect(outbox.all()).toEqual([]);
    outbox.save(entry);
    expect(outbox.all()).toEqual([]); // No resurrection after custody transfer.
    expect(runtime.usage().entries).toBe(1); // Delivery tombstone retained.
    expect(() => outbox.save({ ...entry, envelope: { ...outbound, body: { changed: true } } }))
      .toThrow(expect.objectContaining({ code: 'CONFLICT' }));
  });

  it('refuses outbound identity changes and nonlocal/unsigned senders without partial tracking rows', () => {
    const { runtime } = fixture();
    const outbound = transition().outbox![0]!;
    runtime.save({ envelope: outbound, attempts: 0, lastAt: 0 });
    expect(() => runtime.save({ envelope: { ...outbound, to: { node_id: OTHER } }, attempts: 0, lastAt: 0 }))
      .toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(() => runtime.save({ envelope: env(), attempts: 0, lastAt: 0 })).toThrow('local node');
    const unsigned = { ...outbound, msg_id: newId() };
    delete unsigned.sig;
    expect(() => runtime.save({ envelope: unsigned, attempts: 0, lastAt: 0 })).toThrow();
    expect(() => runtime.save({ envelope: outbound, attempts: -1, lastAt: 0 })).toThrow();
    expect(runtime.all()[0]!.envelope).toEqual(outbound);
    expect(runtime.usage().entries).toBe(2);
  });

  it('deduplicates JCS content by sender/msg, including signature bytes, without authenticating it', () => {
    const { runtime } = fixture();
    const first = env({ body: { a: 1, b: 2 } });
    expect(runtime.receive(first)).toBe('new');
    expect(runtime.receive({ ...first, body: { b: 2, a: 1 } })).toBe('duplicate');
    expect(runtime.receive({ ...first, body: { a: 2, b: 2 } })).toBe('conflict');
    expect(runtime.receive({ ...first, sig: { alg: 'ed25519', value: Buffer.alloc(64, 1).toString('base64') } }))
      .toBe('conflict');
    const other = { ...first, from: { node_id: OTHER, key_epoch: 1 } };
    expect(runtime.receive(other)).toBe('new');
    expect(runtime.pending()).toEqual([first, other]);
    expect(runtime.pending(1)).toEqual([first]);
    expect(runtime.pending(0)).toEqual([]);
    expect(() => runtime.pending(-1)).toThrow();
  });

  it.each([
    ['wrong target', () => env({ to: { node_id: OTHER } })],
    ['wrong version', () => env({ v: 2 })],
    ['bad identity', () => env({ msg_id: 'not-a-uuid' })],
    ['missing signature', () => { const value = env(); delete value.sig; return value; }],
    ['signature format', () => env({ sig: { alg: 'ed25519', value: 'bad' } })],
    ['noncanonical base64', () => env({ sig: { alg: 'ed25519', value: Buffer.alloc(64).toString('base64') + '!' } })],
    ['noninteger body', () => env({ body: { count: 1.5 } })],
    ['lossy undefined', () => env({ body: { missing: undefined } })],
    ['nonfinite body', () => env({ body: { count: NaN } })],
    ['custom object', () => env({ body: { date: new Date() } })],
    ['cycle', () => { const value = env(); value.body.loop = value; return value; }],
    ['oversized', () => env({ body: { data: 'x'.repeat(MAX_TRANSPORT_BYTES) } })],
  ] as const)('rejects malformed envelope/target: %s', (_name, make) => {
    const { runtime } = fixture();
    expect(() => runtime.receive(make())).toThrow();
    expect(runtime.pending()).toEqual([]);
    expect(runtime.usage()).toEqual({ entries: 0, bytes: 0 });
  });

  it('rejects data accessors without invoking them', () => {
    const { runtime } = fixture();
    const getter = vi.fn(() => 1);
    const value = env();
    Object.defineProperty(value.body, 'accessor', { enumerable: true, get: getter });
    expect(() => runtime.receive(value)).toThrow('accessors');
    expect(getter).not.toHaveBeenCalled();
  });

  it('returns detached inbox/outbox snapshots and never retains caller-owned objects', () => {
    const { runtime } = fixture();
    const inbound = env();
    const original = structuredClone(inbound);
    runtime.receive(inbound);
    inbound.body.changed = true;
    runtime.pending()[0]!.body.changed = true;
    expect(runtime.pending()).toEqual([original]);
    const outbound = transition().outbox![0]!;
    const outboundCopy = structuredClone(outbound);
    runtime.save({ envelope: outbound, attempts: 0, lastAt: 0 });
    outbound.body.changed = true;
    const read = runtime.all()[0]!;
    read.envelope.body.changed = true;
    read.attempts = 99;
    expect(runtime.all()).toEqual([{ envelope: outboundCopy, attempts: 0, lastAt: 0 }]);
  });

  it('reopens pending payloads, retry metadata and retained inbound/delivery tombstones', () => {
    const { runtime, options, store } = fixture();
    const first = env();
    const second = env();
    const outbound = transition().outbox![0]!;
    const delivered = transition().outbox![0]!;
    runtime.receive(first);
    runtime.receive(second);
    runtime.consume(request(first), () => ({ state: { count: 1 } }));
    runtime.save({ envelope: outbound, attempts: 3, lastAt: 123 });
    runtime.save({ envelope: delivered, attempts: 0, lastAt: 0 });
    runtime.stored(LOCAL, delivered.msg_id, envelopeDigest(delivered));
    const usage = runtime.usage();
    store.close();
    const reopened = new NodeRuntimeStore(open({ ...options, mode: 'open' }), LOCAL);
    expect(reopened.pending()).toEqual([second]);
    expect(reopened.all()).toEqual([{ envelope: outbound, attempts: 3, lastAt: 123 }]);
    expect(reopened.receive(first)).toBe('duplicate');
    expect(reopened.receive({ ...first, body: { changed: true } })).toBe('conflict');
    reopened.save({ envelope: delivered, attempts: 0, lastAt: 0 });
    expect(reopened.stored(LOCAL, delivered.msg_id, envelopeDigest(delivered))).toBe(true);
    expect(reopened.usage()).toEqual(usage);
  });
});

describe('NodeRuntimeStore integrity', () => {
  function populated() {
    const result = fixture();
    const inbound = env();
    const output = transition();
    result.runtime.receive(inbound);
    result.runtime.consume(request(inbound), () => output);
    const pending = env();
    result.runtime.receive(pending);
    return { ...result, inbound, pending, output };
  }

  // These violate domain invariants without violating SQLite CHECK/FK constraints.
  it.each([
    ['identity UUID', "UPDATE node_identity SET node_id = 'invalid'"],
    ['missing outbound payload', 'DELETE FROM node_outbox'],
    ['stored delivery still has an outbox', "UPDATE node_delivery SET status = 'stored'"],
    ['delivery digest', "UPDATE node_delivery SET digest = replace(digest, substr(digest, 1, 1), 'g')"],
    ['inbox identity', "UPDATE node_inbox SET sender = 'invalid'"],
    ['inbox digest', "UPDATE node_inbox SET digest = replace(digest, substr(digest, 1, 1), 'g')"],
    ['tombstone ahead of state', "UPDATE node_inbox SET revision = 2 WHERE decision = 'applied'"],
    ['tombstone missing state', "UPDATE node_inbox SET state_key = 'missing' WHERE decision = 'applied'"],
    ['state JSON', "UPDATE node_state SET value = '{'"],
    ['state nonfinite JSON', "UPDATE node_state SET value = '1e999'"],
    ['state noncanonical JSON', "UPDATE node_state SET value = ' null'"],
    ['state key', "INSERT INTO node_state VALUES ('', 1, 'null')"],
    ['unsafe state revision', 'UPDATE node_state SET revision = 9007199254740992'],
    ['dedup sender', "UPDATE node_dedup SET sender = 'invalid'"],
    ['dedup digest', "UPDATE node_dedup SET digest = replace(digest, substr(digest, 1, 1), 'g')"],
    ['dedup state', "UPDATE node_dedup SET state_key = 'missing'"],
    ['dedup key JSON', "UPDATE node_dedup SET dedup_key = '{'"],
    ['dedup key shape', "UPDATE node_dedup SET dedup_key = '[]'"],
    ['effect ahead of state', 'UPDATE node_effects SET revision = 2'],
    ['done effect payload', "UPDATE node_effects SET status = 'done', payload = '1e999'"],
    ['effect kind', "UPDATE node_effects SET kind = ''"],
  ])('rejects corrupt reopen: %s', (_name, sql) => {
    const { store, options } = populated();
    rawDatabase(store, (db) => db.exec(sql));
    store.close();
    const reopened = open({ ...options, mode: 'open' });
    expectCorrupt(reopened, () => new NodeRuntimeStore(reopened, LOCAL));
  });

  // Bypass constraints only on the damage connection; constructor must independently detect them.
  it.each([
    ['foreign-key orphan outbox', 'DELETE FROM node_delivery'],
    ['foreign-key orphan effect', "UPDATE node_effects SET state_key = 'missing'"],
    ['invalid identity slot', 'UPDATE node_identity SET id = 2'],
    ['invalid delivery status', "UPDATE node_delivery SET status = 'lost'"],
    ['negative retry count', 'UPDATE node_outbox SET attempts = -1'],
    ['unsafe retry count', 'UPDATE node_outbox SET attempts = 9007199254740992'],
    ['negative retry timestamp', 'UPDATE node_outbox SET last_at = -1'],
    ['unsafe retry timestamp', 'UPDATE node_outbox SET last_at = 9007199254740992'],
    ['zero state revision', 'UPDATE node_state SET revision = 0'],
    ['zero applied revision', "UPDATE node_inbox SET revision = 0 WHERE decision = 'applied'"],
    ['pending inbox metadata', "UPDATE node_inbox SET state_key = 'task' WHERE decision = 'pending'"],
    ['invalid inbox decision', "UPDATE node_inbox SET decision = 'lost' WHERE decision = 'applied'"],
    ['zero effect revision', 'UPDATE node_effects SET revision = 0'],
    ['invalid effect status', "UPDATE node_effects SET status = 'lost'"],
  ])('faults startup on corrupt metadata: %s', (_name, sql) => {
    const { store } = populated();
    rawDatabase(store, (db) => db.exec(sql));
    expectCorrupt(store, () => new NodeRuntimeStore(store, LOCAL));
  });

  it.each([LOCAL, OTHER])('never repins a populated database after loss of node_identity: %s', (nodeId) => {
    const { store, options } = populated();
    rawDatabase(store, (db) => db.exec('DELETE FROM node_identity'));
    store.close();
    const reopened = open({ ...options, mode: 'open' });
    expectCorrupt(reopened, () => new NodeRuntimeStore(reopened, nodeId));
    expect(rawDatabase(reopened, (db) => db.prepare('SELECT count(*) AS n FROM node_identity').get()?.n)).toBe(0);
  });

  it('does not repin when the sole remaining domain row is a delivery tombstone', () => {
    const { runtime, store, options } = fixture();
    const outbound = transition().outbox![0]!;
    runtime.save({ envelope: outbound, attempts: 0, lastAt: 0 });
    runtime.stored(LOCAL, outbound.msg_id, envelopeDigest(outbound));
    rawDatabase(store, (db) => db.exec('DELETE FROM node_identity'));
    store.close();
    const reopened = open({ ...options, mode: 'open' });
    expectCorrupt(reopened, () => new NodeRuntimeStore(reopened, OTHER));
  });

  it.each(['pending', 'stored'] as const)('requires every %s outbound sender to be local', (status) => {
    const { runtime, store } = fixture();
    const outbound = transition().outbox![0]!;
    runtime.save({ envelope: outbound, attempts: 0, lastAt: 0 });
    if (status === 'stored') runtime.stored(LOCAL, outbound.msg_id, envelopeDigest(outbound));
    rawDatabase(store, (db) => {
      db.prepare('UPDATE node_delivery SET sender = ?').run(OTHER);
      db.prepare('UPDATE node_outbox SET sender = ?').run(OTHER);
      const changed = { ...outbound, from: { node_id: OTHER, key_epoch: 1 } };
      db.prepare('UPDATE node_outbox SET payload = ?').run(jcs(changed));
      db.prepare('UPDATE node_delivery SET digest = ?').run(envelopeDigest(changed));
    });
    expectCorrupt(store, () => new NodeRuntimeStore(store, LOCAL));
  });

  it.each([
    ['task UUID', ['invalid', 1, 'task.offer']],
    ['zero attempt', [LOCAL, 0, 'task.offer']],
    ['unsafe attempt', [LOCAL, Number.MAX_SAFE_INTEGER + 1, 'task.offer']],
    ['wrong family', [LOCAL, 1, 'rpc.request']],
    ['invalid type', [LOCAL, 1, 'task.Offer']],
    ['exempt progress', [LOCAL, 1, 'task.progress']],
    ['extra tuple field', [LOCAL, 1, 'task.offer', null]],
  ])('validates semantic dedup key structure: %s', (_name, parts) => {
    const { store } = populated();
    rawDatabase(store, (db) => db.prepare('UPDATE node_dedup SET dedup_key = ?').run(jcs(parts)));
    expectCorrupt(store, () => new NodeRuntimeStore(store, LOCAL));
  });

  for (const outbound of [false, true]) {
    const operations = outbound ? ['reopen', 'all', 'stored', 'save'] : ['reopen', 'pending', 'consume', 'receive'];
    describe.each(operations)(`${outbound ? 'outbox' : 'inbox'} %s validates payloads`, (operation) => {
      it.each(['JSON', 'schema', 'canonical', 'digest', 'sender', 'message', 'target', 'signature', 'oversize'])('%s corruption', (damage) => {
        const { store, runtime, options } = fixture();
        const value = outbound ? transition().outbox![0]! : env();
        const entry = { envelope: value, attempts: 0, lastAt: 0 };
        if (outbound) runtime.save(entry);
        else runtime.receive(value);
        const changed = structuredClone(value);
        if (damage === 'schema') changed.v = 2;
        if (damage === 'digest') changed.body = { changed: true };
        if (damage === 'sender') changed.from.node_id = OTHER;
        if (damage === 'message') changed.msg_id = newId();
        if (damage === 'target') changed.to.node_id = OTHER;
        if (damage === 'signature') changed.sig!.value = 'invalid';
        if (damage === 'oversize') changed.body = { large: 'x'.repeat(MAX_TRANSPORT_BYTES) };
        const payload = damage === 'JSON' ? '{' : damage === 'canonical' ? jcs(changed) + ' ' : jcs(changed);
        // Recompute most digests to isolate schema/identity checks from simple hash mismatches.
        const digest = damage === 'digest' || (outbound && damage === 'target') ? envelopeDigest(value) : envelopeDigest(changed);
        rawDatabase(store, (db) => {
          db.prepare(`UPDATE ${outbound ? 'node_outbox' : 'node_inbox'} SET payload = ?`).run(payload);
          db.prepare(`UPDATE ${outbound ? 'node_delivery' : 'node_inbox'} SET digest = ?`).run(digest);
        });
        const transform = vi.fn(() => transition());
        if (operation === 'reopen') {
          store.close();
          const reopened = open({ ...options, mode: 'open' });
          expectCorrupt(reopened, () => new NodeRuntimeStore(reopened, LOCAL));
        } else {
          expectCorrupt(store, () => {
            if (operation === 'all') return runtime.all();
            if (operation === 'stored') return runtime.stored(LOCAL, value.msg_id, digest);
            if (operation === 'save') return runtime.save(entry);
            if (operation === 'pending') return runtime.pending();
            if (operation === 'receive') return runtime.receive(value);
            return runtime.consume(request(value), transform);
          });
        }
        expect(transform).not.toHaveBeenCalled();
        rawDatabase(store, (db) => {
          expect(db.prepare(`SELECT payload FROM ${outbound ? 'node_outbox' : 'node_inbox'}`).get()?.payload).toBe(payload);
          expect(db.prepare('SELECT count(*) AS n FROM node_state').get()?.n).toBe(0);
          expect(db.prepare('SELECT count(*) AS n FROM node_effects').get()?.n).toBe(0);
          expect(db.prepare('SELECT count(*) AS n FROM node_dedup').get()?.n).toBe(0);
          if (outbound) expect(db.prepare('SELECT status FROM node_delivery').get()?.status).toBe('pending');
          else expect(db.prepare('SELECT decision FROM node_inbox').get()?.decision).toBe('pending');
        });
      });
    });
  }

  it.each(['DELETE FROM node_outbox', 'DELETE FROM node_delivery', "UPDATE node_delivery SET status = 'stored'",
    'UPDATE node_outbox SET attempts = -1', 'UPDATE node_outbox SET last_at = 9007199254740992'])(
  'all faults on outbound relation/retry metadata damage: %s', (sql) => {
    const { store, runtime } = populated();
    rawDatabase(store, (db) => db.exec(sql));
    expectCorrupt(store, () => runtime.all());
  });

  it.each(['state', 'consume', 'replay', 'effects', 'complete'] as const)('validates current state JSON before %s', (operation) => {
    const { store, runtime, inbound, pending, output } = populated();
    rawDatabase(store, (db) => db.exec("UPDATE node_state SET value = '1e999'"));
    const transform = vi.fn(() => transition());
    expectCorrupt(store, () => {
      if (operation === 'state') return runtime.state('task');
      if (operation === 'effects') return runtime.pendingEffects();
      if (operation === 'complete') return runtime.completeEffect(output.effects![0]!.id, 'task', 1);
      return runtime.consume(request(operation === 'replay' ? inbound : pending, 1), transform);
    });
    expect(transform).not.toHaveBeenCalled();
  });

  it.each(['pending', 'consume'] as const)('validates pending inbox metadata before %s', (operation) => {
    const { store, runtime, pending } = populated();
    rawDatabase(store, (db) => db.exec("UPDATE node_inbox SET revision = 0 WHERE decision = 'pending'"));
    const transform = vi.fn(() => transition());
    expectCorrupt(store, () => operation === 'pending' ? runtime.pending() : runtime.consume(request(pending, 1), transform));
    expect(transform).not.toHaveBeenCalled();
  });

  it.each(['revision = 0', 'revision = 2', 'revision = 9007199254740992', "state_key = 'missing'"])(
  'validates applied tombstone metadata before replay: %s', (assignment) => {
    const { store, runtime, inbound } = populated();
    rawDatabase(store, (db) => db.exec(`UPDATE node_inbox SET ${assignment} WHERE decision = 'applied'`));
    const transform = vi.fn(() => transition());
    expectCorrupt(store, () => runtime.consume(request(inbound), transform));
    expect(transform).not.toHaveBeenCalled();
  });

  it('validates an existing semantic dedup record before suppressing a transform', () => {
    const { store, runtime, inbound } = populated();
    const duplicate = { ...inbound, msg_id: newId() };
    runtime.receive(duplicate);
    rawDatabase(store, (db) => db.exec("UPDATE node_dedup SET digest = replace(digest, substr(digest, 1, 1), 'g')"));
    const transform = vi.fn(() => transition());
    expectCorrupt(store, () => runtime.consume(request(duplicate, 1), transform));
    expect(transform).not.toHaveBeenCalled();
    expect(rawDatabase(store, (db) => db.prepare('SELECT decision FROM node_inbox WHERE msg_id = ?').get(duplicate.msg_id)?.decision))
      .toBe('pending');
  });

  it.each(['pendingEffects', 'completeEffect'] as const)('%s validates effect payloads and revision fences', (operation) => {
    for (const assignment of ["payload = '{'", "payload = ' null'", "kind = ''", 'revision = 0', 'revision = 2', "state_key = 'missing'"]) {
      const { store, runtime, output } = populated();
      rawDatabase(store, (db) => db.exec(`UPDATE node_effects SET ${assignment}`));
      expectCorrupt(store, () => operation === 'pendingEffects' ? runtime.pendingEffects() :
        runtime.completeEffect(output.effects![0]!.id, 'task', 1));
      expect(rawDatabase(store, (db) => db.prepare('SELECT status FROM node_effects').get()?.status)).toBe('pending');
    }
  });

  it.each(['state', 'effects'] as const)('%s rejects deeply nested and lossy persisted JSON', (domain) => {
    for (const payload of ['['.repeat(65) + 'null' + ']'.repeat(65), '{"a":1,"a":2}']) {
      const { store, runtime } = populated();
      rawDatabase(store, (db) => db.prepare(domain === 'state' ? 'UPDATE node_state SET value = ?' :
        'UPDATE node_effects SET payload = ?').run(payload));
      expectCorrupt(store, () => domain === 'state' ? runtime.state('task') : runtime.pendingEffects());
    }
  });

  it.each(['all', 'pending', 'pendingEffects'] as const)('%s never publishes a partial collection before later corruption', (operation) => {
    const { store, runtime } = fixture();
    const first = env();
    runtime.receive(first);
    let table: 'node_inbox' | 'node_outbox' | 'node_effects' = 'node_inbox';
    if (operation === 'pending') runtime.receive(env());
    else {
      const output = transition();
      output.outbox!.push(transition().outbox![0]!);
      output.effects!.push(transition().effects![0]!);
      runtime.consume(request(first), () => output);
      table = operation === 'all' ? 'node_outbox' : 'node_effects';
    }
    rawDatabase(store, (db) => db.exec(`UPDATE ${table} SET payload = '{' WHERE rowid = (SELECT max(rowid) FROM ${table})`));
    expectCorrupt(store, () => runtime[operation]());
  });

  it('preserves safe-integer retry metadata across reopen', () => {
    const { store, runtime, options } = fixture();
    const entry = { envelope: transition().outbox![0]!, attempts: Number.MAX_SAFE_INTEGER, lastAt: Number.MAX_SAFE_INTEGER };
    runtime.save(entry);
    expect(runtime.all()).toEqual([entry]);
    store.close();
    const reopened = new NodeRuntimeStore(open({ ...options, mode: 'open' }), LOCAL);
    expect(reopened.all()).toEqual([entry]);
  });

  it('enforces applied revision > 0 in the unreleased v1 schema without poisoning on a rejected write', () => {
    const { store, runtime, inbound } = populated();
    expect(() => store.transaction((db) => db.exec("UPDATE node_inbox SET revision = 0 WHERE decision = 'applied'"))).toThrow();
    expect(store.state).toBe('open');
    expect(runtime.consume(request(inbound), () => { throw new Error('must not run'); })).toEqual({ status: 'applied', revision: 1 });
  });

  it('permits current state ahead of retained tombstones/effects and preserves lifetime quota semantics', () => {
    const { store, runtime, options, pending, inbound } = populated();
    runtime.consume(request(pending, 1), () => ({ state: { count: 2 } }));
    store.close();
    const reopened = new NodeRuntimeStore(open({ ...options, mode: 'open' }), LOCAL, { maxEntries: 0, maxBytes: 0 });
    expect(reopened.consume(request(inbound), () => { throw new Error('must not run'); })).toEqual({ status: 'applied', revision: 1 });
    expect(reopened.pendingEffects(1)).toEqual([]);
    expect(reopened.usage().entries).toBeGreaterThan(0);
    expect(reopened.receive(env())).toBe('full');
  });
});

describe('NodeRuntimeStore bounded retention', () => {
  it('does not evict entries, including already consumed inbound identities', () => {
    const { runtime } = fixture({ maxEntries: 2 });
    const first = env({ type: 'rpc.request' });
    expect(runtime.receive(first)).toBe('new');
    expect(runtime.consume(request(first), () => ({ state: null }))).toEqual({ status: 'applied', revision: 1 });
    expect(runtime.usage().entries).toBe(2); // State + inbound tombstone.
    expect(runtime.receive(env())).toBe('full');
    expect(runtime.receive(first)).toBe('duplicate');
    expect(runtime.receive({ ...first, body: { changed: true } })).toBe('conflict');
    expect(runtime.pending()).toEqual([]);
  });

  it('bounds UTF-8 bytes including retained tracking, not just envelope count', () => {
    const value = env({ body: { text: '中文' } });
    const bytes = 128 + Buffer.byteLength(value.from.node_id + value.msg_id + envelopeDigest(value) + jcs(value));
    const exact = fixture({ maxBytes: bytes }).runtime;
    const short = fixture({ maxBytes: bytes - 1 }).runtime;
    expect(exact.receive(value)).toBe('new');
    expect(exact.usage().bytes).toBe(bytes);
    expect(short.receive(value)).toBe('full');
    expect(short.usage()).toEqual({ entries: 0, bytes: 0 });
    expect(exact.receive(env())).toBe('full');
    expect(exact.pending()).toEqual([value]);
  });

  it('rolls back outbox payload and delivery tracking together on capacity exhaustion', () => {
    const { runtime } = fixture({ maxEntries: 1 });
    const outbound = transition().outbox![0]!;
    expect(() => runtime.save({ envelope: outbound, attempts: 0, lastAt: 0 }))
      .toThrow(expect.objectContaining({ code: 'FULL' }));
    expect(runtime.usage()).toEqual({ entries: 0, bytes: 0 });
    expect(runtime.stored(LOCAL, outbound.msg_id, envelopeDigest(outbound))).toBe(false);
  });

  it.each([-1, 1.5, NaN, Infinity])('rejects invalid capacity %s', (limit) => {
    const { store } = fixture();
    expect(() => new NodeRuntimeStore(store, LOCAL, { maxEntries: limit })).toThrow();
    expect(() => new NodeRuntimeStore(store, LOCAL, { maxBytes: limit })).toThrow();
  });
});

describe('NodeRuntimeStore atomic consume', () => {
  it('commits a revision, fixed outbox, effect fence and consumed decision; replays after restart', () => {
    const { runtime, options, store } = fixture();
    const inbound = env();
    const output = transition();
    const original = structuredClone(output);
    runtime.receive(inbound);
    const transform = vi.fn(({ envelope, state }: Parameters<RuntimeTransform>[0]) => {
      expect(envelope).toEqual(inbound);
      expect(state).toBeUndefined();
      return output;
    });
    expect(runtime.consume(request(inbound), transform)).toEqual({ status: 'applied', revision: 1 });
    expect(runtime.pending()).toEqual([]);
    expect(runtime.state('task')).toEqual({ key: 'task', revision: 1, value: original.state });
    expect(runtime.all()[0]!.envelope).toEqual(original.outbox![0]);
    expect(runtime.pendingEffects()).toEqual([{ ...original.effects![0], stateKey: 'task', revision: 1, status: 'pending' }]);
    output.state = null;
    output.outbox![0]!.body.changed = true;
    output.effects![0]!.payload = null;
    runtime.state('task')!.value = null;
    runtime.pendingEffects()[0]!.payload = null;
    expect(runtime.state('task')!.value).toEqual(original.state);
    expect(runtime.pendingEffects()[0]!.payload).toEqual(original.effects![0]!.payload);
    store.close();
    const reopened = new NodeRuntimeStore(open({ ...options, mode: 'open' }), LOCAL);
    expect(reopened.consume(request(inbound), transform)).toEqual({ status: 'applied', revision: 1 });
    expect(transform).toHaveBeenCalledTimes(1);
    expect(reopened.all()[0]!.envelope).toEqual(original.outbox![0]);
    expect(reopened.pendingEffects()[0]!.revision).toBe(1);
  });

  it('persists sender-scoped R1 duplicate/conflict decisions and exempts distinct progress messages', () => {
    const { runtime } = fixture();
    const first = env();
    const same = { ...first, msg_id: newId() };
    const conflict = { ...first, msg_id: newId(), body: { changed: true } };
    const other = { ...first, from: { node_id: OTHER, key_epoch: 1 } };
    for (const value of [first, same, conflict, other]) expect(runtime.receive(value)).toBe('new');
    const apply = vi.fn(() => ({ state: null }));
    expect(runtime.consume(request(first), apply)).toEqual({ status: 'applied', revision: 1 });
    expect(runtime.consume(request(same, 1), apply)).toEqual({ status: 'duplicate', revision: 1 });
    expect(runtime.consume(request(conflict, 1), apply)).toEqual({ status: 'conflict', revision: 1 });
    expect(runtime.consume(request(other, 1), apply)).toEqual({ status: 'applied', revision: 2 });
    const progress = { ...first, msg_id: newId(), type: 'task.progress' };
    const progress2 = { ...progress, msg_id: newId() };
    runtime.receive(progress);
    runtime.receive(progress2);
    expect(runtime.consume(request(progress, 2), apply)).toEqual({ status: 'applied', revision: 3 });
    expect(runtime.consume(request(progress2, 3), apply)).toEqual({ status: 'applied', revision: 4 });
    expect(apply).toHaveBeenCalledTimes(4);
    expect(runtime.pending()).toEqual([]);
    expect(runtime.consume(request(conflict), apply)).toEqual({ status: 'conflict', revision: 1 });
  });

  it('rejects stale revisions before invoking transforms; does not consume another sender or state', () => {
    const { runtime } = fixture();
    const first = env();
    const second = env();
    runtime.receive(first);
    runtime.receive(second);
    runtime.consume(request(first), () => ({ state: null }));
    const transform = vi.fn(() => ({ state: null }));
    expect(runtime.consume({ ...request(second), fromNode: OTHER }, transform)).toEqual({ status: 'missing' });
    expect(() => runtime.consume(request(second), transform)).toThrow(expect.objectContaining({ code: 'STALE' }));
    expect(() => runtime.consume({ ...request(first), stateKey: 'other' }, transform))
      .toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(transform).not.toHaveBeenCalled();
    expect(runtime.pending()).toEqual([second]);
  });

  it('fences stale effects, retains intents and records only current-revision completion', () => {
    const { runtime, options, store } = fixture();
    const first = env();
    const second = env();
    const one = transition();
    const two = transition();
    runtime.receive(first);
    runtime.consume(request(first), () => one);
    const stale = runtime.pendingEffects()[0]!;
    runtime.receive(second);
    runtime.consume(request(second, 1), () => two);
    expect(runtime.pendingEffects().map((effect) => effect.id)).toEqual([two.effects![0]!.id]);
    expect(runtime.completeEffect(stale.id, stale.stateKey, stale.revision)).toBe(false);
    const current = runtime.pendingEffects()[0]!;
    expect(runtime.completeEffect(current.id, 'other', current.revision)).toBe(false);
    expect(runtime.completeEffect(current.id, current.stateKey, current.revision)).toBe(true);
    expect(runtime.completeEffect(current.id, current.stateKey, current.revision)).toBe(false);
    expect(runtime.pendingEffects()).toEqual([]);
    const usage = runtime.usage();
    expect(store.database.prepare('SELECT status FROM node_effects ORDER BY rowid').all())
      .toEqual([{ status: 'pending' }, { status: 'done' }]);
    store.close();
    const reopened = new NodeRuntimeStore(open({ ...options, mode: 'open' }), LOCAL);
    expect(reopened.pendingEffects()).toEqual([]);
    expect(reopened.usage()).toEqual(usage);
  });

  it('rejects async/thenable transforms and rolls back the staged semantic dedup record', () => {
    const { runtime, store } = fixture();
    const inbound = env();
    runtime.receive(inbound);
    let invoked = false;
    const asyncTransform = async () => { invoked = true; return { state: null }; };
    // @ts-expect-error Async callbacks are forbidden by the public contract as well.
    expect(() => runtime.consume(request(inbound), asyncTransform)).toThrow('synchronous');
    expect(invoked).toBe(false);
    const deferred = (() => Promise.resolve({ state: null })) as unknown as RuntimeTransform;
    expect(() => runtime.consume(request(inbound), deferred)).toThrow('synchronous');
    const then = vi.fn();
    expect(() => runtime.consume(request(inbound), () => ({ state: null, then }))).toThrow('JSON data');
    expect(then).not.toHaveBeenCalled();
    expect(store.database.prepare('SELECT * FROM node_dedup').all()).toEqual([]);
    expect(runtime.pending()).toEqual([inbound]);
    expect(runtime.consume(request(inbound), () => ({ state: null }))).toEqual({ status: 'applied', revision: 1 });
  });

  it('rolls back transformed snapshots and dedup on callback failure', () => {
    const { runtime, store } = fixture();
    const first = env();
    runtime.receive(first);
    runtime.consume(request(first), () => ({ state: { count: 1 } }));
    const second = env();
    runtime.receive(second);
    expect(() => runtime.consume(request(second, 1), ({ envelope, state }) => {
      envelope.body.changed = true;
      state!.value = null;
      throw new Error('transform failed');
    })).toThrow('transform failed');
    expect(runtime.state('task')!.value).toEqual({ count: 1 });
    expect(runtime.pending()).toEqual([second]);
    expect(store.database.prepare('SELECT * FROM node_dedup').all()).toHaveLength(1);
    expect(runtime.all()).toEqual([]);
    expect(runtime.pendingEffects()).toEqual([]);
  });

  it.each(['entries', 'bytes', 'constraint'] as const)('rolls back state, outbox, effects, dedup and inbox on %s failure', (failure) => {
    const { runtime, store } = fixture(failure === 'entries' ? { maxEntries: 2 } : failure === 'bytes' ? { maxBytes: 3000 } : {});
    const inbound = env();
    const output = transition();
    if (failure === 'bytes') output.state = { large: 'x'.repeat(4000) };
    if (failure === 'constraint') output.effects!.push(structuredClone(output.effects![0]!));
    expect(runtime.receive(inbound)).toBe('new');
    const before = runtime.usage();
    expect(() => runtime.consume(request(inbound), () => output)).toThrow();
    expect(store.state).toBe('open');
    expect(runtime.usage()).toEqual(before);
    expect(runtime.state('task')).toBeUndefined();
    expect(runtime.pending()).toEqual([inbound]);
    expect(runtime.all()).toEqual([]);
    expect(runtime.pendingEffects()).toEqual([]);
    expect(store.database.prepare('SELECT * FROM node_dedup').all()).toEqual([]);
    expect(store.database.prepare('SELECT * FROM node_delivery').all()).toEqual([]);
    if (failure === 'constraint') {
      output.effects!.pop();
      expect(runtime.consume(request(inbound), () => output)).toEqual({ status: 'applied', revision: 1 });
    }
  });

  it('does not publish a result on actual deferred-constraint COMMIT failure; restart sees all old data', () => {
    const { runtime, options, store } = fixture();
    const seed = env();
    const initial = transition();
    runtime.receive(seed);
    runtime.consume(request(seed), () => initial);
    const inbound = env();
    const output = transition();
    output.state = { count: 2 };
    runtime.receive(inbound);
    const before = runtime.usage();
    failCommit(store, 'consume');
    let published = false;
    expect(() => {
      runtime.consume(request(inbound, 1), () => output);
      published = true;
    }).toThrow();
    expect(published).toBe(false);
    expect(store.state).toBe('faulted');
    expect(() => runtime.pending()).toThrow(expect.objectContaining({ code: 'STORE_FAULTED' }));
    store.close();
    const reopenedStore = open({ ...options, mode: 'open' });
    const reopened = new NodeRuntimeStore(reopenedStore, LOCAL);
    expect(reopened.usage()).toEqual(before);
    expect(reopened.state('task')).toEqual({ key: 'task', revision: 1, value: initial.state });
    expect(reopened.pending()).toEqual([inbound]);
    expect(reopened.all()).toEqual([{ envelope: initial.outbox![0], attempts: 0, lastAt: 0 }]);
    expect(reopened.pendingEffects()).toEqual([{ ...initial.effects![0], stateKey: 'task', revision: 1, status: 'pending' }]);
    expect(reopenedStore.database.prepare('SELECT * FROM node_dedup').all()).toHaveLength(1);
    expect(reopenedStore.database.prepare('SELECT * FROM node_delivery').all()).toHaveLength(1);
    reopenedStore.transaction((db) => db.exec('DROP TRIGGER runtime_test_commit_failure'));
    expect(reopened.consume(request(inbound, 1), () => output)).toEqual({ status: 'applied', revision: 2 });
  });

  it.each(['receive', 'stored'] as const)('never reports successful %s custody on COMMIT failure', (operation) => {
    const { runtime, options, store } = fixture();
    const value = operation === 'receive' ? env() : transition().outbox![0]!;
    if (operation === 'stored') runtime.save({ envelope: value, attempts: 1, lastAt: 10 });
    const before = runtime.usage();
    failCommit(store, operation);
    let receipt = false;
    expect(() => {
      if (operation === 'receive') runtime.receive(value);
      else runtime.stored(LOCAL, value.msg_id, envelopeDigest(value));
      receipt = true;
    }).toThrow();
    expect(receipt).toBe(false);
    expect(store.state).toBe('faulted');
    store.close();
    const reopenedStore = open({ ...options, mode: 'open' });
    const reopened = new NodeRuntimeStore(reopenedStore, LOCAL);
    expect(reopened.usage()).toEqual(before);
    expect(reopened.pending()).toEqual([]);
    if (operation === 'stored') {
      expect(reopened.all()).toEqual([{ envelope: value, attempts: 1, lastAt: 10 }]);
      expect(reopenedStore.database.prepare('SELECT status FROM node_delivery').get()).toEqual({ status: 'pending' });
    }
  });
});

describe('NodeRuntimeStore delivery tombstone retention GC', () => {
  it('retains delivery tombstones forever when no retention window is configured', () => {
    const { runtime } = fixture();
    const outbound = transition().outbox![0]!;
    runtime.save({ envelope: outbound, attempts: 0, lastAt: 0 });
    expect(runtime.stored(LOCAL, outbound.msg_id, envelopeDigest(outbound))).toBe(true);
    expect(runtime.usage().entries).toBe(1); // Delivery tombstone retained, outbox released.
    expect(runtime.prune()).toBe(0); // GC disabled without a window.
    expect(runtime.usage().entries).toBe(1);
    expect(runtime.delivery(outbound.msg_id)).toMatchObject({ status: 'stored' });
  });

  it('reclaims stored tombstones outside the window and never touches a pending delivery', () => {
    let clock = 1_000_000;
    const { runtime } = fixture({ retentionMs: 5_000, now: () => clock });
    const delivered = transition().outbox![0]!;
    runtime.save({ envelope: delivered, attempts: 0, lastAt: 0 });
    expect(runtime.stored(LOCAL, delivered.msg_id, envelopeDigest(delivered))).toBe(true); // Stamped at clock.
    const queued = transition().outbox![0]!;
    runtime.save({ envelope: queued, attempts: 0, lastAt: 0 }); // Stays pending: delivery row + outbox row.
    expect(runtime.usage().entries).toBe(3); // 1 tombstone + 1 pending delivery + its outbox.
    clock = 1_004_999; // Inside the window: age 4999 < 5000.
    expect(runtime.prune()).toBe(0);
    expect(runtime.usage().entries).toBe(3);
    clock = 1_005_000; // Window reached: age 5000 >= 5000.
    expect(runtime.prune()).toBe(1);
    expect(runtime.usage().entries).toBe(2);
    expect(runtime.delivery(delivered.msg_id)).toBeUndefined();
    expect(runtime.delivery(queued.msg_id)).toMatchObject({ status: 'pending' });
    expect(runtime.all().map((entry) => entry.envelope.msg_id)).toEqual([queued.msg_id]);
  });

  it('refuses to reclaim a corrupt tombstone and faults rather than concealing it', () => {
    let clock = 1_000_000;
    const { store, runtime } = fixture({ retentionMs: 0, now: () => clock });
    const outbound = transition().outbox![0]!;
    runtime.save({ envelope: outbound, attempts: 0, lastAt: 0 });
    expect(runtime.stored(LOCAL, outbound.msg_id, envelopeDigest(outbound))).toBe(true);
    rawDatabase(store, (db) => db.prepare("UPDATE node_delivery SET digest = replace(digest, substr(digest, 1, 1), 'g')").run());
    clock = 2_000_000;
    expectCorrupt(store, () => runtime.prune());
  });

  it('persists tombstone reclamation across a runtime reopen', () => {
    let clock = 1_000_000;
    const { options, store, runtime } = fixture({ retentionMs: 0, now: () => clock });
    const outbound = transition().outbox![0]!;
    runtime.save({ envelope: outbound, attempts: 0, lastAt: 0 });
    expect(runtime.stored(LOCAL, outbound.msg_id, envelopeDigest(outbound))).toBe(true);
    clock = 2_000_000;
    expect(runtime.prune()).toBe(1);
    store.close();
    const reopened = open({ ...options, mode: 'open' });
    const runtime2 = new NodeRuntimeStore(reopened, LOCAL, { retentionMs: 0, now: () => clock });
    expect(runtime2.delivery(outbound.msg_id)).toBeUndefined();
    expect(runtime2.usage().entries).toBe(0);
  });

  it('rejects an invalid retention window at construction', () => {
    const { store } = fixture();
    expect(() => new NodeRuntimeStore(store, LOCAL, { retentionMs: -1 })).toThrow(RangeError);
    expect(() => new NodeRuntimeStore(store, LOCAL, { retentionMs: 1.5 })).toThrow(RangeError);
    expect(() => new NodeRuntimeStore(store, LOCAL, { retentionMs: Number.MAX_SAFE_INTEGER + 1 })).toThrow(RangeError);
    expect(new NodeRuntimeStore(store, LOCAL, { retentionMs: 0 }).prune()).toBe(0);
  });
});