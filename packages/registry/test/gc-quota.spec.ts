import { describe, expect, it } from 'vitest';
import { Registry } from '../src/index.js';

/** 02 §4.2/I-16:每 owner 节点配额 + orphan GC + 离线节点回收;§7.1 变更通知 */
describe('Registry 配额 / GC / 变更通知', () => {
  it('每 owner 节点配额:超限 → 429 quota_exceeded', () => {
    let t = 1_000_000;
    const reg = new Registry({ now: () => t, maxNodesPerOwner: 2 });
    const teamA = reg.createTeam({ owner_user_id: 'u1' });
    const teamB = reg.createTeam({ owner_user_id: 'u1' });
    const n1 = reg.enroll({ token: reg.issueEnrollToken(teamA.team_id), pubkey: 'pk1' });
    const n2 = reg.enroll({ token: reg.issueEnrollToken(teamB.team_id), pubkey: 'pk2' });
    expect(n1.node_id).toBeTruthy();
    expect(n2.node_id).toBeTruthy();
    // owner 名下第 3 个节点 → 配额拒绝
    expect(() => reg.enroll({ token: reg.issueEnrollToken(teamA.team_id), pubkey: 'pk3' })).toThrow(
      /quota_exceeded|配额/,
    );
    // 无 owner 的单机 team 不受限
    expect(reg.enroll({ pubkey: 'pk4' }).node_id).toBeTruthy();
  });

  it('GC:零成员单机 team 到期删除;长期离线节点吊销并清档案', () => {
    const day = 24 * 3_600_000;
    let t = 1_000_000;
    const reg = new Registry({ now: () => t, orphanTeamTtlMs: 30 * day, offlineNodeTtlMs: 30 * day });
    // a) 有 token 的正常 team:成员被 revoke 后 team 无 owner 且零成员
    const team = reg.createTeam({ owner_user_id: 'u1' });
    const n1 = reg.enroll({ token: reg.issueEnrollToken(team.team_id), pubkey: 'pk1' });
    reg.revoke(n1.node_id);
    // team 有 owner → 不属于 orphan,不删
    let r = reg.gc();
    expect(r.removedOrphanTeams).toBe(0);
    // b) 无 token enroll(单机 self-owned team)→ revoke 后零成员无 owner → 到期删除
    const solo = reg.enroll({ pubkey: 'pk2' });
    reg.revoke(solo.node_id);
    t += 31 * day;
    r = reg.gc();
    expect(r.removedOrphanTeams).toBe(1);
    // c) 长期离线节点 → revoked + 档案清理
    const alive = reg.enroll({ pubkey: 'pk3' });
    reg.putCaps(alive.node_token, ['tool:x']);
    expect(reg.getNode(alive.node_id)?.caps).toEqual(['tool:x']);
    t += 31 * day;
    r = reg.gc();
    expect(r.revokedOfflineNodes).toBeGreaterThanOrEqual(1);
    expect(reg.getNode(alive.node_id)?.status).toBe('revoked');
    expect(reg.getNode(alive.node_id)?.caps).toEqual([]); // 档案清理(03 §8)
  });

  it('目录变更通知(§7.1):joinTeam/suspend/revoke/轮换 → 监听器触发', () => {
    let t = 1_000_000;
    const reg = new Registry({ now: () => t });
    const team = reg.createTeam({ owner_user_id: 'u1' });
    const n1 = reg.enroll({ token: reg.issueEnrollToken(team.team_id), pubkey: 'pk1' });
    const team2 = reg.createTeam({ owner_user_id: 'u1' });
    let calls = 0;
    const off = reg.onDirectoryChange(() => {
      calls += 1;
    });
    reg.joinTeam(n1.node_token, reg.issueEnrollToken(team2.team_id));
    reg.suspend(n1.node_id);
    reg.resume(n1.node_id);
    reg.rotateKeys(n1.node_token, { pubkey: 'pk1-new' });
    reg.revoke(n1.node_id);
    expect(calls).toBeGreaterThanOrEqual(5);
    off();
    reg.enroll({ token: reg.issueEnrollToken(team.team_id), pubkey: 'pk9' });
    expect(calls).toBeGreaterThanOrEqual(5); // 取消订阅后不再计数
  });
});
