import { useState, useEffect } from 'react';
import { useStore } from '../store/useStore';
import { StatusDot } from '../components/StatusDot';
import { CopyChip } from '../components/CopyChip';
import { Empty } from '../components/ui';

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
      <button type="button" className="back-link" onClick={onBack}>← 返回团队列表</button>
      <div className="page-head">
        <h1 className="page-title">团队详情</h1>
        <p className="page-sub"><CopyChip value={teamId} head={18} /></p>
      </div>
      <div className="tabs" role="tablist">
        {tabs.map(t => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
            className={`tab${tab === t.key ? ' active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      {tab === 'members' && (
        <div className="card card-flush">
          <h2 className="card-title" style={{ padding: '18px 20px 0' }}>团队成员({nodes.length})</h2>
          <div className="table-wrap">
            <table className="table">
              <thead><tr>{['状态', '名称', '平台', 'epoch', '最近活跃', '操作'].map(h => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>{nodes.map(n => (
                <tr key={n.node_id}>
                  <td><StatusDot online={n.online} status={n.status} /></td>
                  <td><strong>{n.name || n.node_id.slice(0, 8)}</strong> <CopyChip value={n.node_id} /></td>
                  <td>{n.platform || '—'}</td>
                  <td className="mono">{n.key_epoch}</td>
                  <td>{n.last_seen}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, whiteSpace: 'nowrap' }}>
                      {n.status === 'active' && <button className="btn btn-ghost btn-sm" onClick={() => suspendAgent(teamId, n.node_id).catch(e => useStore.getState().setError((e as Error).message))}>暂停</button>}
                      {n.status === 'suspended' && <button className="btn btn-primary btn-sm" onClick={() => resumeAgent(teamId, n.node_id).catch(e => useStore.getState().setError((e as Error).message))}>恢复</button>}
                      <button className="btn btn-danger btn-sm" onClick={() => { if (window.confirm('确认永久吊销?')) revokeAgent(teamId, n.node_id).catch(e => useStore.getState().setError((e as Error).message)); }}>吊销</button>
                    </div>
                  </td>
                </tr>
              ))}
              </tbody>
            </table>
            {nodes.length === 0 && <Empty icon="🏢" text="暂无成员" />}
          </div>
        </div>
      )}
      {tab === 'tokens' && (
        <div className="card">
          <h2 className="card-title">签发新 Token</h2>
          <button className="btn btn-primary" onClick={async () => { try { const r = await issueToken(teamId); setNewToken(r.token); } catch (e) { useStore.getState().setError((e as Error).message); } }}>签发(30 分钟)</button>
          {newToken && (
            <div style={{ marginTop: 16 }}>
              <p style={{ color: 'var(--warning)', fontWeight: 600, fontSize: 13, marginBottom: 8 }}>⚠️ 明文只显示一次,请立即复制</p>
              <div className="code-block" style={{ fontSize: 14 }}>{newToken}</div>
            </div>
          )}
        </div>
      )}
      {tab === 'grants' && <div className="card"><h2 className="card-title">跨队授权</h2><p style={{ color: 'var(--text-3)', fontSize: 13 }}>在全局跨队授权页管理。</p></div>}
      {tab === 'settings' && <div className="card"><h2 className="card-title">设置</h2><dl className="dl"><dt>team_id</dt><dd><CopyChip value={teamId} head={18} /></dd><dt>状态</dt><dd>active</dd></dl></div>}
    </div>
  );
}
