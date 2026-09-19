import { describe, expect, it } from 'vitest';
import { newId } from '@qlong/core';
import { LeadTaskMachine, type LeadAction } from '../src/lead/machine.js';

const TASK = '66666666-6666-4666-8666-666666666666';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '44444444-4444-4444-8444-444444444444';

function mk(): LeadTaskMachine {
  // 本文件验证 R 系列转移语义;PROJECT 无验证器的缺省拒绝已由 machine-safety.spec 固化。
  return new LeadTaskMachine({
    task_id: TASK,
    kind: 'project',
    validateAcceptance: (b) => {
      const arr = b.acceptance_results;
      if (!Array.isArray(arr)) return true;
      return arr.every((x) => (x as { pass?: boolean } | null)?.pass !== false);
    },
  });
}
function offerBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'project', summary: 's', lease_ms: 300000, offer_ttl_ms: 60000, ...over };
}
function sends(actions: LeadAction[]) {
  return actions.filter((a): a is Extract<LeadAction, { kind: 'send' }> => a.kind === 'send').map((a) => a.msg);
}
function dispatched(actions: LeadAction[]) {
  return actions.filter((a): a is Extract<LeadAction, { kind: 'requestDispatch' }> => a.kind === 'requestDispatch');
}

describe('牵头方状态机:正常主路径(§5.3)', () => {
  it('offer→accept→progress 续租→result 验收通过→done', () => {
    const m = mk();
    const actions = m.dispatchTo(B, offerBody(), 0);
    expect(m.rec.state).toBe('offered');
    expect(m.rec.attempt).toBe(1);
    expect(sends(actions)[0]?.type).toBe('task.offer');

    m.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 100);
    expect(m.rec.state).toBe('running');
    expect(m.rec.leaseDeadline).toBe(100 + 230000); // lost = 2×(300s/3)+30s(R3)

    const acts = m.onMessage('task.progress', B, 1, { state: 'working', seq: 1 }, 200_000);
    expect(m.rec.leaseDeadline).toBe(200_000 + 230_000);
    expect(acts.some((a) => a.kind === 'schedule' && a.timer === 'lease')).toBe(true);

    m.onMessage('task.result', B, 1, { status: 'done', summary: 'ok' }, 300_000);
    expect(m.rec.state).toBe('done');
    expect(m.terminal).toBe(true);
  });

  it('A3:验收失败 → cancel(acceptance_failed) → drain → 改派 attempt+1', () => {
    const m = mk();
    m.dispatchTo(B, offerBody(), 0);
    m.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 100);
    const actions = m.onMessage(
      'task.result',
      B,
      1,
      { status: 'done', acceptance_results: [{ check: 'x', pass: false }] },
      200,
    );
    expect(m.rec.state).toBe('reclaiming');
    expect(sends(actions)[0]?.body).toEqual({ reason: 'acceptance_failed' });
    const afterDrain = m.onTimer('drain', 200 + 30_000);
    expect(m.rec.acceptedFailedBudget).toBe(1);
    expect(dispatched(afterDrain)[0]?.nextAttempt).toBe(2);
  });
});

describe('牵头方状态机:R4/R7/R8/D25', () => {
  it('fail(retryable) → 先撤销后改派:cancel 先入通道,drain 后 requestDispatch', () => {
    const m = mk();
    m.dispatchTo(B, offerBody(), 0);
    m.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 0);
    const actions = m.onMessage('task.fail', B, 1, { reason_code: 'internal_error', retryable: true, summary: 'x' }, 100);
    expect(m.rec.state).toBe('reclaiming');
    const msgs = sends(actions);
    expect(msgs[0]?.type).toBe('task.cancel');
    expect(msgs[0]?.body).toEqual({ reason: 'reclaim' });
    const afterDrain = m.onTimer('drain', 100 + 30_000);
    expect(m.rec.acceptedFailedBudget).toBe(1);
    expect(dispatched(afterDrain)[0]?.nextAttempt).toBe(2);
  });

  it('fail(retryable=false) → 立即 failed,不烧 attempt(R7)', () => {
    const m = mk();
    m.dispatchTo(B, offerBody(), 0);
    m.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 0);
    m.onMessage('task.fail', B, 1, { reason_code: 'unsupported_caps', retryable: false, summary: 'x' }, 100);
    expect(m.rec.state).toBe('failed');
    expect(m.rec.acceptedFailedBudget).toBe(0);
  });

  it('判 lost → reclaim 审计 + cancel;drain 窗口内 result → done(赛跑,R4/R5)', () => {
    const m = mk();
    m.dispatchTo(B, offerBody(), 0);
    m.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 0);
    const actions = m.onTimer('lease', 230_000);
    expect(m.rec.state).toBe('reclaiming');
    expect(actions.some((a) => a.kind === 'audit' && a.event === 'reclaim')).toBe(true);
    m.onMessage('task.result', B, 1, { status: 'done', summary: '恰好做完' }, 240_000);
    expect(m.rec.state).toBe('done');
  });

  it('expired/lost 静默目标进排除表(R8/T6):重派必须避开失联节点', () => {
    // 过期路径:offer TTL 到期,target 从未接受 —— 同机演练发现死节点被反复选中(走查 §6.0)
    const m1 = mk();
    m1.dispatchTo(B, offerBody(), 0);
    m1.onTimer('offer_ttl', 60_001);
    m1.onTimer('drain', 60_001 + 30_000);
    expect(m1.rec.excluded[B]).toBe('once');

    // lost 路径:接受后租约死线无心跳(执行方静默)
    const m2 = mk();
    m2.dispatchTo(C, offerBody(), 0);
    m2.onMessage('task.accept', C, 1, { lease_ms: 300000 }, 0);
    m2.onTimer('lease', 230_000);
    m2.onTimer('drain', 230_000 + 30_000);
    expect(m2.rec.excluded[C]).toBe('once');
  });

  it('expired → 也先撤销后改派(R2/R4,评审 I-08);从未接受计 dispatch_rounds', () => {
    const m = mk();
    m.dispatchTo(B, offerBody(), 0);
    m.onTimer('offer_ttl', 60_001);
    expect(m.rec.state).toBe('reclaiming');
    const actions = m.onTimer('drain', 60_001 + 30_000);
    expect(m.rec.dispatchRounds).toBe(1);
    expect(m.rec.acceptedFailedBudget).toBe(0);
    expect(dispatched(actions)[0]?.nextAttempt).toBe(2);
  });

  it('reject(busy,retry_after) → 不排除;dispatch_rounds 耗尽(max=3)→ escalate(§11 结构化)', () => {
    const m = mk();
    m.dispatchTo(B, offerBody(), 0);
    m.onMessage('task.reject', B, 1, { reason_code: 'busy', retryable: true, retry_after_ms: 5000 }, 10);
    expect(m.rec.excluded[B]).toBeUndefined();
    expect(m.redispatchTo(C, offerBody(), 20).length).toBeGreaterThan(0);
    m.onMessage('task.reject', C, 2, { reason_code: 'busy', retryable: true, retry_after_ms: 5000 }, 30);
    expect(m.redispatchTo(A, offerBody(), 40).length).toBeGreaterThan(0);
    m.onMessage('task.reject', A, 3, { reason_code: 'busy', retryable: true, retry_after_ms: 5000 }, 50);
    expect(m.rec.state).toBe('escalated');
    expect(m.terminal).toBe(true);
  });

  it('R0:迟到旧 attempt 消息 → reject(stale_attempt) 回执 + 审计', () => {
    const m = mk();
    m.dispatchTo(B, offerBody(), 0);
    m.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 0);
    const actions = m.onMessage('task.result', B, 0, { status: 'done' }, 50);
    const msgs = sends(actions);
    expect(msgs[0]?.type).toBe('task.reject');
    expect(msgs[0]?.body.reason_code).toBe('stale_attempt');
    expect(actions.some((a) => a.kind === 'audit' && a.event === 'stale_attempt_rejected')).toBe(true);
  });

  it('用户取消:cancelling→ack→closed;超时→强制 closed(I-06);竞态 result→done', () => {
    const m = mk();
    m.dispatchTo(B, offerBody(), 0);
    m.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 0);
    const actions = m.cancelByUser(1_000);
    expect(m.rec.state).toBe('cancelling');
    expect(sends(actions)[0]?.type).toBe('task.cancel');
    m.onMessage('task.cancel.ack', B, 1, {}, 1_100);
    expect(m.rec.state).toBe('closed');

    const m2 = mk();
    m2.dispatchTo(B, offerBody(), 0);
    m2.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 0);
    m2.cancelByUser(1_000);
    m2.onTimer('cancel_wait', 31_000);
    expect(m2.rec.state).toBe('closed');

    const m3 = mk();
    m3.dispatchTo(B, offerBody(), 0);
    m3.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 0);
    m3.cancelByUser(1_000);
    m3.onMessage('task.result', B, 1, { status: 'done', summary: '抢在取消前完成' }, 1_050);
    expect(m3.rec.state).toBe('done');
  });
});

describe('牵头方状态机:R3 业务续租生产半(B2a)', () => {
  it('running 收到带 msg_id 的 v2 task.progress → 回发 task.lease.renew(fence/progress 绑定 + 单调 renewal_seq + now+lease 死线)', () => {
    const m = mk();
    m.dispatchTo(B, offerBody(), 0);
    m.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 100);
    const progressMsgId = newId();
    const runId = newId();
    const acts = m.onMessage(
      'task.progress', B, 1, { state: 'working', seq: 1, generation: 7, run_id: runId }, 200_000, progressMsgId,
    );
    const renew = sends(acts).find((s) => s.type === 'task.lease.renew');
    expect(renew).toBeDefined();
    expect(renew!.to_node).toBe(B);
    expect(renew!.task_id).toBe(TASK);
    expect(renew!.attempt).toBe(1);
    expect(renew!.reply_to).toBe(progressMsgId);
    // 业务续租死线 = now + leaseMs(执行方 maxLeaseMs 上限),与本地 lost 死线(lostAfterMs)分离
    expect(renew!.body).toEqual({
      generation: 7, run_id: runId, progress_msg_id: progressMsgId, progress_seq: 1,
      renewal_seq: 1, deadline_ms: 200_000 + 300_000,
    });
    // 仍重置本地 lost 死线并重排 lease 定时器(R3/评审 M1-DIST-1)
    expect(m.rec.leaseDeadline).toBe(200_000 + 230_000);
    expect(acts.some((a) => a.kind === 'schedule' && a.timer === 'lease')).toBe(true);
    // renewal_seq 跨多条 progress 严格单调递增
    const acts2 = m.onMessage(
      'task.progress', B, 1, { state: 'working', seq: 2, generation: 7, run_id: runId }, 210_000, newId(),
    );
    expect(sends(acts2).find((s) => s.type === 'task.lease.renew')!.body.renewal_seq).toBe(2);
    expect(m.rec.renewalSeq).toBe(2);
  });

  it('task.progress 缺 msg_id 或缺 v2 fence(legacy)→ 只续本地死线,不发 task.lease.renew', () => {
    const m = mk();
    m.dispatchTo(B, offerBody(), 0);
    m.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 100);
    // 无 msg_id(legacy 调用方 5 参):即便 body 带 fence 也不发
    const noMsgId = m.onMessage(
      'task.progress', B, 1, { state: 'working', seq: 1, generation: 7, run_id: newId() }, 200_000,
    );
    expect(sends(noMsgId).some((s) => s.type === 'task.lease.renew')).toBe(false);
    // 有 msg_id 但 body 无 v2 fence(v1 progress):不发
    const noFence = m.onMessage('task.progress', B, 1, { state: 'working', seq: 1 }, 200_000, newId());
    expect(sends(noFence).some((s) => s.type === 'task.lease.renew')).toBe(false);
    expect(m.rec.renewalSeq).toBe(0);
    expect(m.rec.leaseDeadline).toBe(200_000 + 230_000);
  });
});

describe('牵头方状态机:owner 强制改派 redispatchByOwner(E3/OWNER-COMMAND §4.4)', () => {
  it('running → 排除当前 target(once) + 先撤销(task.cancel reason:reclaim)后改派 + 记 owner_redispatch 历史', () => {
    const m = mk();
    m.dispatchTo(B, offerBody(), 0);
    m.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 0);
    expect(m.rec.state).toBe('running');
    const actions = m.redispatchByOwner(1_000);
    expect(m.rec.state).toBe('reclaiming');
    expect(m.rec.excluded[B]).toBe('once');
    expect(m.rec.history.at(-1)).toMatchObject({ node: B, attempt: 1, outcome: 'owner_redispatch' });
    const msgs = sends(actions);
    expect(msgs[0]?.type).toBe('task.cancel');
    expect(msgs[0]?.body).toEqual({ reason: 'reclaim' });
  });

  it('running 改派 → drain 到期烧 acceptedFailedBudget → drafting + requestDispatch(attempt+1)', () => {
    const m = mk();
    m.dispatchTo(B, offerBody(), 0);
    m.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 0);
    m.redispatchByOwner(1_000);
    expect(m.rec.excluded[B]).toBe('once');
    const afterDrain = m.onTimer('drain', 1_000 + 30_000);
    expect(m.rec.acceptedFailedBudget).toBe(1); // §4.4:复用 reclaim 路径,running→已接受烧 acceptedFailedBudget
    expect(m.rec.state).toBe('drafting');
    expect(dispatched(afterDrain)[0]?.nextAttempt).toBe(2);
  });

  it('offered(未接受)改派 → reclaiming;drain 后烧 dispatchRounds(非 acceptedFailedBudget)', () => {
    const m = mk();
    m.dispatchTo(B, offerBody(), 0);
    expect(m.rec.state).toBe('offered');
    const actions = m.redispatchByOwner(1_000);
    expect(m.rec.state).toBe('reclaiming');
    expect(m.rec.excluded[B]).toBe('once');
    expect(sends(actions)[0]?.body).toEqual({ reason: 'reclaim' });
    const afterDrain = m.onTimer('drain', 1_000 + 30_000);
    expect(m.rec.dispatchRounds).toBe(1);
    expect(m.rec.acceptedFailedBudget).toBe(0);
    expect(dispatched(afterDrain)[0]?.nextAttempt).toBe(2);
  });

  it('drafting(等待重派)改派 → 排除当前 target + requestDispatch,不重复撤销/不追加历史/不改状态', () => {
    const m = mk();
    m.dispatchTo(B, offerBody(), 0);
    m.onTimer('offer_ttl', 60_001);
    m.onTimer('drain', 60_001 + 30_000);
    expect(m.rec.state).toBe('drafting');
    expect(m.rec.target).toBe(B);
    const historyLen = m.rec.history.length;
    const actions = m.redispatchByOwner(100_000);
    expect(m.rec.state).toBe('drafting'); // drafting 分支不改状态(等选择器)
    expect(m.rec.excluded[B]).toBe('once');
    expect(dispatched(actions)[0]?.nextAttempt).toBe(2);
    expect(sends(actions)).toEqual([]); // 不重复发 task.cancel
    expect(m.rec.history.length).toBe(historyLen);
  });

  it('cancelling 改派 → no-op(用户取消优先,不被改派覆盖,不排除 target)', () => {
    const m = mk();
    m.dispatchTo(B, offerBody(), 0);
    m.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 0);
    m.cancelByUser(500);
    expect(m.rec.state).toBe('cancelling');
    expect(m.redispatchByOwner(1_000)).toEqual([]);
    expect(m.rec.state).toBe('cancelling');
    expect(m.rec.excluded[B]).toBeUndefined();
  });

  it('已 reclaiming 改派 → no-op(§1.7 at-least-once 幂等:重拉不重复撤销/不重复追加历史)', () => {
    const m = mk();
    m.dispatchTo(B, offerBody(), 0);
    m.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 0);
    m.redispatchByOwner(1_000); // running→reclaiming,excluded[B] 已置,历史已追加一条
    expect(m.rec.state).toBe('reclaiming');
    expect(m.redispatchByOwner(2_000)).toEqual([]);
    expect(m.rec.state).toBe('reclaiming');
    expect(m.rec.history.filter((h) => h.outcome === 'owner_redispatch')).toHaveLength(1);
  });

  it('终态(done)改派 → no-op', () => {
    const m = mk();
    m.dispatchTo(B, offerBody(), 0);
    m.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 0);
    m.onMessage('task.result', B, 1, { status: 'done', summary: 'ok' }, 100);
    expect(m.rec.state).toBe('done');
    expect(m.redispatchByOwner(1_000)).toEqual([]);
    expect(m.rec.state).toBe('done');
  });
});