import { useEffect } from 'react';
import { useStore } from '../store/useStore';
import { StatusDot } from '../components/StatusDot';
import { Loading, Empty } from '../components/ui';

export default function Dashboard({ onNav, teamId }: { onNav: (p: string) => void; teamId: string }) {
  const { overview, fetchOverview, audits } = useStore();
  useEffect(() => { if (teamId) fetchOverview(teamId); }, [teamId]);
  const total = overview?.stats?.total ?? 0;
  const online = overview?.stats?.online ?? 0;
  const grantCount = overview?.grants?.length ?? 0;
  const stats = [
    { n: total, label: 'Agent 总数', icon: '🖥️', target: 'agents' },
    { n: online, label: '在线', icon: '🟢', target: 'agents' },
    { n: grantCount, label: '跨队 Grant', icon: '🔗', target: 'grants' },
    { n: audits.length, label: '审计事件', icon: '📜', target: 'audit' },
  ];
  const nodes = overview?.nodes ?? [];
  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">总览</h1>
        <p className="page-sub">全平台聚合数据</p>
      </div>
      <div className="stat-grid" style={{ marginBottom: 22 }}>
        {stats.map(s => (
          <div key={s.label} className="card card-clickable" role="button" tabIndex={0}
            onClick={() => onNav(s.target)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNav(s.target); } }}
            style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 18px' }}>
            <span style={{ fontSize: 22 }} aria-hidden>{s.icon}</span>
            <div>
              <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' }}>{s.n}</div>
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 1 }}>{s.label}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="card">
        <h2 className="card-title">Agent 概况</h2>
        {!overview ? <Loading /> : nodes.length === 0 ? <Empty icon="🖥️" text="暂无 Agent,可先在「节点安装」生成邀请码接入" /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>{['名称', '状态', '平台', 'key_epoch', '最近活跃'].map(h => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>{nodes.map(n => (
                <tr key={n.node_id}>
                  <td><strong>{n.name || n.node_id.slice(0, 8)}</strong></td>
                  <td><StatusDot online={n.online} status={n.status} /></td>
                  <td>{n.platform || '—'}</td>
                  <td className="mono">{n.key_epoch}</td>
                  <td>{n.last_seen}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
