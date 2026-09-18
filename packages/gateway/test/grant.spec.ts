import { describe, expect, it } from 'vitest';
import type { EnvelopeV1 } from '@qlong/core';
import { newId } from '@qlong/core';
import { evaluateUplink, type DirectoryLookup } from '../src/acl.js';
import type { EnvelopeHeadLite, GatewayConnection, GatewayDirectorySnapshot } from '../src/types.js';

const TX = 't-x';
const TY = 't-y';
const A = 'aaa';
const B = 'bbb';

const dir: GatewayDirectorySnapshot = {
  epoch: 1,
  nodes: [
    { node_id: A, team_id: TX, status: 'active', currentEpoch: 1 },
    { node_id: B, team_id: TY, status: 'active', currentEpoch: 1 },
  ],
};

/** D2:grantLookup 从布尔升级为"活跃 grant 的 caps_visible 并集";undefined = 无 grant(失败关闭)。 */
let visibleCaps: string[] | undefined = undefined;
const testGrant = (_from: string, _to: string): string[] | undefined => visibleCaps;

const lookupDir: DirectoryLookup = {
  snapshotEpoch: 1,
  lookup: (id) => dir.nodes.find((n) => n.node_id === id),
  grantLookup: testGrant,
};

function connFor(nodeId: string, teamId: string): GatewayConnection {
  return { connId: 'c-' + nodeId, nodeId, teamId, connectedAt: 0, generation: 0 };
}

function mkEnvelope(
  fromId: string,
  fromTeam: string,
  toId: string,
  toTeam?: string,
  body: Record<string, unknown> = { kind: 'aid', summary: 's' },
): EnvelopeV1 {
  return {
    v: 1,
    type: 'task.offer',
    msg_id: newId(),
    ts: new Date().toISOString(),
    exp: new Date(Date.now() + 3600000).toISOString(),
    from: { node_id: fromId, team_id: fromTeam, key_epoch: 1 },
    to: { node_id: toId, ...(toTeam ? { team_id: toTeam } : {}) },
    trace: { trace_id: newId(), parent_span: null, origin_node: fromId },
    hops: 0,
    task_id: newId(),
    attempt: 1,
    sig: { alg: 'ed25519', value: 'x' },
    body,
  };
}

function mkOffer(fromId: string, fromTeam: string, toId: string, toTeam?: string, body?: Record<string, unknown>): EnvelopeHeadLite {
  const env = mkEnvelope(fromId, fromTeam, toId, toTeam, body);
  return { ...env, envelope: env };
}

/** A(TX) → B(TY) 跨队上行;requiredCaps 省略 = offer 无能力要求。 */
function crossTeam(requiredCaps?: unknown) {
  const body: Record<string, unknown> = { kind: 'aid', summary: 's' };
  if (requiredCaps !== undefined) body.required_caps = requiredCaps;
  return evaluateUplink({ conn: connFor(A, TX), head: mkOffer(A, TX, B, TY, body), dir: lookupDir });
}

describe('D1 跨队 grant 路由(通道级)', () => {
  it('无 grant(undefined)→ routing_denied(acl_rejected_cross_team)', () => {
    visibleCaps = undefined;
    expect(crossTeam()).toMatchObject({ verdict: 'routing_denied', reasonCode: 'acl_rejected_cross_team' });
  });

  it('grant TX→TY(caps 空)+ offer 无 required_caps → route', () => {
    visibleCaps = [];
    expect(crossTeam().verdict).toBe('route');
  });

  it('反向 B(TY)→A(TX)有 grant → route', () => {
    visibleCaps = [];
    const env = mkEnvelope(B, TY, A, TX);
    const v = evaluateUplink({ conn: connFor(B, TY), head: { ...env, envelope: env }, dir: lookupDir });
    expect(v.verdict).toBe('route');
  });
});

describe('D2 跨队能力裁剪(required_caps ⊆ caps_visible,复用 core matchCaps 防语义分叉)', () => {
  it('grant 暴露 caps 覆盖 required_caps → route', () => {
    visibleCaps = ['tool:x', 'env:wsl2'];
    expect(crossTeam(['tool:x']).verdict).toBe('route');
  });

  it('grant 暴露 caps 不覆盖 required_caps → routing_denied(acl_caps_not_granted + 跨队审计)', () => {
    visibleCaps = ['tool:x'];
    expect(crossTeam(['tool:y'])).toMatchObject({
      verdict: 'routing_denied', rule: 'A1', reasonCode: 'acl_caps_not_granted', auditEvent: 'acl_rejected_cross_team',
    });
  });

  it('§3.2 版本段语义:visible tool:node@20.3 满足 required tool:node@20 → route(精确串匹配会误拒)', () => {
    visibleCaps = ['tool:node@20.3'];
    expect(crossTeam(['tool:node@20']).verdict).toBe('route');
  });

  it('多 required_caps 需全部被覆盖(AND):缺一即拒绝并回吐 missing 明细', () => {
    visibleCaps = ['tool:x'];
    const v = crossTeam(['tool:x', 'env:wsl2']);
    expect(v).toMatchObject({ verdict: 'routing_denied', reasonCode: 'acl_caps_not_granted' });
    expect(v).toHaveProperty('reason', expect.stringContaining('env:wsl2'));
  });

  it('grant 存在但 caps_visible 空 + offer 要 caps → acl_caps_not_granted', () => {
    visibleCaps = [];
    expect(crossTeam(['tool:x'])).toMatchObject({ verdict: 'routing_denied', reasonCode: 'acl_caps_not_granted' });
  });

  it('畸形 required_caps(非数组/含空串/含非串)→ 失败关闭 acl_caps_not_granted', () => {
    visibleCaps = ['tool:x'];
    for (const bad of ['tool:x', [''], [123], {}]) {
      expect(crossTeam(bad)).toMatchObject({ verdict: 'routing_denied', reasonCode: 'acl_caps_not_granted' });
    }
  });

  it('无 grant 优先于 caps 判定:required_caps 合法但无 grant → acl_rejected_cross_team', () => {
    visibleCaps = undefined;
    expect(crossTeam(['tool:x'])).toMatchObject({ verdict: 'routing_denied', reasonCode: 'acl_rejected_cross_team' });
  });
});
