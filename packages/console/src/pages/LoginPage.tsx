import { useState } from 'react';
import { useStore } from '../store/useStore';
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

  const ensureMode = async (): Promise<void> => {
    try {
      const s = await authApi.status();
      setMode(s.needs_init ? 'init' : 'login');
    } catch {
      setError('无法连接服务');
      setMode('login');
    }
  };

  if (mode === 'loading') {
    void ensureMode().then(() => undefined);
  }

  const submit = async (): Promise<void> => {
    setError('');
    try {
      const r = mode === 'init'
        ? await authApi.register(username, password)
        : await authApi.login(username, password);
      onLogin(r.username);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const input: React.CSSProperties = {
    width: '100%', padding: '10px 12px', border: '1px solid #2a3145', borderRadius: 6,
    background: '#10162b', color: '#e6e9f0', fontSize: 14, boxSizing: 'border-box',
  };
  const btn: React.CSSProperties = {
    width: '100%', padding: '10px', marginTop: 14, border: 0, borderRadius: 6,
    background: '#4361ee', color: '#fff', fontSize: 14, cursor: 'pointer',
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0d1117' }}>
      <div style={{ width: 380, background: '#151b2e', border: '1px solid #2a3145', borderRadius: 10, padding: 32 }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 34 }}>🐉</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#fff', marginTop: 8 }}>群龙 Console</div>
          <div style={{ color: '#8892b0', fontSize: 12, marginTop: 6 }}>
            {mode === 'init' ? '首次使用:创建管理员账号' : '请登录(人类账号,非 Agent token)'}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input style={input} placeholder="用户名" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          <input style={input} placeholder="密码" type="password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            autoComplete={mode === 'init' ? 'new-password' : 'current-password'} />
          {error && <div style={{ color: '#f87171', fontSize: 12 }}>{error}</div>}
          <button style={btn} onClick={() => { void submit(); }} disabled={mode === 'loading'}>
            {mode === 'init' ? '创建管理员并登录' : '登录'}
          </button>
        </div>
        <div style={{ marginTop: 18, color: '#8892b0', fontSize: 11, lineHeight: 1.6 }}>
          说明:此账号是<b>人类操作者</b>身份(生成邀请码、管理节点)。
          Agent/节点不使用账号登录,而是经邀请码 enroll + 节点 token 接入。
        </div>
      </div>
    </div>
  );
}
