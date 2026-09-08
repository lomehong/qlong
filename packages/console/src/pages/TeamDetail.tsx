import { useState, useEffect } from 'react';
import { useStore } from '../store/useStore';
import { StatusDot } from '../components/StatusDot';

export default function TeamDetail({ onBack, teamId }: { onBack: () => void; teamId: string }) {
  const [tab, setTab] = useState('members');
  const { overview, fetchOverview, suspendAgent, resumeAgent, revokeAgent, issueToken } = useStore();
  const [newToken, setNewToken] = useState<string | null>(null);
  useEffect(() => { if (teamId) fetchOverview(teamId); }, [teamId]);
  const tabs = [
    { key: 'members', label: '成员' }, { key: 'tokens', label: 'Enroll Token' },
    { key: 'grants', label: '跨队授权' }, { key: 'settings', label: '设置' },
  ];
  const nodes = overview?.nodes ?? [];
  return (
    <div>
      <a onClick={onBack} style={{ color: '#718096', fontSize: 13, cursor: 'pointer', display: 'inline-flex', marginBottom: 16 }}>← 返回团队列表</a>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>团队详情</h1>
      <p style={{ color: '#718096', fontSize: 13, marginBottom: 24, fontFamily: 'monospace' }}>team_id: {teamId}</p>
      <div style={{ display: 'flex', borderBottom: '2px solid #e2e8f0', marginBottom: 20 }}>
        {tabs.map(t => (
          <a key={t.key} onClick={() => setTab(t.key)} style={{ padding: '10px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: tab === t.key ? '#4361ee' : '#718096', borderBottom: tab === t.key ? '2px solid #4361ee' : '2px solid transparent', marginBottom: -2 }}>{t.label}</a>
        ))}
      </div>
      {tab === 'members' && (
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>团队成员({nodes.length})</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['状态', '名称', '平台', 'epoch', '最近活跃', '操作'].map(h => <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, color: '#718096', borderBottom: '1px solid #e2e8f0' }}>{h}</th>)}</tr></thead>
            <tbody>{nodes.map(n => (
              <tr key={n.node_id}>
                <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0' }}><StatusDot online={n.online} status={n.status} /></td>
                <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0' }}><strong>{n.name || n.node_id.slice(0, 8)}</strong></td>
                <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0' }}>{n.platform || '—'}</td>
                <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0' }}>{n.key_epoch}</td>
                <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0' }}>{n.last_seen}</td>
                <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0' }}>
                  {n.status === 'active' && <button onClick={() => suspendAgent(teamId, n.node_id).catch(e => useStore.getState().setError((e as Error).message))} style={{ padding: '4px 10px', fontSize: 12, borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', marginRight: 6 }}>暂停</button>}
                  {n.status === 'suspended' && <button onClick={() => resumeAgent(teamId, n.node_id).catch(e => useStore.getState().setError((e as Error).message))} style={{ padding: '4px 10px', fontSize: 12, borderRadius: 6, border: 'none', background: '#4361ee', color: '#fff', cursor: 'pointer', marginRight: 6 }}>恢复</button>}
                  <button onClick={() => { if (window.confirm('确认永久吊销?')) revokeAgent(teamId, n.node_id).catch(e => useStore.getState().setError((e as Error).message)); }} style={{ padding: '4px 10px', fontSize: 12, borderRadius: 6, border: 'none', background: '#ea3943', color: '#fff', cursor: 'pointer' }}>吊销</button>
                </td>
              </tr>
            ))}
            {nodes.length === 0 && <tr><td colSpan={6} style={{ padding: 40, textAlign: 'center', color: '#718096' }}>暂无成员</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {tab === 'tokens' && (
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>签发新 Token</h2>
          <button onClick={async () => { try { const r = await issueToken(teamId); setNewToken(r.token); } catch (e) { useStore.getState().setError((e as Error).message); } }}
            style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: '#4361ee', color: '#fff', cursor: 'pointer' }}>签发(30 分钟)</button>
          {newToken && (
            <div style={{ marginTop: 16 }}>
              <p style={{ color: '#f5a623', fontWeight: 600, fontSize: 13, marginBottom: 8 }}>⚠️ 明文只显示一次,请立即复制</p>
              <div style={{ background: '#151b2e', color: '#16c784', padding: 14, borderRadius: 8, fontFamily: 'monospace', fontSize: 15, wordBreak: 'break-all' }}>{newToken}</div>
            </div>
          )}
        </div>
      )}
      {tab === 'grants' && <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20 }}><h2>跨队授权</h2><p style={{ color: '#718096', fontSize: 13 }}>在全局跨队授权页管理。</p></div>}
      {tab === 'settings' && <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20 }}><h2>设置</h2><dl style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 6, fontSize: 13 }}><dt style={{ color: '#718096' }}>team_id</dt><dd style={{ fontFamily: 'monospace' }}>{teamId}</dd><dt style={{ color: '#718096' }}>状态</dt><dd>active</dd></dl></div>}
    </div>
  );
}