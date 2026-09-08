import { useState, useEffect } from 'react';
import { useStore } from './store/useStore';
import { setCsrf } from './api/client';
import { authApi } from './api/auth';
import { ErrorToast } from './components/ui';
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

/** 由页面 key 推导高亮的导航项(详情页归入其列表页) */
function navOf(page: PageKey): PageKey {
  if (page === 'agent-detail') return 'agents';
  if (page === 'team-detail') return 'teams';
  return page;
}

export default function App() {
  const [page, setPage] = useState<PageKey>('dashboard');
  const [teamId, setTeamId] = useState('');
  const [authState, setAuthState] = useState<'checking' | 'login' | 'ready'>('checking');
  const [username, setUsername] = useState('');
  const loadTeams = useStore((s) => s.loadTeams);

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
  useEffect(() => { document.title = '群龙控制台 - ' + (NAV.find(n => n.key === navOf(page))?.label ?? '详情'); }, [page]);

  if (authState === 'checking') {
    return <div className="boot-screen"><span className="spinner" />会话检查中…</div>;
  }
  if (authState === 'login') {
    return <LoginPage onLogin={(u) => refreshAfterLogin(u)} />;
  }

  const activeNav = navOf(page);
  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <nav className="sidebar" aria-label="主导航">
        <div className="sidebar-brand">🐉 <span className="brand-text">群龙<span style={{ color: 'var(--accent)' }}>Console</span></span></div>
        <div className="sidebar-nav">
          {NAV.map(n => (
            <button
              key={n.key}
              type="button"
              className={`nav-item${activeNav === n.key ? ' active' : ''}`}
              aria-current={activeNav === n.key ? 'page' : undefined}
              onClick={() => setPage(n.key as PageKey)}
            >
              <span className="nav-icon" aria-hidden>{n.icon}</span>
              <span className="nav-label">{n.label}</span>
            </button>
          ))}
        </div>
        <div className="sidebar-footer">
          <div className="owner-label">OWNER</div>
          <div className="owner-name">{username || 'owner'}</div>
          <button className="btn-logout" onClick={() => { void authApi.logout().then(() => { setAuthState('login'); location.hash = '#/login'; }); }}>
            退出登录
          </button>
        </div>
      </nav>
      <main className="main">
        {/* key 驱动页面切换的进入动效(减弱动效偏好下自动禁用) */}
        <div key={page} className="page-enter">
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
        </div>
      </main>
      <ErrorToast />
    </div>
  );
}
