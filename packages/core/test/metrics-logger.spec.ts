import { describe, expect, it } from 'vitest';
import { NodeMetrics, logTaskEvent, makeJsonLogger } from '../src/index.js';

/** 01 §11:最小指标集 + 日志关联规范(强制四字段) */
describe('NodeMetrics(01 §11 最小集)', () => {
  it('lost/drain/escalate 计数与 attempt 分布', () => {
    const m = new NodeMetrics();
    m.onLost();
    m.onLost();
    m.onDrainHit();
    m.onEscalate();
    m.onTerminal(1);
    m.onTerminal(2);
    m.onTerminal(2);
    const s = m.snapshot();
    expect(s.lostCount).toBe(2);
    expect(s.drainHits).toBe(1);
    expect(s.escalateCount).toBe(1);
    expect(s.attemptDistribution).toEqual({ '1': 1, '2': 2 });
  });

  it('reject/fail reason 直方图', () => {
    const m = new NodeMetrics();
    m.onReject('busy');
    m.onReject('busy');
    m.onReject('unsupported_caps');
    m.onFail('caps_missing');
    const s = m.snapshot();
    expect(s.rejectReasons).toEqual({ busy: 2, unsupported_caps: 1 });
    expect(s.failReasons).toEqual({ caps_missing: 1 });
  });

  it('心跳抖动:相邻间隔与最大间隔', () => {
    const m = new NodeMetrics();
    m.onHeartbeatAcked(1_000);
    m.onHeartbeatAcked(1_100); // 100ms
    m.onHeartbeatAcked(1_250); // 150ms
    const s = m.snapshot();
    expect(s.heartbeat.samples).toBe(3);
    expect(s.heartbeat.lastIntervalMs).toBe(150);
    expect(s.heartbeat.maxIntervalMs).toBe(150);
  });
});

describe('logTaskEvent(01 §11 日志关联规范)', () => {
  it('四字段齐全 → JSON 行输出', () => {
    const lines: string[] = [];
    const logger = makeJsonLogger((l) => lines.push(l));
    logTaskEvent(logger, 'info', 'task.offer 已接收', {
      trace_id: 't', task_id: 'k', attempt: 1, msg_id: 'm',
    });
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed.level).toBe('info');
    expect(parsed.trace_id).toBe('t');
    expect(parsed.task_id).toBe('k');
    expect(parsed.attempt).toBe(1);
    expect(parsed.msg_id).toBe('m');
  });

  it('缺任一强制字段 → 直接抛错(违规在开发期暴露)', () => {
    const logger = makeJsonLogger(() => undefined);
    expect(() =>
      logTaskEvent(logger, 'info', 'x', { trace_id: 't', task_id: 'k', attempt: 1 } as never),
    ).toThrow(/msg_id/);
  });
});
