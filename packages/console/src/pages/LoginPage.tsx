import { useEffect, useState } from 'react';
import { authApi } from '../api/auth';

/**
 * 登录/初始化页(02 §3.1:人类经账号密码登录;未登录时控制台一律跳转到此)。
 * 服务端无任何账号时显示"初始化管理员"表单(仅允许创建第一个账号,之后关闭)。
 */
export default function LoginPage({ onLogin }: { onLogin: (username: string) => void }) {
  const [mode, setMode] = useState<'loading' | 'login' | 'init'>('loading');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    authApi.status()
      .then((s) => { if (alive) setMode(s.needs_init ? 'init' : 'login'); })
      .catch(() => { if (alive) { setError('无法连接服务'); setMode('login'); } });
    return () => { alive = false; };
  }, []);

  const submit = async (): Promise<void> => {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const r = mode === 'init'
        ? await authApi.register(username, password)
        : await authApi.login(username, password);
      onLogin(r.username);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-bg">
      <div className="login-card">
        <div style={{ textAlign: 'center', marginBottom: 26 }}>
          <div style={{ fontSize: 36 }} aria-hidden>🐉</div>
          <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', color: '#fff', marginTop: 10 }}>群龙 Console</div>
          <div style={{ color: '#8e97b1', fontSize: 12.5, marginTop: 6 }}>
            {mode === 'init' ? '首次使用:创建管理员账号' : '请登录(人类账号,非 Agent token)'}
          </div>
        </div>
        <form
          style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
          onSubmit={(e) => { e.preventDefault(); void submit(); }}
        >
          <input className="login-input" placeholder="用户名" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
          <input className="login-input" placeholder="密码" type="password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'init' ? 'new-password' : 'current-password'} />
          {error && <div role="alert" style={{ color: '#f87171', fontSize: 12.5 }}>{error}</div>}
          <button type="submit" className="btn btn-primary" style={{ width: '100%', padding: 10, fontSize: 14, marginTop: 4 }} disabled={mode === 'loading' || busy}>
            {busy ? '提交中…' : mode === 'init' ? '创建管理员并登录' : '登录'}
          </button>
        </form>
      </div>
    </div>
  );
}
