import { useEffect, useState } from 'react';
import { useStore, type AgentRecord } from '../store/useStore';
import { StatusDot } from '../components/StatusDot';
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
  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#718096' }}>加载中...</div>;
  return (
    <div>
      {error && <div style={{ background: '#feecea', color: '#ea3943', padding: 12, borderRadius: 6, marginBottom: 16 }}>{error}</div>}
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Agent 管理</h1>
      <p style={{ color: '#718096', fontSize: 13, marginBottom: 24 }}>全部 Agent(跨团队,可按团队筛选)</p>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <input placeholder="🔍 搜索名称或 ID..." value={search} onChange={e => setSearch(e.target.value)} style={{ padding: '7px 12px', border: '1px solid #e2e8f0', borderRadius: 6, width: 240 }} />
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{ padding: '7px 12px', border: '1px solid #e2e8f0', borderRadius: 6 }}>
          {['全部状态', '在线', '离线', 'suspended'].map(s => <option key={s}>{s}</option>)}
        </select>
      </div>
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['状态', '名称', '平台', '版本', 'key_epoch', 'caps_rev', '最近活跃', '操作'].map(h => <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, color: '#718096', borderBottom: '1px solid #e2e8f0' }}>{h}</th>)}</tr></thead>
          <tbody>{filtered.map(a => (
            <tr key={a.node_id} onClick={() => onNav('agent-detail')} style={{ cursor: 'pointer' }}>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}><StatusDot online={a.online} status={a.status} /></td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}><strong>{a.name || a.node_id.slice(0, 8)}</strong></td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>{a.platform || '—'}</td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>{a.version || '—'}</td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>{a.key_epoch}</td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>{a.caps_rev}</td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>{a.last_seen}</td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0', whiteSpace: 'nowrap' }}>
                {a.status === 'active' && <button onClick={e => { e.stopPropagation(); act(suspendAgent, a.node_id); }} style={{ padding: '4px 10px', fontSize: 12, borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', marginRight: 6 }}>暂停</button>}
                {a.status === 'suspended' && <button onClick={e => { e.stopPropagation(); act(resumeAgent, a.node_id); }} style={{ padding: '4px 10px', fontSize: 12, borderRadius: 6, border: 'none', background: '#4361ee', color: '#fff', cursor: 'pointer', marginRight: 6 }}>恢复</button>}
                <button onClick={e => { e.stopPropagation(); if (window.confirm('确认永久吊销? 此操作不可逆。')) act(revokeAgent, a.node_id); }} style={{ padding: '4px 10px', fontSize: 12, borderRadius: 6, border: 'none', background: '#ea3943', color: '#fff', cursor: 'pointer' }}>吊销</button>
              </td>
            </tr>
          ))}
          {filtered.length === 0 && !loading && <tr><td colSpan={8} style={{ padding: 40, textAlign: 'center', color: '#718096' }}>暂无 Agent</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}