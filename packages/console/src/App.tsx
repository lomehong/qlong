import { useState, useEffect } from 'react';
import { useStore } from './store/useStore';
import { setCsrf } from './api/client';
import { authApi } from './api/auth';
import LoginPage from './pages/LoginPage';
import Dashboard from './pages/Dashboard';
import Agents from './pages/Agents';
import AgentDetail from './pages/AgentDetail';
import Tasks from './pages/Tasks';
import Teams from './pages/Teams';
import TeamDetail from './pages/TeamDetail';
import Grants from './pages/Grants';
import Audit from './pages/Audit';
import Settings from './pages/Settings';
import Install from './pages/Install';

const NAV = [
  { key: 'dashboard', icon: '📊', label: '总览' },
  { key: 'install', icon: '📦', label: '节点安装' },
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
  const [teamId, setTeamId] = useState('');
  const [authState, setAuthState] = useState<'checking' | 'login' | 'ready'>('checking');
  const [username, setUsername] = useState('');
  const loadTeams = useStore((s) => s.loadTeams);
  const teams = useStore((s) => s.teams);

  const refreshAfterLogin = (u: string): void => {
    setUsername(u);
    setAuthState('ready');
    if (location.hash === '#/login') location.hash = '';
    loadTeams().then((ts) => { if (ts.length > 0) setTeamId((cur) => cur || ts[0].team_id); })
      .catch(() => { /* 未配置 owner 凭证时保持空,页面内提示 */ });
  };

  useEffect(() => {
    // 会话探测(Cookie):有效 → 进入控制台;无效 → 登录页(设计:未登录一律跳登录)
    authApi.me()
      .then((r) => { setCsrf(r.csrf); refreshAfterLogin(r.username); })
      .catch(() => { setAuthState('login'); location.hash = '#/login'; });
    const onHash = (): void => { void check(); };
    async function check(): Promise<void> {
      try {
        const r = await authApi.me();
        setCsrf(r.csrf);
        refreshAfterLogin(r.username);
      } catch {
        setAuthState('login');
      }
    }
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => { document.title = '群龙控制台 - ' + (NAV.find(n => n.key === page)?.label ?? '详情'); }, [page]);
  if (authState === 'checking') {
    return <div style={{ minHeight: '100vh', background: '#0d1117', color: '#8892b0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>会话检查中…</div>;
  }
  if (authState === 'login') {
    return <LoginPage onLogin={(u) => refreshAfterLogin(u)} />;
  }
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
          <div style={{ fontSize: 14, color: '#fff', marginTop: 2 }}>{username || 'owner'}</div>
          <button onClick={() => { void authApi.logout().then(() => { setAuthState('login'); location.hash = '#/login'; }); }}
            style={{ marginTop: 10, padding: '5px 12px', border: '1px solid #2a3145', borderRadius: 6, background: 'transparent', color: '#8892b0', fontSize: 12, cursor: 'pointer' }}>
            退出登录
          </button>
        </div>
      </nav>
      <main style={{ marginLeft: 230, padding: '28px 36px', flex: 1, maxWidth: 1200 }}>
        {page === 'dashboard' && <Dashboard onNav={setPage} teamId={teamId} />}
        {page === 'install' && <Install teamId={teamId} />}
        {page === 'agents' && <Agents onNav={setPage} teamId={teamId} />}
        {page === 'agent-detail' && <AgentDetail onBack={() => setPage('agents')} />}
        {page === 'tasks' && <Tasks teamId={teamId} />}
        {page === 'teams' && <Teams onNav={setPage} />}
        {page === 'team-detail' && <TeamDetail onBack={() => setPage('teams')} teamId={teamId} />}
        {page === 'grants' && <Grants teamId={teamId} />}
        {page === 'audit' && <Audit teamId={teamId} />}
        {page === 'settings' && <Settings />}
      </main>
    </div>
  );
}