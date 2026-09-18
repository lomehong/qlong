import { describe, expect, it } from 'vitest';
import {
  ApiError,
  Registry,
} from '../src/index.js';

const PUB1 = 'A'.repeat(86) + '==';
const PUB2 = 'B'.repeat(86) + '==';

function reg(): Registry {
  return new Registry({ now: () => 1_000_000 });
}

function enrollActive(r: Registry, caps: string[] = []) {
  const t = r.createTeam({ owner_user_id: 'u1' });
  const token = r.issueEnrollToken(t.team_id);
  const res = r.enroll({ token, pubkey: PUB1, platform: 'windows', qlong_version: '0.1.0' });
  if (caps.length) r.putCaps(res.node_token, caps);
  return res;
}

describe('enroll(02 §4)', () => {
  it('happy:签发→入网,token 单次消费;重放 → enroll_token_used', () => {
    const r = reg();
    const team = r.createTeam({ owner_user_id: 'u1' });
    const token = r.issueEnrollToken(team.team_id);
    const res = r.enroll({ token, pubkey: PUB1 });
    expect(res.team_id).toBe(team.team_id);
    expect(res.key_epoch).toBe(1);
    expect(() => r.enroll({ token, pubkey: PUB1 })).toThrowError(ApiError);
    let caught: ApiError | undefined;
    try {
      r.enroll({ token, pubkey: PUB1 });
    } catch (e) {
      caught = e as ApiError;
    }
    expect(caught?.code).toBe('enroll_token_used');
    expect(caught?.httpStatus).toBe(409);
  });

  it('过期与无效码区分(错误呈现契约,评审 I-23③)', () => {
    const r = reg();
    const team = r.createTeam({ owner_user_id: 'u1' });
    const expired = r.issueEnrollToken(team.team_id, { ttlMs: -1 });
    expect(() => r.enroll({ token: expired, pubkey: PUB1 })).toThrowError(/过期/);
    let code = '';
    try {
      r.enroll({ token: 'nope', pubkey: PUB1 });
    } catch (e) {
      code = (e as ApiError).code;
    }
    expect(code).toBe('enroll_token_invalid');
  });

  it('无 token → 单机 team(self-owned,owner 可空,评审 I-48)', () => {
    const r = reg();
    const res = r.enroll({ pubkey: PUB1 });
    const team = r.teams.get(res.team_id);
    expect(team?.state).toBe('self-owned');
    expect(team?.owner_user_id ?? null).toBeNull();
  });

  it('join(换队):旧凭证 + 新 token 双因子,epoch 推进(评审 I-48②/I-45)', () => {
    const r = reg();
    const teamA = r.createTeam({ owner_user_id: 'u1' });
    const teamB = r.createTeam({ owner_user_id: 'u1' });
    const t1 = r.issueEnrollToken(teamA.team_id);
    const res = r.enroll({ token: t1, pubkey: PUB1 });
    const t2 = r.issueEnrollToken(teamB.team_id);
    const before = r.directoryEpoch;
    const joined = r.joinTeam(res.node_token, t2);
    expect(joined.team_id).toBe(teamB.team_id);
    expect(r.directoryEpoch).toBe(before + 1);
  });
});

describe('凭证生命周期(02 §6)', () => {
  it('轮换:epoch+1 + 历史保留 + 纪元现势区分 current/historical/unknown', () => {
    const r = reg();
    const { node_token } = enrollActive(r);
    // 显式测试验证器;不再把无签名的轮换当作成功路径。
    r.rotateKeys(node_token, { pubkey: PUB2, sig: 'test-signature' }, (_node, input) => input.sig === 'test-signature');
    const node = [...r.nodes.values()][0] as NonNullable<ReturnType<Registry['getNode']>>;
    expect(node.keys.map((k) => k.epoch)).toEqual([1, 2]);
    expect(r.lookupPubkey(node.node_id, 2)).toMatchObject({ status: 'current', pubkey: PUB2 });
    expect(r.lookupPubkey(node.node_id, 1)).toMatchObject({ status: 'historical', pubkey: PUB1 });
    expect(r.lookupPubkey(node.node_id, 99).status).toBe('unknown_epoch');
  });

  it('轮换缺少验证器/签名/有效 token 或验证失败均拒绝且不推进目录', () => {
    const r = reg();
    const { node_id, node_token } = enrollActive(r);
    const before = r.directoryEpoch;
    expect(() => r.rotateKeys(node_token, { pubkey: PUB2, sig: 'test-signature' })).toThrowError(/未配置/);
    expect(() => r.rotateKeys(node_token, { pubkey: PUB2 }, () => true)).toThrowError(/签名/);
    expect(() => r.rotateKeys(node_token, { pubkey: PUB2, sig: 'test-signature' }, () => false)).toThrowError(/签名/);
    expect(() => r.rotateKeys('invalid', { pubkey: PUB2, sig: 'test-signature' }, () => true)).toThrowError(/凭证/);
    expect(() => r.rotateKeys(node_token, { pubkey: PUB2, sig: 'test-signature' }, () => { throw new Error('verifier failed'); })).toThrowError(/签名/);
    expect(r.directoryEpoch).toBe(before);
    expect(r.getNode(node_id)?.keys).toEqual([{ epoch: 1, pubkey: PUB1 }]);
  });

  it('suspend → 认证 403 node_suspended;revoke → token 吊销 + 403 node_revoked', () => {
    const r = reg();
    const { node_id, node_token } = enrollActive(r);
    r.suspend(node_id);
    expect(() => r.authByToken(node_token)).toThrowError(/暂停/);
    r.resume(node_id);
    expect(r.authByToken(node_token).status).toBe('active');
    r.revoke(node_id);
    let code = '';
    try {
      r.authByToken(node_token);
    } catch (e) {
      code = (e as ApiError).code;
    }
    expect(code).toBe('node_revoked');
  });

  it('非 active 节点的纪元回源拒绝(§6.2/P12)', () => {
    const r = reg();
    const { node_id } = enrollActive(r);
    expect(r.lookupPubkey(node_id, 1).status).toBe('current');
    r.suspend(node_id);
    const lookup = r.lookupPubkey(node_id, 1);
    expect(lookup.status).toBe('node_inactive');
  });
});

describe('能力与目录查询(03 §4/§5,评审 I-59)', () => {
  it('putCaps:仅静态变更自增 caps_rev;PUT 全量替换语义', () => {
    const r = reg();
    const { node_token } = enrollActive(r, ['tool:node@20']);
    expect(r.putCaps(node_token, ['tool:node@20', 'env:windows']).caps_rev).toBe(3);
    expect(r.putCaps(node_token, ['tool:node@20', 'env:windows']).caps_rev).toBe(3); // 无变化不增
    expect(r.putCaps(node_token, ['env:windows']).caps_rev).toBe(4);
    const node = [...r.nodes.values()][0] as NonNullable<ReturnType<Registry['getNode']>>;
    expect(node.caps).toEqual(['env:windows']); // 全量替换:未提及即删除
  });

  it('通讯录:team 过滤 + caps 过滤(D31)+ 在线态注入', () => {
    const r = reg();
    const team = r.createTeam({ owner_user_id: 'u1' });
    const t = r.issueEnrollToken(team.team_id);
    const n1 = r.enroll({ token: t, pubkey: PUB1 });
    const t2 = r.issueEnrollToken(team.team_id);
    const n2 = r.enroll({ token: t2, pubkey: PUB2 });
    r.putCaps(n1.node_token, ['tool:node@20']);
    r.putCaps(n2.node_token, ['env:wsl2']);
    r.presence.set(n2.node_id, true);

    expect(r.listTeamNodes(team.team_id)).toHaveLength(2);
    const filtered = r.listTeamNodes(team.team_id, { caps: ['tool:node@20'] });
    expect(filtered).toHaveLength(1);
    expect((filtered[0] as { node_id: string }).node_id).toBe(n1.node_id);
    const online = r.listTeamNodes(team.team_id, {}) as Array<{ node_id: string; online: boolean }>;
    expect(online.find((x) => x.node_id === n2.node_id)?.online).toBe(true);
  });

  it('快照带 directory epoch;revoke 后快照仍含节点但状态 revoked', () => {
    const r = reg();
    const { node_id } = enrollActive(r);
    const before = r.snapshot();
    expect(before.epoch).toBeGreaterThan(0);
    r.revoke(node_id);
    const after = r.snapshot();
    expect(after.epoch).toBe(before.epoch + 1);
    expect(after.nodes.find((n) => n.node_id === node_id)?.status).toBe('revoked');
  });
});

describe('跨队能力授权 grantCaps(D2,03 §8/§10.4)', () => {
  function twoTeams(nowFn: () => number = () => 1_000_000) {
    const r = new Registry({ now: nowFn });
    const a = r.createTeam({ owner_user_id: 'u1' });
    const b = r.createTeam({ owner_user_id: 'u2' });
    return { r, a, b };
  }

  it('活跃 grant → 返回 caps_visible,双向对称,hasGrant 一致为真', () => {
    const { r, a, b } = twoTeams();
    r.createGrant({ from_team: a.team_id, to_team: b.team_id, caps_visible: ['tool:x', 'env:wsl2'] });
    expect(r.grantCaps(a.team_id, b.team_id)).toEqual(['tool:x', 'env:wsl2']);
    expect(r.grantCaps(b.team_id, a.team_id)).toEqual(r.grantCaps(a.team_id, b.team_id));
    expect(r.hasGrant(a.team_id, b.team_id)).toBe(true);
  });

  it('无 grant → undefined(与"有 grant 但 caps 空"的 [] 区分),hasGrant 为假', () => {
    const { r, a, b } = twoTeams();
    expect(r.grantCaps(a.team_id, b.team_id)).toBeUndefined();
    expect(r.hasGrant(a.team_id, b.team_id)).toBe(false);
  });

  it('grant 存在但 caps_visible 空 → [](通道开启但未授予任何能力)', () => {
    const { r, a, b } = twoTeams();
    r.createGrant({ from_team: a.team_id, to_team: b.team_id });
    expect(r.grantCaps(a.team_id, b.team_id)).toEqual([]);
    expect(r.hasGrant(a.team_id, b.team_id)).toBe(true);
  });

  it('过期 grant → undefined,hasGrant 转假(随 now 推进失效)', () => {
    let now = 1_000_000;
    const { r, a, b } = twoTeams(() => now);
    r.createGrant({ from_team: a.team_id, to_team: b.team_id, caps_visible: ['tool:x'], ttlMs: 5_000 });
    expect(r.grantCaps(a.team_id, b.team_id)).toEqual(['tool:x']);
    now += 5_001;
    expect(r.grantCaps(a.team_id, b.team_id)).toBeUndefined();
    expect(r.hasGrant(a.team_id, b.team_id)).toBe(false);
  });

  it('多条活跃 grant → caps_visible 并集去重', () => {
    const { r, a, b } = twoTeams();
    r.createGrant({ from_team: a.team_id, to_team: b.team_id, caps_visible: ['tool:x', 'env:wsl2'] });
    r.createGrant({ from_team: b.team_id, to_team: a.team_id, caps_visible: ['env:wsl2', 'tool:y'] });
    expect([...r.grantCaps(a.team_id, b.team_id)!].sort()).toEqual(['env:wsl2', 'tool:x', 'tool:y']);
  });

  it('revokeGrant → 活跃 grant 消失后回落 undefined', () => {
    const { r, a, b } = twoTeams();
    const g = r.createGrant({ from_team: a.team_id, to_team: b.team_id, caps_visible: ['tool:x'] });
    expect(r.grantCaps(a.team_id, b.team_id)).toEqual(['tool:x']);
    r.revokeGrant(g.grant_id);
    expect(r.grantCaps(a.team_id, b.team_id)).toBeUndefined();
  });
});