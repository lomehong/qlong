import { describe, expect, it } from 'vitest';
import { ExecutorMachine, type ExecAction } from '../src/executor/machine.js';

const TASK = '66666666-6666-4666-8666-666666666666';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function mk(opts: ConstructorParameters<typeof ExecutorMachine>[0] = {}) {
  return new ExecutorMachine({ capabilities: () => ['tool:node@20'], ...opts });
}
function offerInput(attempt = 1, body?: Record<string, unknown>, now = 0) {
  return {
    from: A,
    task_id: TASK,
    attempt,
    msg_id: '77777777-7777-4777-8777-777777777777',
    body:
      body ??
      { kind: 'aid', summary: 's', lease_ms: 120000, offer_ttl_ms: 10000, required_caps: ['tool:node'] },
    now,
  };
}
function sends(actions: ExecAction[]) {
  return actions
    .filter((a): a is Extract<ExecAction, { kind: 'send' }> => a.kind === 'send')
    .map((a) => a.msg);
}

describe('执行方四道闸(03 §6)', () => {
  it('闸2 先于闸3:策略拒绝优先于能力缺失', () => {
    const m = mk({ policy: () => ({ ok: false }) });
    const actions = m.onOffer(
      offerInput(1, { kind: 'aid', summary: 's', lease_ms: 1, offer_ttl_ms: 1, required_caps: ['hw:gpu-cuda'] }),
    );
    expect(sends(actions)[0]?.body.reason_code).toBe('policy_denied');
  });

  it('闸3:能力不足 → unsupported_caps + missing 明细(反哺改派)', () => {
    const m = mk();
    const actions = m.onOffer(
      offerInput(1, {
        kind: 'aid',
        summary: 's',
        lease_ms: 1,
        offer_ttl_ms: 1,
        required_caps: ['tool:node', 'hw:gpu-cuda'],
      }),
    );
    const body = sends(actions)[0]?.body as { reason_code: string; missing: string[] };
    expect(body.reason_code).toBe('unsupported_caps');
    expect(body.missing).toEqual(['hw:gpu-cuda']);
  });

  it('闸4:超阈值 → busy(带 retry_after_ms)', () => {
    const m = mk({ load: () => ({ queueDepth: 3, running: 1, maxQueue: 2, maxRunning: 2, retryAfterMs: 8000 }) });
    const actions = m.onOffer(offerInput());
    const body = sends(actions)[0]?.body as { reason_code: string; retry_after_ms: number };
    expect(body.reason_code).toBe('busy');
    expect(body.retry_after_ms).toBe(8000);
  });

  it('接单:accept 确认租约 + startDriver + 心跳排程(lease/3)', () => {
    const m = mk();
    const actions = m.onOffer(offerInput());
    const msgs = sends(actions);
    expect(msgs[0]?.type).toBe('task.accept');
    expect(msgs[0]?.body.lease_ms).toBe(120000);
    expect(actions.some((a) => a.kind === 'startDriver')).toBe(true);
    expect(actions.some((a) => a.kind === 'schedule' && a.timer === 'heartbeat' && a.atMs === 40_000)).toBe(true);
    expect(m.rec.state).toBe('running');
  });
});

describe('执行方状态机(§5.2/R5)', () => {
  it('R2:offer_ttl「晚于」才过期 → reject(expired)(离线补投:补投后置回 offered 态检验)', () => {
    const m = mk();
    m.onOffer(offerInput());
    // v1 闸门同步通过即 accept,offered 为瞬态;离线补投单按「补投时刻重新可拒」检验 TTL 守卫
    Object.assign(m.rec, { state: 'offered', receivedAt: 0, ttlMs: 10_000 });
    expect(m.onTtlCheck(10_000)).toEqual([]);
    const actions = m.onTtlCheck(10_001);
    expect(sends(actions)[0]?.body.reason_code).toBe('expired');
    expect(m.rec.state).toBe('rejected');
  });

  it('心跳:seq 单调递增;回执续自身租约', () => {
    const m = mk();
    m.onOffer(offerInput());
    const h1 = sends(m.onHeartbeatDue(40_000))[0];
    expect(h1?.body.seq).toBe(1);
    m.onHeartbeatAcked(40_001);
    const h2 = sends(m.onHeartbeatDue(80_000))[0];
    expect(h2?.body.seq).toBe(2);
    expect(m.rec.leaseSelfDeadline).toBe(40_001 + 120_000);
  });

  it('R5 赛跑 A:先完成 → result;后到 cancel → ack(completed_before_cancel)', () => {
    const m = mk();
    m.onOffer(offerInput());
    m.onDriverCompleted({ summary: '做完了' });
    expect(m.rec.state).toBe('result_sent');
    const actions = m.onCancel(A, 1);
    expect(sends(actions)[0]?.type).toBe('task.cancel.ack');
    expect(sends(actions)[0]?.body.completed_before_cancel).toBe(true);
  });

  it('R5 赛跑 B:执行中收到 cancel → 停驱动 + ack;驱动随后完成不再发 result', () => {
    const m = mk();
    m.onOffer(offerInput());
    const actions = m.onCancel(A, 1);
    expect(actions.some((a) => a.kind === 'stopDriver')).toBe(true);
    expect(sends(actions).some((x) => x.type === 'task.cancel.ack')).toBe(true);
    expect(m.rec.state).toBe('stopped');
    expect(m.onDriverCompleted({ summary: '迟到的完成' })).toEqual([]);
  });

  it('R0③:更高 attempt 的同 task offer → 隐式取消旧态 → 评估新单', () => {
    const m = mk();
    m.onOffer(offerInput(1));
    m.onHeartbeatDue(40_000);
    const actions = m.onOffer(
      offerInput(2, { kind: 'aid', summary: '改派回原节点:参数已修正', lease_ms: 120000, offer_ttl_ms: 10000 }, 1_000),
    );
    const msgs = sends(actions);
    expect(msgs[0]?.type).toBe('task.reject');
    expect(msgs[0]?.body.reason_code).toBe('stale_attempt');
    expect(msgs[0]?.attempt).toBe(1);
    expect(msgs[1]?.type).toBe('task.accept');
    expect(msgs[1]?.attempt).toBe(2);
    expect(m.rec.state).toBe('running');
    expect(m.rec.attempt).toBe(2);
  });

  it('自身租约超时 → pauseDriver;暂停期间不发心跳', () => {
    const m = mk();
    m.onOffer(offerInput());
    const actions = m.onLeaseSelfTimeout(120_001);
    expect(actions.some((a) => a.kind === 'pauseDriver')).toBe(true);
    expect(m.rec.paused).toBe(true);
    expect(m.onHeartbeatDue(120_002)).toEqual([]);
  });

  it('驱动失败 → fail_sent;收到 reject(stale_attempt) → 清理终态', () => {
    const m = mk();
    m.onOffer(offerInput());
    const actions = m.onDriverFailed({ reason_code: 'caps_missing', retryable: true, summary: '环境漂移' });
    expect(sends(actions)[0]?.type).toBe('task.fail');
    expect(m.rec.state).toBe('fail_sent');

    const m2 = mk();
    m2.onOffer(offerInput());
    const actions2 = m2.onStaleReject();
    expect(actions2.some((a) => a.kind === 'stopDriver')).toBe(true);
    expect(m2.rec.state).toBe('cleaned');
  });
});