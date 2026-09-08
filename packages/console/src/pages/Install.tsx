import { useState } from 'react';
import { useStore } from '../store/useStore';

/**
 * 节点安装页(纪要 §4 入网体验的页面侧):
 * 生成一次性邀请码 → 按平台给出可复制的安装命令(https://lomehong-qlong.ms.show/install 的控制台版)。
 */
export default function Install({ teamId }: { teamId: string }) {
  const issueToken = useStore((s) => s.issueToken);
  const [token, setToken] = useState('');
  const [expires, setExpires] = useState('');
  const [version, setVersion] = useState('latest');
  const [busy, setBusy] = useState(false);

  const unixCmd = token
    ? `curl -fsSL https://lomehong-qlong.ms.show/install.sh -o /tmp/qlong-install.sh && echo "${token}" | sh /tmp/qlong-install.sh --enroll-stdin${version !== 'latest' ? ` --version ${version}` : ''}`
    : '# 先生成邀请码';
  const winCmd = token
    ? `irm https://lomehong-qlong.ms.show/install.ps1 -OutFile "$env:TEMP\\qlong-install.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\qlong-install.ps1" -EnrollToken "${token}"${version !== 'latest' ? ` -Version ${version}` : ''}`
    : '# 先生成邀请码';

  const copy = (text: string): void => {
    void navigator.clipboard.writeText(text);
  };

  const generate = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await issueToken(teamId);
      setToken(r.token);
      setExpires('邀请码有效期 30 分钟(单次使用),请尽快在目标设备完成安装');
    } catch (e) {
      alert('生成失败:' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const block = (title: string, cmd: string): React.ReactNode => (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <strong style={{ fontSize: 14 }}>{title}</strong>
        <button onClick={() => copy(cmd)} style={{ padding: '4px 12px', border: '1px solid #cbd5e0', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 12 }}>复制</button>
      </div>
      <pre style={{ background: '#0d1117', color: '#7ee787', padding: 14, borderRadius: 8, overflowX: 'auto', fontSize: 12, whiteSpace: 'pre-wrap' }}>{cmd}</pre>
    </div>
  );

  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>节点安装</h1>
      <p style={{ color: '#718096', fontSize: 13, marginBottom: 24 }}>
        生成一次性邀请码,在目标设备执行对应命令:自动完成 下载 → SHA256 校验 → 注册入网 → 注册自启服务 → 验收入网状态。
      </p>

      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20, marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 12, color: '#718096', marginBottom: 4 }}>安装版本</div>
            <select value={version} onChange={(e) => setVersion(e.target.value)}
              style={{ padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 13 }}>
              <option value="latest">latest(最新)</option>
              <option value="0.1.0">v0.1.0</option>
            </select>
          </div>
          <button onClick={() => { void generate(); }} disabled={busy}
            style={{ padding: '9px 18px', border: 0, borderRadius: 6, background: '#4361ee', color: '#fff', cursor: 'pointer', fontSize: 13 }}>
            {busy ? '生成中…' : '生成邀请码'}
          </button>
          {token && (
            <div style={{ fontSize: 12, color: '#0a8f5c' }}>
              邀请码已生成,有效期至 {expires}(单次使用,请尽快在目标设备完成安装)
            </div>
          )}
        </div>
      </div>

      {block('Linux / macOS', unixCmd)}
      {block('Windows (PowerShell)', winCmd)}

      <p style={{ color: '#718096', fontSize: 12 }}>
        说明:脚本会校验发布物 SHA256 后才执行;凭证落盘于设备 ~/.qlong(0600);卸载用 <code>qlong --uninstall</code>(含凭证清除)。
      </p>
    </div>
  );
}
