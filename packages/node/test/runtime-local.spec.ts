import { describe, expect, it, vi } from 'vitest';
import { jcs, newId } from '@qlong/core';
import { NodeRuntimeStore, type RuntimeJson, type RuntimeState, type RuntimeTransition } from '../src/runtime/store.js';
import {
  env, expectCorrupt, failCommit, fixture, LOCAL, open, rawDatabase, request, transition,
} from './runtime-store-helpers.js';

type LocalTransform = Parameters<NodeRuntimeStore['transition']>[2];

describe('NodeRuntimeStore local CAS', () => {
  it('commits detached state, fixed outbox and effects without touching inbox or semantic dedup', () => {
    const { runtime, store, options } = fixture();
    const inbound = env();
    runtime.receive(inbound);
    const output = transition();
    const original = structuredClone(output);
    const transform = vi.fn((state: RuntimeState | undefined) => {
      expect(state).toBeUndefined();
      return output;
    });
    expect(runtime.transition('task', 0, transform)).toBe(1);
    expect(transform).toHaveBeenCalledTimes(1);
    output.state = null;
    output.outbox![0]!.body.changed = true;
    output.effects![0]!.payload = null;
    (runtime.state('task')!.value as { count: number }).count = 99;
    runtime.all()[0]!.envelope.body.changed = true;
    runtime.pendingEffects()[0]!.payload = null;
    expect(runtime.state('task')).toEqual({ key: 'task', revision: 1, value: original.state });
    expect(runtime.all()).toEqual([{ envelope: original.outbox![0], attempts: 0, lastAt: 0 }]);
    expect(runtime.pendingEffects()).toEqual([{ ...original.effects![0], stateKey: 'task', revision: 1, status: 'pending' }]);
    expect(runtime.pending()).toEqual([inbound]);
    expect(store.database.prepare('SELECT * FROM node_dedup').all()).toEqual([]);
    store.close();
    const reopened = new NodeRuntimeStore(open({ ...options, mode: 'open' }), LOCAL);
    expect(reopened.state('task')).toEqual({ key: 'task', revision: 1, value: original.state });
    expect(reopened.all()[0]!.envelope).toEqual(original.outbox![0]);
    expect(reopened.pendingEffects()[0]!.revision).toBe(1);
    expect(reopened.pending()).toEqual([inbound]);
  });

  it('detaches transform inputs even on failure and never trusts mutated key/revision metadata', () => {
    const { runtime } = fixture();
    runtime.transition('task', 0, () => ({ state: { count: 1 } }));
    expect(() => runtime.transition('task', 1, (state) => {
      (state!.value as { count: number }).count = 99;
      throw new Error('transform failed');
    })).toThrow('transform failed');
    expect(runtime.state('task')!.value).toEqual({ count: 1 });
    let retained: RuntimeState | undefined;
    expect(runtime.transition('task', 1, (state) => {
      retained = state;
      state!.key = 'other';
      state!.revision = 100;
      (state!.value as { count: number }).count = 2;
      return { state: state!.value };
    })).toBe(2);
    (retained!.value as { count: number }).count = 99;
    expect(runtime.state('task')).toEqual({ key: 'task', revision: 2, value: { count: 2 } });
    expect(runtime.state('other')).toBeUndefined();
  });

  it('shares CAS revisions with consume and other store facades; stale callbacks never run', () => {
    const { runtime, store } = fixture();
    const other = new NodeRuntimeStore(store, LOCAL);
    const transform = vi.fn(() => ({ state: null }));
    expect(() => runtime.transition('task', 1, transform)).toThrow(expect.objectContaining({ code: 'STALE' }));
    expect(other.transition('task', 0, () => ({ state: null }))).toBe(1);
    const inbound = env();
    runtime.receive(inbound);
    expect(() => runtime.consume(request(inbound), transform)).toThrow(expect.objectContaining({ code: 'STALE' }));
    expect(runtime.consume(request(inbound, 1), () => ({ state: null }))).toEqual({ status: 'applied', revision: 2 });
    expect(() => other.transition('task', 1, transform)).toThrow(expect.objectContaining({ code: 'STALE' }));
    expect(() => runtime.transition('task', 3, transform)).toThrow(expect.objectContaining({ code: 'STALE' }));
    expect(transform).not.toHaveBeenCalled();
    expect(runtime.transition('task', 2, () => ({ state: null }))).toBe(3);
    expect(runtime.consume(request(inbound), transform)).toEqual({ status: 'applied', revision: 2 });
    expect(transform).not.toHaveBeenCalled();
  });

  it('validates keys/revisions before calling transforms and refuses revision overflow', () => {
    const { runtime, store } = fixture();
    const transform = vi.fn(() => ({ state: null }));
    for (const stateKey of ['', '中'.repeat(342), null, 1]) {
      expect(() => runtime.transition(stateKey as string, 0, transform)).toThrow(TypeError);
    }
    for (const revision of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => runtime.transition('task', revision, transform)).toThrow(TypeError);
    }
    expect(transform).not.toHaveBeenCalled();
    runtime.transition('task', 0, () => ({ state: null }));
    store.transaction((db) => db.prepare('UPDATE node_state SET revision = ?').run(Number.MAX_SAFE_INTEGER));
    const before = runtime.usage();
    expect(() => runtime.transition('task', Number.MAX_SAFE_INTEGER, () => transition())).toThrow('next revision');
    expect(runtime.state('task')!.revision).toBe(Number.MAX_SAFE_INTEGER);
    expect(runtime.usage()).toEqual(before);
    expect(runtime.all()).toEqual([]);
  });

  it('rejects async functions before invocation, promise results, and thenables without assimilation', () => {
    const { runtime, store } = fixture();
    let invoked = false;
    const asyncTransform = async () => { invoked = true; return { state: null }; };
    // @ts-expect-error Async callbacks are forbidden by the public contract as well.
    expect(() => runtime.transition('task', 0, asyncTransform)).toThrow('synchronous');
    expect(invoked).toBe(false);
    for (const make of [() => Promise.resolve({ state: null }), () => Promise.reject(new Error('deferred'))]) {
      expect(() => runtime.transition('task', 0, make as unknown as LocalTransform)).toThrow('synchronous');
    }
    const then = vi.fn();
    expect(() => runtime.transition('task', 0, () => ({ state: null, then }))).toThrow('JSON data');
    const getter = vi.fn(() => then);
    const output = { state: null };
    Object.defineProperty(output, 'then', { enumerable: true, get: getter });
    expect(() => runtime.transition('task', 0, () => output)).toThrow('accessors');
    expect(then).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
    expect(runtime.usage()).toEqual({ entries: 0, bytes: 0 });
    expect(store.state).toBe('open');
    expect(runtime.transition('task', 0, () => ({ state: null }))).toBe(1);
  });

  it.each(['read', 'list', 'transition', 'consume', 'facade'] as const)('rejects caught %s reentry', (operation) => {
    const { runtime, store, options } = fixture();
    const other = new NodeRuntimeStore(store, LOCAL);
    const inbound = env();
    runtime.receive(inbound);
    const nested = vi.fn(() => ({ state: null }));
    expect(() => runtime.transition('task', 0, () => {
      expect(() => {
        if (operation === 'read') return runtime.state('task');
        if (operation === 'list') return runtime.states('');
        if (operation === 'consume') return runtime.consume(request(inbound), nested);
        if (operation === 'facade') return other.transition('other', 0, nested);
        return runtime.transition('other', 0, nested);
      }).toThrow(expect.objectContaining({ code: 'TRANSACTION_MISUSE' }));
      return transition();
    })).toThrow(expect.objectContaining({ code: 'TRANSACTION_MISUSE' }));
    expect(nested).not.toHaveBeenCalled();
    expect(store.state).toBe('faulted');
    store.close();
    const reopened = new NodeRuntimeStore(open({ ...options, mode: 'open' }), LOCAL);
    expect(reopened.states('')).toEqual([]);
    expect(reopened.all()).toEqual([]);
    expect(reopened.pendingEffects()).toEqual([]);
    expect(reopened.pending()).toEqual([inbound]);
  });

  it.each(['entries', 'bytes', 'constraint'] as const)('rolls back every local write on %s failure', (failure) => {
    const { runtime, store } = fixture(failure === 'entries' ? { maxEntries: 3 } : failure === 'bytes' ? { maxBytes: 3000 } : {});
    runtime.transition('task', 0, () => ({ state: { count: 1 } }));
    const before = runtime.usage();
    const output = transition();
    output.state = failure === 'bytes' ? { large: 'x'.repeat(4000) } : { count: 2 };
    if (failure === 'constraint') output.effects!.push(structuredClone(output.effects![0]!));
    const apply = () => runtime.transition('task', 1, () => output);
    if (failure === 'constraint') expect(apply).toThrow();
    else expect(apply).toThrow(expect.objectContaining({ code: 'FULL' }));
    expect(store.state).toBe('open');
    expect(runtime.usage()).toEqual(before);
    expect(runtime.state('task')).toEqual({ key: 'task', revision: 1, value: { count: 1 } });
    expect(runtime.all()).toEqual([]);
    expect(runtime.pendingEffects(undefined, true)).toEqual([]);
    expect(store.database.prepare('SELECT * FROM node_delivery').all()).toEqual([]);
    expect(runtime.transition('task', 1, () => ({ state: { count: 2 } }))).toBe(2);
  });

  it('rolls back creation when no state capacity is available', () => {
    const { runtime } = fixture({ maxEntries: 0 });
    expect(() => runtime.transition('task', 0, () => ({ state: null }))).toThrow(expect.objectContaining({ code: 'FULL' }));
    expect(runtime.state('task')).toBeUndefined();
    expect(runtime.usage()).toEqual({ entries: 0, bytes: 0 });
  });

  it.each([
    ['missing state', (): unknown => ({})],
    ['nonfinite state', (): unknown => ({ state: NaN })],
    ['custom state', (): unknown => ({ state: new Date() })],
    ['invalid outbox collection', (): unknown => ({ state: null, outbox: {} })],
    ['invalid effects collection', (): unknown => ({ state: null, effects: {} })],
    ['wrong sender', (): unknown => ({ state: null, outbox: [env()] })],
    ['unsigned envelope', () => { const output = transition(); delete output.outbox![0]!.sig; return output; }],
    ['invalid effect key', () => { const output = transition(); output.effects![0]!.id = ''; return output; }],
    ['invalid effect kind', () => { const output = transition(); output.effects![0]!.kind = ''; return output; }],
    ['lossy effect payload', () => { const output = transition(); output.effects![0]!.payload = undefined as unknown as RuntimeJson; return output; }],
  ] as const)('reuses consume validation and atomic rollback: %s', (_name, make) => {
    const { runtime, store } = fixture();
    expect(() => runtime.transition('task', 0, make as LocalTransform)).toThrow(TypeError);
    expect(store.state).toBe('open');
    expect(runtime.usage()).toEqual({ entries: 0, bytes: 0 });
    expect(runtime.state('task')).toBeUndefined();
    expect(runtime.all()).toEqual([]);
    expect(runtime.pendingEffects()).toEqual([]);
  });

  it('preserves immutable outbox identities when a local transition conflicts', () => {
    const { runtime } = fixture();
    const initial = transition();
    runtime.transition('task', 0, () => initial);
    const before = runtime.usage();
    const output: RuntimeTransition = {
      ...transition(), outbox: [{ ...initial.outbox![0]!, body: { changed: true } }],
    };
    expect(() => runtime.transition('task', 1, () => output)).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(runtime.state('task')!.revision).toBe(1);
    expect(runtime.all()[0]!.envelope).toEqual(initial.outbox![0]);
    expect(runtime.pendingEffects()[0]!.id).toBe(initial.effects![0]!.id);
    expect(runtime.usage()).toEqual(before);
  });

  it.each([false, true])('withholds revision on actual COMMIT failure and reopens old data (existing=%s)', (existing) => {
    const { runtime, store, options } = fixture();
    const initial = transition();
    if (existing) runtime.transition('task', 0, () => initial);
    const inbound = env();
    runtime.receive(inbound);
    const before = runtime.usage();
    failCommit(store, 'consume');
    // Reuse the deferred-FK fixture, but fail local effect insertion rather than inbox consumption.
    store.transaction((db) => db.exec(`
      DROP TRIGGER runtime_test_commit_failure;
      CREATE TRIGGER runtime_test_commit_failure AFTER INSERT ON node_effects BEGIN
        INSERT INTO runtime_test_child VALUES ('failure', 'missing');
      END;
    `));
    const output = transition();
    output.state = { count: 2 };
    const expectedRevision = existing ? 1 : 0;
    let published: number | undefined;
    expect(() => { published = runtime.transition('task', expectedRevision, () => output); }).toThrow();
    expect(published).toBeUndefined();
    expect(store.state).toBe('faulted');
    expect(() => runtime.state('task')).toThrow(expect.objectContaining({ code: 'STORE_FAULTED' }));
    store.close();
    const reopenedStore = open({ ...options, mode: 'open' });
    const reopened = new NodeRuntimeStore(reopenedStore, LOCAL);
    expect(reopened.usage()).toEqual(before);
    expect(reopened.state('task')).toEqual(existing ? { key: 'task', revision: 1, value: initial.state } : undefined);
    expect(reopened.all()).toEqual(existing ? [{ envelope: initial.outbox![0], attempts: 0, lastAt: 0 }] : []);
    expect(reopened.pendingEffects()).toEqual(existing ? [{ ...initial.effects![0], stateKey: 'task', revision: 1, status: 'pending' }] : []);
    expect(reopened.pending()).toEqual([inbound]);
    expect(reopenedStore.database.prepare('SELECT * FROM node_dedup').all()).toEqual([]);
    expect(reopenedStore.database.prepare('SELECT * FROM node_delivery').all()).toHaveLength(existing ? 1 : 0);
    reopenedStore.transaction((db) => db.exec('DROP TRIGGER runtime_test_commit_failure'));
    expect(reopened.transition('task', expectedRevision, () => output)).toBe(expectedRevision + 1);
  });
});

describe('NodeRuntimeStore state listing', () => {
  it('lists all states for an empty prefix, including keys beginning with NUL', () => {
    const { runtime } = fixture();
    expect(runtime.states('')).toEqual([]);
    runtime.transition('z', 0, () => ({ state: null }));
    runtime.transition('\0key', 0, () => ({ state: [1] }));
    const first = { key: '\0key', revision: 1, value: [1] };
    expect(runtime.states('')).toEqual([first, { key: 'z', revision: 1, value: null }]);
    expect(runtime.states('', 1)).toEqual([first]);
    expect(runtime.states('', 0)).toEqual([]);
    expect(runtime.states('\0')).toEqual([first]);
  });

  it('orders detached states by literal, case-sensitive prefix with bounded results', () => {
    const { runtime, store } = fixture();
    const keys = ['task:z', 'Task:a', 'task:%_b', 'task:%_a', 'task:%Xa', 'task:X_a', "task:' OR 1=1 --",
      'task:中文/b', 'task:中文/a', 'task:\\a', 'task:\0b', 'task:\0a', 'other'];
    for (const stateKey of keys) runtime.transition(stateKey, 0, () => ({ state: { nested: [1] } }));
    const listedKeys = (prefix: string, limit?: number) => runtime.states(prefix, limit).map((state) => state.key);
    expect(listedKeys('')).toEqual([...keys].sort());
    expect(listedKeys('task:')).toEqual(keys.filter((value) => value.startsWith('task:')).sort());
    expect(listedKeys('task:%_')).toEqual(['task:%_a', 'task:%_b']);
    expect(listedKeys('task:%', 1)).toEqual(['task:%Xa']);
    expect(listedKeys("task:' OR 1=1 --")).toEqual(["task:' OR 1=1 --"]);
    expect(listedKeys('task:中文/')).toEqual(['task:中文/a', 'task:中文/b']);
    expect(listedKeys('task:\\')).toEqual(['task:\\a']);
    expect(listedKeys('task:\0')).toEqual(['task:\0a', 'task:\0b']);
    expect(listedKeys('task:', 0)).toEqual([]);
    expect(listedKeys('missing')).toEqual([]);
    const first = runtime.states('task:%_')[0]!;
    first.key = 'changed';
    first.revision = 99;
    (first.value as { nested: number[] }).nested[0] = 99;
    expect(runtime.states('task:%_', 1)).toEqual([{ key: 'task:%_a', revision: 1, value: { nested: [1] } }]);
    const bounded = new NodeRuntimeStore(store, LOCAL, { maxEntries: 2 });
    expect(bounded.states('').map((state) => state.key)).toEqual([...keys].sort().slice(0, 2));
  });

  it('validates prefix byte length and limits', () => {
    const { runtime } = fixture();
    for (const prefix of ['中'.repeat(342), null, 1]) expect(() => runtime.states(prefix as string)).toThrow(TypeError);
    for (const limit of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => runtime.states('', limit)).toThrow(TypeError);
    }
    expect(runtime.states('a'.repeat(1024))).toEqual([]);
  });

  it.each(['states', 'transition'] as const)('validates persisted JSON before publishing %s results', (operation) => {
    const { runtime, store } = fixture();
    runtime.transition('task:a', 0, () => ({ state: null }));
    runtime.transition('task:z', 0, () => ({ state: null }));
    rawDatabase(store, (db) => db.exec("UPDATE node_state SET value = '1e999' WHERE state_key = 'task:z'"));
    const transform = vi.fn(() => ({ state: null }));
    expectCorrupt(store, () => operation === 'states' ? runtime.states('task:') : runtime.transition('task:z', 1, transform));
    expect(transform).not.toHaveBeenCalled();
  });

  it.each(["state_key = ''", 'revision = 0', 'revision = 9007199254740992'])(
    'validates persisted metadata in an unfiltered listing: %s', (assignment) => {
      const { runtime, store } = fixture();
      runtime.transition('task', 0, () => ({ state: null }));
      rawDatabase(store, (db) => db.exec(`UPDATE node_state SET ${assignment}`));
      expectCorrupt(store, () => runtime.states(''));
    });
});

describe('NodeRuntimeStore superseded effects opt-in', () => {
  it('defaults to current revisions and verifies exact id/key/revision even with opt-in', () => {
    const { runtime, store, options } = fixture();
    const one = transition();
    const two = transition();
    runtime.transition('task', 0, () => one);
    const stale = runtime.pendingEffects()[0]!;
    runtime.transition('task', 1, () => two);
    const current = runtime.pendingEffects()[0]!;
    expect(runtime.pendingEffects(undefined, false)).toEqual([current]);
    expect(runtime.pendingEffects(1)).toEqual([current]);
    expect(runtime.pendingEffects(undefined, true)).toEqual([stale, current]);
    expect(runtime.pendingEffects(1, true)).toEqual([stale]);
    expect(runtime.pendingEffects(0, true)).toEqual([]);
    runtime.pendingEffects(1, true)[0]!.payload = null;
    expect(runtime.pendingEffects(1, true)[0]).toEqual(stale);
    runtime.transition('other', 0, () => ({ state: null }));
    expect(runtime.completeEffect(stale.id, 'task', 1)).toBe(false);
    expect(runtime.completeEffect(stale.id, 'task', 1, false)).toBe(false);
    expect(runtime.completeEffect('missing', 'task', 1, true)).toBe(false);
    expect(runtime.completeEffect(stale.id, 'other', 1, true)).toBe(false);
    expect(runtime.completeEffect(stale.id, 'task', 0, true)).toBe(false);
    expect(runtime.completeEffect(stale.id, 'task', 2, true)).toBe(false);
    expect(runtime.completeEffect(current.id, 'task', 1, true)).toBe(false);
    expect(runtime.completeEffect(stale.id, 'task', 1, true)).toBe(true);
    expect(runtime.completeEffect(stale.id, 'task', 1, true)).toBe(false);
    expect(runtime.pendingEffects(undefined, true)).toEqual([current]);
    const usage = runtime.usage();
    store.close();
    const reopened = new NodeRuntimeStore(open({ ...options, mode: 'open' }), LOCAL);
    expect(reopened.pendingEffects(undefined, true)).toEqual([current]);
    expect(reopened.usage()).toEqual(usage);
    expect(reopened.completeEffect(current.id, 'task', 2)).toBe(true);
    expect(reopened.pendingEffects(undefined, true)).toEqual([]);
    expect(reopened.usage()).toEqual(usage);
  });

  it('requires boolean opt-ins, not truthy values', () => {
    const { runtime } = fixture();
    for (const flag of [1, 'true', null]) {
      expect(() => runtime.pendingEffects(1, flag as unknown as boolean)).toThrow(TypeError);
      expect(() => runtime.completeEffect('effect', 'task', 1, flag as unknown as boolean)).toThrow(TypeError);
    }
  });

  it.each(['list', 'complete'] as const)('never bypasses corrupt effect validation with opt-in: %s', (operation) => {
    for (const assignment of ["payload = '{'", "kind = ''", 'revision = 3', "state_key = 'missing'"]) {
      const { runtime, store } = fixture();
      const output = transition();
      runtime.transition('task', 0, () => output);
      runtime.transition('task', 1, () => ({ state: null }));
      rawDatabase(store, (db) => db.exec(`UPDATE node_effects SET ${assignment}`));
      expectCorrupt(store, () => operation === 'list' ? runtime.pendingEffects(undefined, true) :
        runtime.completeEffect(output.effects![0]!.id, 'task', 1, true));
      expect(rawDatabase(store, (db) => db.prepare('SELECT status FROM node_effects').get()?.status)).toBe('pending');
    }
  });
});

describe('NodeRuntimeStore sequence-bearing renewals', () => {
  it.each(['task.progress', 'task.lease.renew'])('exempts %s from semantic R1, but not message identity dedup', (type) => {
    const { runtime, store, options } = fixture();
    const first = env({ type, body: { seq: 1, lease_ms: 300_000 } });
    const same = { ...first, msg_id: newId() };
    const next = { ...first, msg_id: newId(), body: { ...first.body, seq: 2 } };
    const apply = vi.fn(({ envelope }: { envelope: typeof first }) => ({ state: { seq: envelope.body.seq as number } }));
    for (const [index, value] of [first, same, next].entries()) {
      expect(runtime.receive(value)).toBe('new');
      expect(runtime.consume(request(value, index), apply)).toEqual({ status: 'applied', revision: index + 1 });
    }
    expect(runtime.receive(first)).toBe('duplicate');
    expect(runtime.consume(request(first), apply)).toEqual({ status: 'applied', revision: 1 });
    expect(apply).toHaveBeenCalledTimes(3);
    expect(store.database.prepare('SELECT * FROM node_dedup').all()).toEqual([]);
    store.close();
    const reopened = new NodeRuntimeStore(open({ ...options, mode: 'open' }), LOCAL);
    expect(reopened.state('task')).toEqual({ key: 'task', revision: 3, value: { seq: 2 } });
    const later = { ...next, msg_id: newId(), body: { ...next.body, seq: 3 } };
    expect(reopened.receive(later)).toBe('new');
    expect(reopened.consume(request(later, 3), apply)).toEqual({ status: 'applied', revision: 4 });
  });

  it.each(['task.progress', 'task.lease.renew'])('rejects persisted semantic R1 records for exempt %s at startup', (type) => {
    const { runtime, store, options } = fixture();
    const inbound = env();
    runtime.receive(inbound);
    runtime.consume(request(inbound), () => ({ state: null }));
    rawDatabase(store, (db) => db.prepare('UPDATE node_dedup SET dedup_key = ?')
      .run(jcs([inbound.task_id, inbound.attempt, type])));
    store.close();
    const reopened = open({ ...options, mode: 'open' });
    expectCorrupt(reopened, () => new NodeRuntimeStore(reopened, LOCAL));
  });
});