import { useState, useEffect } from 'react';
import Dashboard from './pages/Dashboard';
import Agents from './pages/Agents';
import AgentDetail from './pages/AgentDetail';
import Tasks from './pages/Tasks';
import Teams from './pages/Teams';
import TeamDetail from './pages/TeamDetail';
import Grants from './pages/Grants';
import Audit from './pages/Audit';
import Settings from './pages/Settings';

const NAV = [
  { key: 'dashboard', icon: '📊', label: '总览' },
  { key: 'agents', icon: '🖥️', label: 'Agent 管理' },
  { key: 'tasks', icon: '📋', label: '任务管理' },
  { key: 'teams', icon: '🏢', label: '团队管理' },
  { key: 'grants', icon: '🔗', label: '跨队授权' },
  { key: 'audit', icon: '📜', label: '审计日志' },
  { key: 'settings', icon: '⚙️', label: '系统设置' },
] as const;
type PageKey = string;

export default function App() {
  const [page, setPage] = useState<PageKey>('dashboard');
  const [teamId, setTeamId] = useState('33333333-3333-4333-8333-333333333333');
  useEffect(() => { document.title = '群龙控制台 - ' + (NAV.find(n => n.key === page)?.label ?? '详情'); }, [page]);
  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <nav style={{ width: 230, background: '#151b2e', display: 'flex', flexDirection: 'column', position: 'fixed', top: 0, bottom: 0 }}>
        <div style={{ padding: '24px 20px 16px', fontSize: 20, fontWeight: 700, color: '#fff' }}>🐉 群龙<span style={{ color: '#4361ee' }}>Console</span></div>
        <div style={{ flex: 1 }}>
          {NAV.map(n => (
            <a key={n.key} onClick={() => setPage(n.key as PageKey)} style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '11px 20px', fontSize: 14, cursor: 'pointer',
              color: page === n.key ? '#ccd6f6' : '#8892b0',
              borderLeft: page === n.key ? '3px solid #4361ee' : '3px solid transparent',
              background: page === n.key ? 'rgba(67,97,238,.12)' : 'transparent',
            }}>
              <span style={{ width: 20, textAlign: 'center' }}>{n.icon}</span> {n.label}
            </a>
          ))}
        </div>
        <div style={{ padding: '16px 20px', borderTop: '1px solid rgba(255,255,255,.06)' }}>
          <div style={{ fontSize: 11, color: '#8892b0' }}>Owner</div>
          <div style={{ fontSize: 14, color: '#fff', marginTop: 2 }}>owner@qlong.io</div>
        </div>
      </nav>
      <main style={{ marginLeft: 230, padding: '28px 36px', flex: 1, maxWidth: 1200 }}>
        {page === 'dashboard' && <Dashboard onNav={setPage} />}
        {page === 'agents' && <Agents onNav={setPage} teamId={teamId} />}
        {page === 'agent-detail' && <AgentDetail onBack={() => setPage('agents')} />}
        {page === 'tasks' && <Tasks />}
        {page === 'teams' && <Teams onNav={setPage} />}
        {page === 'team-detail' && <TeamDetail onBack={() => setPage('teams')} teamId={teamId} />}
        {page === 'grants' && <Grants teamId={teamId} />}
        {page === 'audit' && <Audit />}
        {page === 'settings' && <Settings />}
      </main>
    </div>
  );
}