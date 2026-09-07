import { useState } from 'react';
export interface Agent { id: string; name: string; team: string; status: string; online: boolean; platform: string; epoch: number; capsRev: number; lastSeen: string; }
export const AGENTS: Agent[] = [
  { id: 'a4763d9c', name: 'dev-machine', team: '研发团队', status: 'active', online: true, platform: 'windows', epoch: 1, capsRev: 3, lastSeen: '刚刚' },
  { id: '2c0fb067', name: 'build-server', team: '研发团队', status: 'active', online: true, platform: 'linux', epoch: 2, capsRev: 5, lastSeen: '2 分钟前' },
  { id: '8a1b2c3d', name: 'gpu-node', team: '研发团队', status: 'active', online: true, platform: 'linux', epoch: 1, capsRev: 2, lastSeen: '5 分钟前' },
  { id: '9f8e7d6c', name: 'macbook-pro', team: '研发团队', status: 'active', online: false, platform: 'darwin', epoch: 1, capsRev: 1, lastSeen: '2 小时前' },
  { id: '0a1b2c3d', name: 'old-laptop', team: '研发团队', status: 'suspended', online: false, platform: 'linux', epoch: 1, capsRev: 1, lastSeen: '3 天前' },
  { id: 'b2c3d4e5', name: 'research-01', team: '研究团队', status: 'active', online: true, platform: 'linux', epoch: 1, capsRev: 2, lastSeen: '1 分钟前' },
  { id: 'c3d4e5f6', name: 'research-02', team: '研究团队', status: 'active', online: false, platform: 'linux', epoch: 1, capsRev: 1, lastSeen: '30 分钟前' },
];
export function StatusDot({ online, status }: { online: boolean; status: string }) {
  const color = status === 'suspended' ? '#f5a623' : online ? '#16c784' : '#cbd5e0';
  const label = status === 'suspended' ? 'suspended' : online ? '在线' : '离线';
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 9, height: 9, borderRadius: '50%', background: color }} />{label}</span>;
}
export default function Agents({ onNav }: { onNav: (p: string) => void }) {
  const [search, setSearch] = useState('');
  const [teamFilter, setTeamFilter] = useState('全部团队');
  const filtered = AGENTS.filter(a => (teamFilter === '全部团队' || a.team === teamFilter) && (a.name.includes(search) || a.id.includes(search)));
  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Agent 管理</h1>
      <p style={{ color: '#718096', fontSize: 13, marginBottom: 24 }}>全部 Agent(跨团队,可按团队筛选)</p>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <input placeholder="🔍 搜索名称或 ID..." value={search} onChange={e => setSearch(e.target.value)} style={{ padding: '7px 12px', border: '1px solid #e2e8f0', borderRadius: 6, width: 240 }} />
        <select value={teamFilter} onChange={e => setTeamFilter(e.target.value)} style={{ padding: '7px 12px', border: '1px solid #e2e8f0', borderRadius: 6 }}>
          {['全部团队', '研发团队', '研究团队'].map(t => <option key={t}>{t}</option>)}
        </select>
      </div>
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['状态', '名称', '所属团队', '平台', 'key_epoch', 'caps_rev', '最近活跃', ''].map(h => <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, color: '#718096', borderBottom: '1px solid #e2e8f0' }}>{h}</th>)}</tr></thead>
          <tbody>{filtered.map(a => (
            <tr key={a.id} className="click" onClick={() => onNav('agent-detail')} style={{ cursor: 'pointer' }}>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}><StatusDot online={a.online} status={a.status} /></td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}><strong>{a.name}</strong></td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>{a.team}</td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>{a.platform}</td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>{a.epoch}</td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>{a.capsRev}</td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>{a.lastSeen}</td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}><a onClick={e => { e.stopPropagation(); onNav('agent-detail'); }}>详情 →</a></td>
            </tr>))}
          </tbody>
        </table>
      </div>
    </div>
  );
}