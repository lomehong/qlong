import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { StatusDot } from '../components/StatusDot';
import { CopyChip } from '../components/CopyChip';
import { Loading, Empty } from '../components/ui';

export default function Agents({ onNav, teamId }: { onNav: (p: string) => void; teamId: string }) {
  const { agents, loading, error, fetchOverview, suspendAgent, resumeAgent, revokeAgent } = useStore();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('全部状态');
  useEffect(() => { if (teamId) fetchOverview(teamId); }, [teamId]);
  const filtered = agents.filter(a =>
    (statusFilter === '全部状态' || (statusFilter === '在线' && a.online) || (statusFilter === '离线' && !a.online) || (statusFilter === 'suspended' && a.status === 'suspended')) &&
    (a.name?.includes(search) || a.node_id.includes(search))
  );
  const act = async (fn: (t: string, n: string) => Promise<void>, nid: string) => {
    try { await fn(teamId, nid); } catch (e) { useStore.getState().setError((e as Error).message); }
  };
  if (loading) return <Loading />;
  return (
    <div>
      {error && <div className="error-banner" role="alert">⚠️ {error}</div>}
      <div className="page-head">
        <h1 className="page-title">Agent 管理</h1>
        <p className="page-sub">全部 Agent(跨团队,可按团队筛选)</p>
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <input className="input" placeholder="🔍 搜索名称或 ID…" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 240, maxWidth: '100%', flex: '0 1 auto' }} aria-label="搜索 Agent" />
        <select className="select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)} aria-label="状态筛选">
          {['全部状态', '在线', '离线', 'suspended'].map(s => <option key={s}>{s}</option>)}
        </select>
        <span style={{ marginLeft: 'auto', alignSelf: 'center', fontSize: 12, color: 'var(--text-3)' }}>
          {filtered.length} / {agents.length} 个 Agent
        </span>
      </div>
      <div className="card card-flush">
        <div className="table-wrap">
          <table className="table">
            <thead><tr>{['状态', '名称', '平台', '版本', 'key_epoch', 'caps_rev', '最近活跃', '操作'].map(h => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{filtered.map(a => (
              <tr key={a.node_id} className="row-clickable" onClick={() => onNav('agent-detail')}>
                <td><StatusDot online={a.online} status={a.status} /></td>
                <td><strong>{a.name || a.node_id.slice(0, 8)}</strong> <CopyChip value={a.node_id} /></td>
                <td>{a.platform || '—'}</td>
                <td>{a.version || '—'}</td>
                <td className="mono">{a.key_epoch}</td>
                <td className="mono">{a.caps_rev}</td>
                <td>{a.last_seen}</td>
                <td>
                  <div style={{ display: 'flex', gap: 6, whiteSpace: 'nowrap' }}>
                    {a.status === 'active' && <button className="btn btn-ghost btn-sm" onClick={e => { e.stopPropagation(); void act(suspendAgent, a.node_id); }}>暂停</button>}
                    {a.status === 'suspended' && <button className="btn btn-primary btn-sm" onClick={e => { e.stopPropagation(); void act(resumeAgent, a.node_id); }}>恢复</button>}
                    <button className="btn btn-danger btn-sm" onClick={e => { e.stopPropagation(); if (window.confirm('确认永久吊销? 此操作不可逆。')) void act(revokeAgent, a.node_id); }}>吊销</button>
                  </div>
                </td>
              </tr>
            ))}
            </tbody>
          </table>
          {filtered.length === 0 && <Empty icon="🖥️" text={agents.length === 0 ? '暂无 Agent' : '没有匹配筛选条件的 Agent'} />}
        </div>
      </div>
    </div>
  );
}
