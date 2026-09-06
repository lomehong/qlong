import { constantFrom, integer, jsonValue, property, assert } from 'fast-check';
import { describe, expect, it } from 'vitest';
import { attemptGate } from '../src/attempt-gate.js';
import type { GateVerdict } from '../src/attempt-gate.js';
import { DedupStore } from '../src/dedup.js';
import { jcs } from '../src/jcs.js';


describe('property:R0 attempt 闸门全序一致(D25)', () => {
  it('verdict 与 (local vs incoming) 比较关系一一对应,与消息类型仅在大于分支有关', () => {
    const typeArb = constantFrom('task.offer', 'task.result', 'task.progress', 'task.cancel');
    const prop = property(
      integer({ min: 1, max: 6 }),
      integer({ min: 1, max: 6 }),
      typeArb,
      (local: number, incoming: number, type: string): boolean => {
        const v: GateVerdict = attemptGate(local, { type, attempt: incoming });
        if (incoming === local) return v.action === 'process';
        if (incoming < local) return v.action === 'reject_stale';
        return type === 'task.offer' ? v.action === 'implicit_cancel' : v.action === 'drop';
      },
    );
    expect(() => assert(prop, { numRuns: 500 })).not.toThrow();
  });
});

const bodyArb = jsonValue()
  .filter((v) => typeof v === 'object' && v !== null && !Array.isArray(v))
  .map((v) => v as Record<string, unknown>);

describe('property:R1 去重(评审 I-01)', () => {
  it('任意 body:同 body 必 duplicate(键序无关);包一层异体必 mismatch', () => {
    const prop = property(bodyArb, (body: Record<string, unknown>) => {
      const store = new DedupStore(3_600_000);
      const shuffled = Object.fromEntries(Object.entries(body).slice().reverse());
      const wrapped = { q: body };
      const first = store.checkAndRecord('t', 1, 'task.offer', body);
      const dup = store.checkAndRecord('t', 1, 'task.offer', shuffled);
      const mis = store.checkAndRecord('t', 1, 'task.offer', wrapped);
      return first.verdict === 'first' && dup.verdict === 'duplicate' && mis.verdict === 'mismatch';
    });
    expect(() => assert(prop, { numRuns: 300 })).not.toThrow();
  });
});

describe('property:JCS 幂等(D23)', () => {
  it('jcs(JSON.parse(jcs(x))) === jcs(x)', () => {
    const prop = property(jsonValue(), (v: unknown) => {
      const once = jcs(v);
      return once === jcs(JSON.parse(once));
    });
    expect(() => assert(prop, { numRuns: 500 })).not.toThrow();
  });
});