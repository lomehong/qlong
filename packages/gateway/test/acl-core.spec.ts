import { describe, expect, it } from 'vitest';
import type { EnvelopeV1 } from '@qlong/core';
import { GatewayCore } from '../src/core.js';
import { evaluateUplink } from '../src/acl.js';
import type { GatewayDirectorySnapshot } from '../src/types.js';

const TEAM_X = '33333333-3333-4333-8333-333333333333';
const TEAM_Y = '34444444-4444-4444-8444-444444444444';
const A = '11111111-1111-4111-8111-111111111111'; // team X
const B = '22222222-2222-4222-8222-222222222222'; // team X
const V = '44444444-4444-4444-8444-444444444444'; // team Y(受害者)
const C = '55555555-5555-4555-8555-555555555555';

function snapshot(): GatewayDirectorySnapshot {
  return {
    epoch: 1,
    nodes: [
      { node_id: A, team_id: TEAM_X, status: 'active', currentEpoch: 1 },
      { node_id: B, team_id: TEAM_X, status: 'active', currentEpoch: 1 },
      { node_id: V, team_id: TEAM_Y, status: 'active', currentEpoch: 1 },
      { node_id: C, team_id: TEAM_X, status: 'active', currentEpoch: 1 },
    ],
  };
}

function envelope(over: Record<string, unknown> = {}, body: Record<string, unknown> = { kind: 'project', summary: 's' }): EnvelopeV1 {
  return {
    v: 1,
    type: 'task.offer',
    msg_id: '77777777-7777-4777-8777-777777777777',
    ts: '2026-09-06T12:00:00+08:00',
    exp: '2026-09-07T12:00:00+08:00',
    from: { node_id: B, team_id: TEAM_X, key_epoch: 1 },
    to: { node_id: C, team_id: TEAM_X },
    trace: { trace_id: '55555555-5555-4555-8555-555555555555', parent_span: null, origin_node: B },
    hops: 0,
    task_id: '66666666-6666-4666-8666-666666666666',
    attempt: 1,
    sig: { alg: 'ed25519', value: 'x' },
    body,
    ...over,
  } as EnvelopeV1;
}

function connectedCore(): GatewayCore {
  const core = new GatewayCore();
  core.setDirectory(snapshot());
  core.connect({ connId: 'c1', nodeId: B, teamId: TEAM_X, connectedAt: 0 });
  core.connect({ connId: 'c2', nodeId: C, teamId: TEAM_X, connectedAt: 0 });
  return core;
}

const dirLookup = { snapshotEpoch: 1, lookup: (id: string) => snapshot().nodes.find((n) => n.node_id === id) };

describe('A0 from 钉扎(D27/A6:伪造静默,无回执)', () => {
  it('自报 from.node_id 与连接身份不符 → 静默丢弃 + 审计', () => {
    const core = connectedCore();
    const r = core.uplink(B, envelope({ from: { node_id: A, team_id: TEAM_X, key_epoch: 1 } }), 100);
    expect(r.ack).toBeUndefined();
    expect(r.deliveries).toHaveLength(0);
    expect(r.audits[0]?.event).toBe('acl_rejected_from_pin');
  });

  it('自报 from.team_id 伪造 → 静默丢弃', () => {
    const core = connectedCore();
    const r = core.uplink(B, envelope({ from: { node_id: B, team_id: TEAM_Y, key_epoch: 1 } }), 100);
    expect(r.ack).toBeUndefined();
    expect(r.audits[0]?.event).toBe('acl_rejected_from_pin');
  });

  it('纯 ACL 裁决函数同判(与 core 引擎一致)', () => {
    const v = evaluateUplink({
      conn: { connId: 'c', nodeId: B, teamId: TEAM_X, connectedAt: 0 },
      head: {
        ...envelope({ from: { node_id: A, team_id: TEAM_X, key_epoch: 1 } }),
        envelope: envelope({ from: { node_id: A, team_id: TEAM_X, key_epoch: 1 } }),
      },
      dir: dirLookup,
    });
    expect(v.verdict).toBe('silent_drop');
  });
});

describe('A1 目录锚定(评审 I-13 确定性断言)', () => {
  it('I-13:伪造 to.team_id 的跨队穿透必须被网关拒绝 + routing.denied + 审计', () => {
    const core = connectedCore();
    // 攻击者(B@X)把 to.team_id 填成自己的 X,真实接收者是 Y 队的 V
    const r = core.uplink(B, envelope({ to: { node_id: V, team_id: TEAM_X } }), 100);
    expect(r.ack?.ack_type).toBe('rejected');
    expect(r.routingDenied?.rule).toBe('A1');
    expect(r.routingDenied?.reason_code).toBe('acl_rejected_cross_team');
    expect(r.audits[0]?.event).toBe('acl_rejected_cross_team');
    expect(r.deliveries).toHaveLength(0);
  });

  it('跨 team 直发(诚实训址)→ routing.denied(已认证发送方可见,A6)', () => {
    const core = connectedCore();
    const r = core.uplink(B, envelope({ to: { node_id: V } }), 100);
    expect(r.routingDenied?.rule).toBe('A1');
    expect(r.routingDenied?.reason_code).toBe('acl_rejected_cross_team');
  });

  it('接收方不在目录 → 失败关闭(P12),routing.denied', () => {
    const core = connectedCore();
    const r = core.uplink(B, envelope({ to: { node_id: '99999999-9999-4999-8999-999999999999' } }), 100);
    expect(r.routingDenied?.reason_code).toBe('not_team_member');
  });

  it('同队诚实投递 → route(在线 delivered)', () => {
    const core = connectedCore();
    const r = core.uplink(B, envelope(), 100);
    expect(r.ack).toEqual({ ack_type: 'delivered', msg_id: '77777777-7777-4777-8777-777777777777' });
    expect(r.deliveries[0]?.toNodeId).toBe(C);
  });
});

describe('A2 与管理断连(A6 close code)', () => {
  it('发送节点被 suspend(连接还在)→ not_active 拒绝 + routing.denied', () => {
    const core = connectedCore();
    core.setDirectory({
      epoch: 2,
      nodes: snapshot().nodes.map((n) => (n.node_id === B ? { ...n, status: 'suspended' as const } : n)),
    });
    const r = core.uplink(B, envelope(), 100);
    expect(r.routingDenied?.rule).toBe('A2');
    expect(r.routingDenied?.reason_code).toBe('not_active');
    expect(r.audits[0]?.event).toBe('not_active');
  });

  it('applyAdminEvent:revoke → 4002 断连;suspend → 4001;断连后 uplink 静默', () => {
    const core = connectedCore();
    core.disconnect(B);
    core.connect({ connId: 'c-b', nodeId: B, teamId: TEAM_X, connectedAt: 0 });
    const closed = core.applyAdminEvent(B, 'revoked');
    expect(closed).toEqual([{ nodeId: B, code: 4002, status: 'revoked' }]);
    expect(core.isConnected(B)).toBe(false);
    const r = core.uplink(B, envelope(), 100);
    expect(r.ack).toBeUndefined(); // A6 静默
    const c2 = connectedCore();
    c2.connect({ connId: 'c-b2', nodeId: B, teamId: TEAM_X, connectedAt: 0 });
    expect(c2.applyAdminEvent(B, 'suspended')).toEqual([{ nodeId: B, code: 4001, status: 'suspended' }]);
  });
});

describe('目录 epoch 缓存(§7.1,评审 I-45)', () => {
  it('epoch 落后的缓存条目自动重查:换队后旧 team 立即不可达', () => {
    const core = connectedCore();
    // B 先向 C 投递成功(缓存 B/C 条目 epoch=1)
    expect(core.uplink(B, envelope(), 0).ack?.ack_type).toBe('delivered');
    // join:C 换队到 Y(epoch 推进)
    core.setDirectory({
      epoch: 7,
      nodes: snapshot().nodes.map((n) => (n.node_id === C ? { ...n, team_id: TEAM_Y } : n)),
    });
    const r = core.uplink(B, envelope(), 100);
    expect(r.routingDenied?.reason_code).toBe('acl_rejected_cross_team');
  });
});

describe('回执帧与收件箱(01 §9/评审 I-11)', () => {
  it('aid 离线 → rejected(offline_not_stored),不暂存;project 离线 → queued', () => {
    const core = connectedCore();
    core.disconnect(C);
    const aid = core.uplink(B, envelope({}, { kind: 'aid', summary: 's' }), 100);
    expect(aid.ack).toEqual({ ack_type: 'rejected', msg_id: '77777777-7777-4777-8777-777777777777', reason: 'offline_not_stored' });
    const proj = core.uplink(B, envelope(), 100);
    expect(proj.ack?.ack_type).toBe('queued');
    expect(core.inbox.size(C)).toBe(1);
  });

  it('重连补投:project 补投;过期项剔除 + exp_rejected 审计(D24)', () => {
    const core = connectedCore();
    core.disconnect(C);
    core.uplink(B, envelope(), 100);
    // 虚拟时钟下的「过期」:exp 为极小绝对时刻,now=700_000 > exp + 漂移预算(600_000)
    core.uplink(B, envelope({ exp: '1970-01-01T00:00:01Z' }), 100);
    core.connect({ connId: 'c3', nodeId: C, teamId: TEAM_X, connectedAt: 200 });
    const t = core.takeInbox(C, 700_000);
    expect(t.deliveries).toHaveLength(1);
    expect(t.audits).toHaveLength(1);
    expect(t.audits[0]?.event).toBe('exp_rejected');
  });

  it('exp 过期上行 → 静默丢弃 + exp_rejected 审计(D24,无回声)', () => {
    const core = connectedCore();
    const r = core.uplink(B, envelope({ exp: '2026-09-06T11:00:00Z' }), Date.parse('2026-09-07T12:00:00Z'));
    expect(r.ack).toBeUndefined();
    expect(r.audits[0]?.event).toBe('exp_rejected');
    expect(r.deliveries).toHaveLength(0);
  });
});