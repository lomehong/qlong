import { useEffect } from 'react';
import { useStore } from '../store/useStore';

export default function Dashboard({ onNav, teamId }: { onNav: (p: string) => void; teamId: string }) {
  const { overview, fetchOverview, audits } = useStore();
  useEffect(() => { if (teamId) fetchOverview(teamId); }, [teamId]);
  const total = overview?.stats?.total ?? 0;
  const online = overview?.stats?.online ?? 0;
  const grantCount = overview?.grants?.length ?? 0;
  const stats = [
    { n: total, label: 'Agent 总数', target: 'agents' },
    { n: online, label: '在线', target: 'agents' },
    { n: grantCount, label: '跨队 Grant', target: 'grants' },
    { n: audits.length, label: '审计事件', target: 'audit' },
  ];
  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>总览</h1>
      <p style={{ color: '#718096', fontSize: 13, marginBottom: 24 }}>全平台聚合数据</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16, marginBottom: 24 }}>
        {stats.map(s => (
          <div key={s.label} onClick={() => onNav(s.target)} style={{ background: '#fff', borderRadius: 8, padding: 18, border: '1px solid #e2e8f0', cursor: 'pointer' }}>
            <div style={{ fontSize: 30, fontWeight: 700 }}>{s.n}</div>
            <div style={{ fontSize: 12, color: '#718096', marginTop: 4 }}>{s.label}</div>
          </div>
        ))}
      </div>
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Agent 概况</h2>
        {overview ? (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['名称', '状态', '平台', 'key_epoch', '最近活跃'].map(h => <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, color: '#718096', borderBottom: '1px solid #e2e8f0' }}>{h}</th>)}</tr></thead>
            <tbody>{(overview.nodes ?? []).map(n => (
              <tr key={n.node_id}>
                <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}><strong>{n.name || n.node_id.slice(0, 8)}</strong></td>
                <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 9, height: 9, borderRadius: '50%', background: n.status === 'suspended' ? '#f5a623' : n.online ? '#16c784' : '#cbd5e0' }} />{n.status === 'suspended' ? 'suspended' : n.online ? '在线' : '离线'}</span></td>
                <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>{n.platform || '—'}</td>
                <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>{n.key_epoch}</td>
                <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>{n.last_seen}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : <p style={{ color: '#718096', fontSize: 13 }}>加载中...</p>}
      </div>
    </div>
  );
}