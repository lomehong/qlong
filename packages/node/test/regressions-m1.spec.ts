import { describe, expect, it } from 'vitest';
import { checkpointLeadMachine, pendingTimers } from '../src/lead/checkpoint.js';
import { LeadTaskMachine } from '../src/lead/machine.js';
import { ExecutorMachine, type ExecAction } from '../src/executor/machine.js';
import { SingleNodeHarness } from '../src/local/harness.js';

const TASK = '66666666-6666-4666-8666-666666666666';
const B = '22222222-2222-4222-8222-222222222222';
const BODY = { kind: 'project', summary: 's', lease_ms: 300000, offer_ttl_ms: 60000 };

function execOffer(over: Record<string, unknown> = {}) {
  return {
    from: B,
    task_id: TASK,
    attempt: 1,
    msg_id: '77777777-7777-4777-8777-777777777777',
    body: { kind: 'aid', summary: 's', lease_ms: 120000, offer_ttl_ms: 10000 },
    now: 0,
    ...over,
  };
}

describe('M1 评审 P0 回归', () => {
  it('DIST-1:心跳续租取消旧 lease 定时器 —— 健康长任务跨 230s 不误判', () => {
    const m = new LeadTaskMachine({ task_id: TASK, kind: 'project' });
    m.dispatchTo(B, BODY, 0);
    m.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 0);
    m.onMessage('task.progress', B, 1, { seq: 1 }, 100_000);
    m.onMessage('task.progress', B, 1, { seq: 2 }, 200_000);
    m.onTimer('lease', 230_000); // 泄漏的旧定时器若未取消,此处误判 lost
    expect(m.rec.state).toBe('running');
    m.onMessage('task.progress', B, 1, { seq: 3 }, 300_000);
    m.onTimer('lease', 430_000);
    expect(m.rec.state).toBe('running');
    m.onMessage('task.result', B, 1, { status: 'done', summary: 'ok' }, 500_000);
    expect(m.rec.state).toBe('done');
  });

  it('QA:reclaiming 赛跑窗口收到的 result 仍须过验收(不得绕线 done)', () => {
    const m = new LeadTaskMachine({
      task_id: TASK,
      kind: 'project',
      validateAcceptance: (b) => b.summary !== 'bad',
    });
    m.dispatchTo(B, BODY, 0);
    m.onMessage('task.accept', B, 1, { lease_ms: 300000 }, 0);
    m.onMessage('task.fail', B, 1, { reason_code: 'internal_error', retryable: true, summary: 'x' }, 100);
    m.onMessage('task.result', B, 1, { status: 'done', summary: 'bad' }, 200);
    expect(m.rec.state).toBe('reclaiming');
    const actions = m.onTimer('drain', 30_100);
    expect(m.rec.acceptedFailedBudget).toBe(1);
    expect(actions.some((a) => a.kind === 'requestDispatch')).toBe(true);
  });

  it('API-1:exp 过期的补投 offer → reject(expired)(R2/D24)', () => {
    const m = new ExecutorMachine({ capabilities: () => ['tool:node@20'] });
    const actions = m.onOffer(execOffer({ now: Date.parse('2026-09-06T12:00:00Z'), exp: '2026-09-06T11:00:00Z' }));
    const send = actions.find((a): a is Extract<ExecAction, { kind: 'send' }> => a.kind === 'send');
    expect((send?.msg.body as { reason_code?: string }).reason_code).toBe('expired');
  });

  it('ARCH-2:执行中收到异任务 offer → busy(不覆盖,旧任务可撤销)', () => {
    const m = new ExecutorMachine({ capabilities: () => [] });
    m.onOffer(execOffer());
    const actions = m.onOffer(
      execOffer({
        task_id: '99999999-9999-4999-8999-999999999999',
        msg_id: '88888888-8888-4888-8888-888888888888',
        now: 100,
      }),
    );
    const send = actions.find((a): a is Extract<ExecAction, { kind: 'send' }> => a.kind === 'send');
    expect((send?.msg.body as { reason_code?: string }).reason_code).toBe('busy');
    expect(m.rec.task_id).toBe(TASK);
  });

  it('DIST:租约超时暂停 → 暂停期不发心跳;回执到达 → resume;恢复后正常交付', () => {
    const m = new ExecutorMachine({ capabilities: () => [] });
    m.onOffer(execOffer());
    m.onLeaseSelfTimeout(120_001);
    expect(m.rec.paused).toBe(true);
    expect(m.onHeartbeatDue(120_002)).toEqual([]);
    const resume = m.onHeartbeatAcked(130_000);
    expect(resume.some((a) => a.kind === 'resumeDriver')).toBe(true);
    expect(m.rec.paused).toBe(false);
    const done = m.onDriverCompleted({ summary: '恢复后完成' });
    const send = done.find((a): a is Extract<ExecAction, { kind: 'send' }> => a.kind === 'send');
    expect(send?.msg.type).toBe('task.result');
  });

  it('DIST:暂停后驱动才完成 → 不发 result 回 ack(R5 租约超时自检)', () => {
    const m = new ExecutorMachine({ capabilities: () => [] });
    m.onOffer(execOffer());
    m.onLeaseSelfTimeout(120_001);
    const actions = m.onDriverCompleted({ summary: '暂停后才完成' });
    const send = actions.find((a): a is Extract<ExecAction, { kind: 'send' }> => a.kind === 'send');
    expect(send?.msg.type).toBe('task.cancel.ack');
    expect(m.rec.state).toBe('stopped');
  });

  it('ARCH-1/QA-5:接管恢复重挂定时器 → lost 照常触发 → 改派兜底完成(attempt=2)', () => {
    const h1 = new SingleNodeHarness({ taskId: TASK, kind: 'project', script: { completeAfterMs: 999_999 } });
    h1.startTask();
    h1.advanceTo(100_000);
    const blob = checkpointLeadMachine(h1.lead);
    expect(h1.lead.rec.state).toBe('running');

    const h2 = new SingleNodeHarness({ taskId: TASK, kind: 'project', script: { completeAfterMs: 500_000 } });
    h2.adoptRestoredLead(blob);
    expect(pendingTimers(h2.lead).some((t) => t.timer === 'lease')).toBe(true);
    h2.advanceTo(900_000);
    expect(h2.lead.rec.state).toBe('done');
    expect(h2.lead.rec.attempt).toBe(2);
  });

  it('QA-5:接管时 drafting 意图恢复 → 自动重新派发(offered, attempt+1)', () => {
    const m1 = new LeadTaskMachine({ task_id: TASK, kind: 'project' });
    m1.dispatchTo(B, BODY, 0);
    m1.onMessage('task.reject', B, 1, { reason_code: 'busy', retryable: true }, 100);
    expect(m1.rec.state).toBe('drafting');
    const blob = checkpointLeadMachine(m1);

    const h2 = new SingleNodeHarness({ taskId: TASK, kind: 'project', script: { completeAfterMs: 1_000 } });
    h2.adoptRestoredLead(blob);
    // 恢复后立即重新派发;单机总线中执行方同步接单 → running
    expect(h2.lead.rec.state).toBe('running');
    expect(h2.lead.rec.attempt).toBe(2);
  });
});