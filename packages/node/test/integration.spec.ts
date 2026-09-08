import { describe, expect, it } from 'vitest';
import { SingleNodeHarness } from '../src/local/harness.js';

const TASK = '66666666-6666-4666-8666-666666666666';

describe('单机总线集成(A2 单机版种子)', () => {
  it('主路径:offer→accept→心跳续租→result→done,attempt=1,心跳>0', () => {
    const h = new SingleNodeHarness({ taskId: TASK, kind: 'project', script: { completeAfterMs: 150_000 } });
    h.startTask();
    h.advanceTo(160_000);
    expect(h.lead.rec.state).toBe('done');
    expect(h.lead.rec.attempt).toBe(1);
    expect(h.heartbeatCount).toBeGreaterThan(0);
    expect(h.exec.rec.lastSeq).toBe(h.heartbeatCount);
    expect(h.terminalState).toBe('done');
    expect(h.lead.rec.resultBody?.summary).toBe('stub 完成');
  });

  it('A4 种子:fail(retryable) → cancel+ack 提前收口 → 改派 attempt=2 → done', () => {
    const h = new SingleNodeHarness({
      taskId: TASK,
      kind: 'project',
      script: [
        { failAfter: { ms: 1_000, body: { reason_code: 'internal_error', retryable: true, summary: '瞬态错误' } } },
        { completeAfterMs: 2_000, resultBody: { summary: '第二次成功' } },
      ],
    });
    h.startTask();
    h.advanceTo(200_000);
    expect(h.lead.rec.state).toBe('done');
    expect(h.lead.rec.attempt).toBe(2);
    expect(h.lead.rec.acceptedFailedBudget).toBe(1);
    expect(h.audits.some((a) => a.event === 'reclaim')).toBe(true);
  });

  it('A4 种子:fail(retryable=false) → 立即 failed', () => {
    const h = new SingleNodeHarness({
      taskId: TASK,
      kind: 'project',
      script: { failAfter: { ms: 1_000, body: { reason_code: 'internal_error', retryable: false, summary: '不可重试' } } },
    });
    h.startTask();
    h.advanceTo(5_000);
    expect(h.lead.rec.state).toBe('failed');
    expect(h.lead.rec.attempt).toBe(1);
  });

  it('R7:连败三轮 → escalate(结构化摘要含历史)', () => {
    const h = new SingleNodeHarness({
      taskId: TASK,
      kind: 'project',
      script: { failAfter: { ms: 1_000, body: { reason_code: 'internal_error', retryable: true, summary: '连败' } } },
    });
    h.startTask();
    h.advanceTo(300_000);
    expect(h.lead.rec.state).toBe('escalated');
    expect(h.escalateSummary?.attempts.length).toBeGreaterThanOrEqual(3);
    expect(h.audits.some((a) => a.event === 'escalate')).toBe(true);
  });

  it('用户取消:停驱动 + ack → closed;驱动完成被取消,不再发 result', () => {
    const h = new SingleNodeHarness({ taskId: TASK, kind: 'project', script: { completeAfterMs: 999_999 } });
    h.startTask();
    h.advanceTo(1_000);
    h.cancelTask();
    h.advanceTo(2_000);
    expect(h.lead.rec.state).toBe('closed');
    expect(h.exec.rec.state).toBe('stopped');
    h.advanceTo(1_100_000);
    expect(h.lead.rec.state).toBe('closed');
  });
});