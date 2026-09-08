import { useEffect } from 'react';
import { useStore } from '../store/useStore';
export default function Grants({ teamId }: { teamId: string }) {
  const { grants, fetchGrants, createGrant, revokeGrant } = useStore();
  const [toTeam, setToTeam] = useState('');
  const [caps, setCaps] = useState('');
  useEffect(() => { if (teamId) fetchGrants(teamId); }, [teamId]);
  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>跨队授权</h1>
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>创建 Grant</h2>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ marginBottom: 14 }}><label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#718096', marginBottom: 5 }}>目标 Team ID</label>
          <input value={toTeam} onChange={e => setToTeam(e.target.value)} placeholder="team-uuid" style={{ padding: 8, border: '1px solid #e2e8f0', borderRadius: 6, width: 220 }} /></div>
          <div style={{ marginBottom: 14 }}><label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#718096', marginBottom: 5 }}>caps_visible(逗号分隔,空=全部)</label>
          <input value={caps} onChange={e => setCaps(e.target.value)} placeholder="tool:node@20,env:linux" style={{ padding: 8, border: '1px solid #e2e8f0', borderRadius: 6, width: 280 }} /></div>
          <button onClick={async () => { try { await createGrant(teamId, toTeam, caps ? caps.split(',').map(s => s.trim()) : []); setToTeam(''); setCaps(''); } catch (e) { useStore.getState().setError((e as Error).message); } }}
            style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: '#4361ee', color: '#fff', cursor: 'pointer', marginBottom: 14 }}>创建</button>
        </div>
      </div>
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['grant_id', 'from', 'to', 'caps_visible', '过期', '操作'].map(h => <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, color: '#718096', borderBottom: '1px solid #e2e8f0' }}>{h}</th>)}</tr></thead>
          <tbody>{grants.map(g => (
            <tr key={g.grant_id}>
              <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0', fontFamily: 'monospace', fontSize: 12 }}>{g.grant_id.slice(0, 8)}...</td>
              <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0', fontFamily: 'monospace', fontSize: 12 }}>{g.from_team.slice(0, 8)}...</td>
              <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0', fontFamily: 'monospace', fontSize: 12 }}>{g.to_team.slice(0, 8)}...</td>
              <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0' }}>{g.caps_visible.length > 0 ? g.caps_visible.map(c => <span key={c} style={{ padding: '1px 8px', borderRadius: 12, fontSize: 11, background: '#eef2ff', color: '#4361ee', margin: 1 }}>{c}</span>) : '—(全部)'}</td>
              <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0' }}>{g.expires_at ? new Date(g.expires_at).toLocaleDateString() : '永久'}</td>
              <td style={{ padding: 12 }}><button onClick={async () => { if (window.confirm('确认撤销该 Grant?')) { try { await revokeGrant(teamId, g.grant_id); } catch (e) { useStore.getState().setError((e as Error).message); } } }} style={{ padding: '4px 10px', fontSize: 12, borderRadius: 6, border: 'none', background: '#ea3943', color: '#fff', cursor: 'pointer' }}>撤销</button></td>
            </tr>
          ))}
          {grants.length === 0 && <tr><td colSpan={6} style={{ padding: 40, textAlign: 'center', color: '#718096' }}>暂无 Grant</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
import { useState } from 'react';