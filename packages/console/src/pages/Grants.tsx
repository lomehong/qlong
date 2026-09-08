import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { CopyChip } from '../components/CopyChip';
import { Empty } from '../components/ui';

export default function Grants({ teamId }: { teamId: string }) {
  const { grants, fetchGrants, createGrant, revokeGrant } = useStore();
  const [toTeam, setToTeam] = useState('');
  const [caps, setCaps] = useState('');
  useEffect(() => { if (teamId) fetchGrants(teamId); }, [teamId]);
  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">跨队授权</h1>
        <p className="page-sub">管理团队间的能力可见性授权</p>
      </div>
      <div className="card">
        <h2 className="card-title">创建 Grant</h2>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div><label className="field-label" htmlFor="grant-to">目标 Team ID</label>
            <input id="grant-to" className="input" value={toTeam} onChange={e => setToTeam(e.target.value)} placeholder="team-uuid" style={{ width: 240 }} /></div>
          <div><label className="field-label" htmlFor="grant-caps">caps_visible(逗号分隔,空=全部)</label>
            <input id="grant-caps" className="input" value={caps} onChange={e => setCaps(e.target.value)} placeholder="tool:node@20,env:linux" style={{ width: 300 }} /></div>
          <button className="btn btn-primary" onClick={async () => { try { await createGrant(teamId, toTeam, caps ? caps.split(',').map(s => s.trim()) : []); setToTeam(''); setCaps(''); } catch (e) { useStore.getState().setError((e as Error).message); } }}>创建</button>
        </div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr>{['grant_id', 'from', 'to', 'caps_visible', '过期', '操作'].map(h => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{grants.map(g => (
              <tr key={g.grant_id}>
                <td><CopyChip value={g.grant_id} /></td>
                <td><CopyChip value={g.from_team} /></td>
                <td><CopyChip value={g.to_team} /></td>
                <td>{g.caps_visible.length > 0
                  ? <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>{g.caps_visible.map(c => <span key={c} className="badge badge-info">{c}</span>)}</span>
                  : <span style={{ color: 'var(--text-3)' }}>—(全部)</span>}</td>
                <td>{g.expires_at ? new Date(g.expires_at).toLocaleDateString() : '永久'}</td>
                <td><button className="btn btn-danger-ghost btn-sm" onClick={async () => { if (window.confirm('确认撤销该 Grant?')) { try { await revokeGrant(teamId, g.grant_id); } catch (e) { useStore.getState().setError((e as Error).message); } } }}>撤销</button></td>
              </tr>
            ))}
            </tbody>
          </table>
          {grants.length === 0 && <Empty icon="🔗" text="暂无 Grant" />}
        </div>
      </div>
    </div>
  );
}
