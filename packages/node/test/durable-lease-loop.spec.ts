import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PARAMS, lostAfterMs, newId, type EnvelopeV1 } from '@qlong/core';
import type { FencedDriver, RunFence, RunHandle, RunOutcome } from '../src/driver/run-handle.js';
import { DurableExecutor } from '../src/runtime/executor.js';
import { DurableLead } from '../src/runtime/lead.js';
import { NodeRuntimeStore } from '../src/runtime/store.js';
import type { Outbound } from '../src/wire.js';
import { env, fixture, LOCAL, open } from './runtime-store-helpers.js';

/**
 * B2c:端到端业务续租闭环。两个真实持久组件(牵头方 DurableLead 生产半 + 执行方 DurableExecutor 消费半)
 * 各自独立的 store,通过手动中继信封(不经网关,规避 teardown flaky)串成一条闭环:
 *   offer → accept → (跨心跳)progress → task.lease.renew → 执行方业务租约死线延长。
 * 两半均已被各自单测固化(durable-lead.spec.ts B2a / durable-executor.spec.ts),本文件证明它们经
 * canApplyLeaseRenewal 契约真实互操作,并验证延长后的死线跨 store 重开持久——多网关/进程接续所依赖的
 * 唯一事实基础(接续不需要任何专门的网关租约逻辑,只读执行方持久 leaseDeadline)。
 */
const TEAM = 'lease-loop-team';
const LEAD = LOCAL; // 牵头方节点 = 其 store owner
const EXEC = '20000000-0000-4000-8000-000000000009'; // 执行方节点 = 其 store owner
const EPOCH = Date.parse('2026-09-16T12:00:00Z');
const LEASE_MS = 900; // 执行方 capped 业务租约;accept 后牵头方 rec.leaseMs 与之对齐
const HEARTBEAT_MS = Math.floor(LEASE_MS / 3); // 执行方首个心跳偏移(=300)
let now = EPOCH;

/** 极简 fenced driver:start 立即返回一个 closed 永不兑现的句柄(运行保持存活),recover 恒 unknown。 */
class StubDriver implements FencedDriver {
  readonly fences: RunFence[] = [];
  async start(fence: Readonly<RunFence>): Promise<RunHandle> {
    this.fences.push({ ...fence });
    const closed = new Promise<RunOutcome>(() => { /* 永不兑现:本闭环不结束运行 */ });
    return Object.freeze({ fence, closed, stop: async () => {} });
  }
  async recover(): Promise<'stopped' | 'unknown'> { return 'unknown'; }
}

/** 出站签名:from = 本侧节点,team_id 必须与对端 teamId 一致(对端 consume 的 allowed 判据)。 */
function sealAs(nodeId: string) {
  return (out: Outbound): EnvelopeV1 => env({
    type: out.type, ts: new Date(now).toISOString(), exp: new Date(now + 60_000).toISOString(),
    from: { node_id: nodeId, team_id: TEAM, key_epoch: 1 }, to: { node_id: out.to_node, team_id: TEAM },
    task_id: out.task_id!, attempt: out.attempt!, ...(out.reply_to ? { reply_to: out.reply_to } : {}), body: out.body,
  });
}
const sealLead = sealAs(LEAD);
const sealExec = sealAs(EXEC);

const offerBody = (): Record<string, unknown> =>
  ({ kind: 'aid', summary: 'trusted embedded work', lease_ms: LEASE_MS, offer_ttl_ms: 300 });

/** 建双 store + 双组件 + 中继助手,并驱动到执行方 running(offer 已 accept、driver 已 start)。 */
async function setupLoop() {
  const leadFx = fixture({}, LEAD);
  const execFx = fixture({}, EXEC);
  const driver = new StubDriver();
  const lead = new DurableLead({ store: leadFx.runtime, nodeId: LEAD, teamId: TEAM, seal: sealLead });
  const executor = new DurableExecutor({ store: execFx.runtime, nodeId: EXEC, teamId: TEAM, seal: sealExec, driver });
  await executor.recover(); // ready 门:未 recover 前拒绝一切 offer(busy)
  const leadOut = (type: string): EnvelopeV1[] =>
    leadFx.runtime.all().map((i) => i.envelope).filter((i) => i.type === type);
  const execOut = (type: string): EnvelopeV1[] =>
    execFx.runtime.all().map((i) => i.envelope).filter((i) => i.type === type);
  const toExec = (input: EnvelopeV1): void => {
    expect(['new', 'duplicate']).toContain(execFx.runtime.receive(input));
    executor.consume(input, true);
  };
  const toLead = (input: EnvelopeV1): void => {
    expect(['new', 'duplicate']).toContain(leadFx.runtime.receive(input));
    lead.consume(input, true);
  };
  return { leadFx, execFx, driver, lead, executor, leadOut, execOut, toExec, toLead };
}

/** 从发起一路驱动到“首次续租已被执行方应用”,返回闭环关键产物。 */
async function driveToAppliedRenewal() {
  const ctx = await setupLoop();
  const taskId = newId();
  ctx.lead.originate(taskId, 'aid');
  ctx.lead.dispatch(taskId, EXEC, offerBody());
  ctx.toExec(ctx.leadOut('task.offer')[0]!); // 牵头方 offer → 执行方
  await ctx.executor.settle(); // prepared → starting → running(driver.start)
  ctx.toLead(ctx.execOut('task.accept')[0]!); // 执行方 accept → 牵头方 running
  const originalDeadline = ctx.executor.snapshot().slot!.leaseDeadline; // = EPOCH + LEASE_MS(accept 时设定)
  now += HEARTBEAT_MS; // 跨首个心跳阈值
  ctx.executor.tick(now); // 执行方发 task.progress(seq 1)
  const progress = ctx.execOut('task.progress')[0]!;
  ctx.toLead(progress); // progress → 牵头方(触发生产半回发续租)
  const renew = ctx.leadOut('task.lease.renew')[0]!;
  ctx.toExec(renew); // 续租 → 执行方(消费半经 canApplyLeaseRenewal 应用)
  return { ...ctx, taskId, progress, renew, originalDeadline };
}

beforeEach(() => { now = EPOCH; vi.spyOn(Date, 'now').mockImplementation(() => now); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('端到端业务续租闭环(B2c: executor progress → lead renew → executor 延时)', () => {
  it('牵头方把执行方 progress 的 fence/序号原样回绑成 task.lease.renew,执行方据此延长业务租约', async () => {
    const { lead, executor, renew, progress, taskId, originalDeadline } = await driveToAppliedRenewal();
    const slot = executor.snapshot().slot!;
    expect(renew).toMatchObject({
      type: 'task.lease.renew', to: { node_id: EXEC }, task_id: taskId, attempt: 1, reply_to: progress.msg_id,
    });
    // 生产半回绑执行方 fence(generation/run_id)+ progress 身份(msg_id/seq),renewal_seq 从 1 起,
    // deadline_ms = now + 执行方实际 leaseMs(与牵头方本地 lost 死线分离)。
    expect(renew.body).toEqual({
      generation: slot.fence.generation, run_id: slot.fence.run_id,
      progress_msg_id: progress.msg_id, progress_seq: 1, renewal_seq: 1,
      deadline_ms: EPOCH + HEARTBEAT_MS + LEASE_MS,
    });
    expect(lead.snapshot(taskId)?.renewalSeq).toBe(1);
    // 消费半应用:业务租约死线延长、待确认 progress 清空、续租序号记账。
    expect(executor.snapshot().slot).toMatchObject({
      leaseDeadline: EPOCH + HEARTBEAT_MS + LEASE_MS, lastRenewalSeq: 1, seq: 1, progress: null,
    });
    expect(executor.snapshot().slot!.leaseDeadline).toBeGreaterThan(originalDeadline);
    // 牵头方本地回收死线走 lostAfterMs(较长),与它授予执行方的业务租约(now+leaseMs)刻意分离。
    expect(lead.snapshot(taskId)?.leaseDeadline).toBe(EPOCH + HEARTBEAT_MS + lostAfterMs(LEASE_MS, DEFAULT_PARAMS));
  });

  it('延长后的业务租约死线跨执行方 store 重开持久(多网关/进程接续的唯一事实基础)', async () => {
    const { execFx, executor } = await driveToAppliedRenewal();
    const extended = executor.snapshot().slot!.leaseDeadline;
    expect(extended).toBe(EPOCH + HEARTBEAT_MS + LEASE_MS);
    // 模拟网关/进程接续:关闭执行方 store,以同一 owner 重开,不经 recover() 直接读持久快照。
    execFx.store.close();
    const reopened = new NodeRuntimeStore(open({ ...execFx.options, mode: 'open' }), EXEC);
    const continued = new DurableExecutor({ store: reopened, nodeId: EXEC, teamId: TEAM, seal: sealExec, driver: new StubDriver() });
    expect(continued.snapshot().slot).toMatchObject({
      leaseDeadline: extended, lastRenewalSeq: 1, seq: 1, progress: null,
    });
  });
});
