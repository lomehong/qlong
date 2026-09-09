import { useState, useEffect } from 'react';
import { useStore } from './store/useStore';
import { setCsrf } from './api/client';
import { authApi } from './api/auth';
import { ErrorToast } from './components/ui';
import { useVisibleWidthTier } from './hooks/useVisibleWidth';
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

/** v0.8 URL 路由化:hash ↔ 页面双向同步(#/install 直达节点安装页;非法/缺失 hash → 总览) */
function pageFromHash(): PageKey {
  const h = location.hash.replace(/^#\//, '').split('?')[0] ?? '';
  return NAV.some((n) => n.key === h) ? h : 'dashboard';
}

/** 由页面 key 推导高亮的导航项(详情页归入其列表页) */
function navOf(page: PageKey): PageKey {
  if (page === 'agent-detail') return 'agents';
  if (page === 'team-detail') return 'teams';
  return page;
}

export default function App() {
  const [page, setPageState] = useState<PageKey>(() => pageFromHash());
  const [teamId, setTeamId] = useState('');
  const [authState, setAuthState] = useState<'checking' | 'login' | 'ready'>('checking');
  const [username, setUsername] = useState('');
  const loadTeams = useStore((s) => s.loadTeams);
  // 真实可见宽度档位(s/m/l)写入 <html data-vw>,驱动全局响应式;
  // 在固定宽度 iframe(创空间)内也能随外层窗口缩放/横滚正确适配
  useVisibleWidthTier();

  /** 页面切换写回 hash(深链接/刷新可恢复);hashchange 再回灌同值,无环 */
  const setPage = (p: PageKey): void => {
    setPageState(p);
    const want = '#/' + p;
    if (location.hash !== want) location.hash = want;
  };

  const refreshAfterLogin = (u: string): void => {
    setUsername(u);
    setAuthState('ready');
    // 登录前想去的页面(如 /console#/install 直达被 401 打断)→ 登录后回续
    const returnHash = sessionStorage.getItem('qlong_return_hash');
    sessionStorage.removeItem('qlong_return_hash');
    if (returnHash && returnHash !== '#/login') {
      location.hash = returnHash;
      setPageState(pageFromHash());
    } else if (location.hash === '#/login') {
      location.hash = '';
      setPageState('dashboard');
    }
    loadTeams().then((ts) => { if (ts.length > 0) setTeamId((cur) => cur || ts[0].team_id); })
      .catch(() => { /* 未配置 owner 凭证时保持空,页面内提示 */ });
  };

  useEffect(() => {
    // 会话探测(Cookie):有效 → 进入控制台;无效 → 登录页(设计:未登录一律跳登录)
    authApi.me()
      .then((r) => { setCsrf(r.csrf); refreshAfterLogin(r.username); })
      .catch(() => {
        if (location.hash && location.hash !== '#/login') sessionStorage.setItem('qlong_return_hash', location.hash);
        setAuthState('login');
        location.hash = '#/login';
      });
    // v0.8:hashchange 只同步页面状态(会话探测只在挂载时做一次,导航不重发请求)
    const onHash = (): void => { setPageState(pageFromHash()); };
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
            <span aria-hidden>⏻</span><span className="logout-label">退出登录</span>
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
          {page === 'teams' && <Teams onOpen={(tid) => { setTeamId(tid); setPage('team-detail'); }} />}
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
