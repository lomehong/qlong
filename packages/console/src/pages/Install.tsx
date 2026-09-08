import { useState } from 'react';
import { useStore } from '../store/useStore';

/**
 * 节点安装页(纪要 §4 入网体验的页面侧):
 * 生成一次性邀请码 → 按平台给出可复制的安装命令(https://lomehong-qlong.ms.show/install 的控制台版)。
 */
export default function Install({ teamId }: { teamId: string }) {
  const issueToken = useStore((s) => s.issueToken);
  const [token, setToken] = useState('');
  const [version, setVersion] = useState('latest');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');

  const unixCmd = token
    ? `curl -fsSL https://lomehong-qlong.ms.show/install.sh -o /tmp/qlong-install.sh && echo "${token}" | sh /tmp/qlong-install.sh --enroll-stdin${version !== 'latest' ? ` --version ${version}` : ''}`
    : '# 先生成邀请码';
  const winCmd = token
    ? `irm https://lomehong-qlong.ms.show/install.ps1 -OutFile "$env:TEMP\\qlong-install.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\qlong-install.ps1" -EnrollToken "${token}"${version !== 'latest' ? ` -Version ${version}` : ''}`
    : '# 先生成邀请码';

  const copy = (key: string, text: string): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(''), 1500);
    });
  };

  const generate = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await issueToken(teamId);
      setToken(r.token);
    } catch (e) {
      useStore.getState().setError('生成失败:' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const block = (key: string, title: string, cmd: string): React.ReactNode => (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <strong style={{ fontSize: 14 }}>{title}</strong>
        <button className="btn btn-ghost btn-sm" onClick={() => copy(key, cmd)} disabled={!token}>
          {copied === key ? '✓ 已复制' : '复制'}
        </button>
      </div>
      <pre className="code-block">{cmd}</pre>
    </div>
  );

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">节点安装</h1>
        <p className="page-sub">
          生成一次性邀请码,在目标设备执行对应命令:自动完成 下载 → SHA256 校验 → 注册入网 → 注册自启服务 → 验收入网状态。
        </p>
      </div>

      <div className="card">
        <div className="form-grid">
          <div className="field">
            <label className="field-label" htmlFor="install-version">安装版本</label>
            <select id="install-version" className="select" value={version} onChange={(e) => setVersion(e.target.value)}>
              <option value="latest">latest(最新)</option>
              <option value="0.1.0">v0.1.0</option>
            </select>
          </div>
          <button className="btn btn-primary" onClick={() => { void generate(); }} disabled={busy || !teamId}>
            {busy ? '生成中…' : '生成邀请码'}
          </button>
          {token && (
            <div style={{ fontSize: 12.5, color: 'var(--success)', alignSelf: 'center', flexBasis: '100%' }}>
              ✓ 邀请码已生成,有效期 30 分钟(单次使用,请尽快在目标设备完成安装)
            </div>
          )}
        </div>
      </div>

      {block('unix', 'Linux / macOS', unixCmd)}
      {block('win', 'Windows (PowerShell)', winCmd)}

      <p style={{ color: 'var(--text-3)', fontSize: 12.5, marginTop: 16 }}>
        说明:脚本会校验发布物 SHA256 后才执行;凭证落盘于设备 ~/.qlong(0600);卸载用 <code className="mono">qlong --uninstall</code>(含凭证清除)。
      </p>
    </div>
  );
}
