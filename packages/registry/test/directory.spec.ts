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
    r.rotateKeys(node_token, { pubkey: PUB2 });
    const node = [...r.nodes.values()][0] as NonNullable<ReturnType<Registry['getNode']>>;
    expect(node.keys.map((k) => k.epoch)).toEqual([1, 2]);
    expect(r.lookupPubkey(node.node_id, 2)).toMatchObject({ status: 'current', pubkey: PUB2 });
    expect(r.lookupPubkey(node.node_id, 1)).toMatchObject({ status: 'historical', pubkey: PUB1 });
    expect(r.lookupPubkey(node.node_id, 99).status).toBe('unknown_epoch');
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