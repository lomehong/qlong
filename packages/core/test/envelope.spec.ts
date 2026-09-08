import { describe, expect, it } from 'vitest';
import { familyOf, validateEnvelope } from '../src/envelope.js';

const U = {
  nodeA: '11111111-1111-4111-8111-111111111111',
  nodeB: '22222222-2222-4222-8222-222222222222',
  team: '33333333-3333-4333-8333-333333333333',
  nodeT: '44444444-4444-4444-8444-444444444444',
  trace: '55555555-5555-4555-8555-555555555555',
  task: '66666666-6666-4666-8666-666666666666',
  msg: '77777777-7777-4777-8777-777777777777',
};

const SIG64 = 'A'.repeat(86) + '==';

function offerBase(over: Record<string, unknown> = {}, body?: Record<string, unknown>): Record<string, unknown> {
  return {
    v: 1,
    type: 'task.offer',
    msg_id: U.msg,
    ts: '2026-09-06T12:00:00+08:00',
    exp: '2026-09-07T12:00:00+08:00',
    from: { node_id: U.nodeA, team_id: U.team, key_epoch: 3 },
    to: { node_id: U.nodeB, team_id: U.team },
    trace: { trace_id: U.trace, parent_span: null, origin_node: U.nodeA },
    hops: 0,
    task_id: U.task,
    attempt: 1,
    sig: { alg: 'ed25519', value: SIG64 },
    body: body ?? { kind: 'aid', summary: '看下日志', lease_ms: 120000, offer_ttl_ms: 10000 },
    ...over,
  };
}

function errorsOf(raw: unknown): string[] {
  const r = validateEnvelope(raw);
  return r.ok ? [] : r.errors;
}

describe('信封校验器(01 §3)', () => {
  it('合法 task.offer 通过;familyOf 正确', () => {
    expect(validateEnvelope(offerBase()).ok).toBe(true);
    expect(familyOf('task.cancel.ack')).toBe('task');
    expect(familyOf('rpc.ask')).toBe('rpc');
  });

  it('v 必须 = 1', () => {
    expect(errorsOf(offerBase({ v: 2 })).some((e) => e.startsWith('v:'))).toBe(true);
  });

  it('type 文法:单段/大写拒绝,三段 task.cancel.ack 通过', () => {
    expect(errorsOf(offerBase({ type: 'task' })).length).toBeGreaterThan(0);
    expect(errorsOf(offerBase({ type: 'TASK.offer' })).length).toBeGreaterThan(0);
    expect(errorsOf(offerBase({ type: 'task.cancel.ack' })).length).toBe(0);
  });

  it('task.* 必填:hops/task_id/attempt/exp/sig 缺一不可', () => {
    const { hops: _h, ...noHops } = offerBase();
    const { task_id: _t, ...noTask } = offerBase();
    const { attempt: _a, ...noAttempt } = offerBase();
    const { exp: _e, ...noExp } = offerBase();
    const { sig: _s, ...noSig } = offerBase();
    expect(errorsOf(noHops).some((e) => e.startsWith('hops:'))).toBe(true);
    expect(errorsOf(noTask).some((e) => e.startsWith('task_id:'))).toBe(true);
    expect(errorsOf(noAttempt).some((e) => e.startsWith('attempt:'))).toBe(true);
    expect(errorsOf(noExp).some((e) => e.startsWith('exp:'))).toBe(true);
    expect(errorsOf(noSig).some((e) => e.startsWith('sig:'))).toBe(true);
  });

  it('hops 超过 MAX_HOPS=8 拒绝;负数拒绝', () => {
    expect(errorsOf(offerBase({ hops: 9 })).some((e) => e.includes('MAX_HOPS'))).toBe(true);
    expect(errorsOf(offerBase({ hops: -1 })).some((e) => e.startsWith('hops:'))).toBe(true);
  });

  it('attempt 必须 ≥ 1', () => {
    expect(errorsOf(offerBase({ attempt: 0 })).some((e) => e.startsWith('attempt:'))).toBe(true);
  });

  it('D23:浮点/超精度数值深校验拒绝', () => {
    expect(
      errorsOf(offerBase({}, { kind: 'aid', summary: 'x', lease_ms: 1.5, offer_ttl_ms: 10000 })).some((e) =>
        e.includes('安全整数'),
      ),
    ).toBe(true);
    expect(
      errorsOf(offerBase({}, { kind: 'aid', summary: 'x', lease_ms: 9007199254740994, offer_ttl_ms: 10000 }))
        .length,
    ).toBeGreaterThan(0);
  });

  it('sig:alg 白名单 + 64 字节约束', () => {
    expect(errorsOf(offerBase({ sig: { alg: 'ed25519-hax', value: SIG64 } })).some((e) => e.includes('alg'))).toBe(
      true,
    );
    expect(errorsOf(offerBase({ sig: { alg: 'ed25519', value: 'AAAA' } })).some((e) => e.includes('64 字节'))).toBe(
      true,
    );
  });

  it('rpc.ask:exp 可省;sig 必填', () => {
    const ask = {
      v: 1,
      type: 'rpc.ask',
      msg_id: U.msg,
      ts: '2026-09-06T12:00:00+08:00',
      from: { node_id: U.nodeA, team_id: U.team, key_epoch: 3 },
      to: { node_id: U.nodeB, team_id: U.team },
      trace: { trace_id: U.trace, parent_span: null, origin_node: U.nodeA },
      sig: { alg: 'ed25519', value: SIG64 },
      body: { request_id: U.task, question: '在吗', timeout_ms: 5000 },
    };
    expect(validateEnvelope(ask).ok).toBe(true);
    const { sig: _s, ...noSig } = ask;
    expect(errorsOf(noSig).some((e) => e.startsWith('sig:'))).toBe(true);
  });

  it('未知字段放行(§8 前向兼容);trace.parent_span 须为 uuid 或 null', () => {
    expect(errorsOf(offerBase({ future_field: { whatever: 1 } })).length).toBe(0);
    const bad = offerBase();
    (bad.trace as Record<string, unknown>).parent_span = 'nope';
    expect(errorsOf(bad).some((e) => e.includes('parent_span'))).toBe(true);
  });
});