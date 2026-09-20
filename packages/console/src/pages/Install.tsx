import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { fetchDshVersions, type DshVersionInfo } from '../api/dsh';

const DIST_BASE = 'https://lomehong-qlong.ms.show';

/** Agent 类型定义(新运行时在此追加) */
const AGENT_TYPES = [
  { id: 'dsh', label: 'DeepSeek Harness(dsh)', npmPackage: '@deepseek-ai/dsh' },
  { id: 'omp', label: 'Oh-My-Pi(pi)', npmPackage: '@oh-my-pi/pi-coding-agent' },
] as const;

type AgentTypeId = (typeof AGENT_TYPES)[number]['id'];

/**
 * 节点安装页:单行安装体验。
 * 生成个性化安装 URL(邀请码嵌入路径)→ 用户复制一行 `irm … | iex` 即可。
 * Agent 类型选择决定安装器装载哪个运行时(dsh / oh-my-pi)。
 */
export default function Install({ teamId }: { teamId: string }) {
  const issueToken = useStore((s) => s.issueToken);
  const [token, setToken] = useState('');
  const [agentType, setAgentType] = useState<AgentTypeId>('dsh');
  const [dshVersion, setDshVersion] = useState('latest');
  const [dshInfo, setDshInfo] = useState<DshVersionInfo | null>(null);
  const [dshError, setDshError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchDshVersions()
      .then((info) => { if (alive) setDshInfo(info); })
      .catch(() => { if (alive) setDshError(true); });
    return () => { alive = false; };
  }, []);

  const oneLiner = token ? `irm ${DIST_BASE}/install/${agentType}/${token} | iex` : '# 先生成邀请码';

  const copy = (): void => {
    void navigator.clipboard.writeText(oneLiner).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const generate = async (): Promise<void> => {
    setBusy(true);
    setToken('');
    try {
      const r = await issueToken(teamId);
      setToken(r.token);
    } catch (e) {
      useStore.getState().setError('生成失败:' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">节点安装</h1>
        <p className="page-sub">
          选择 Agent 类型 → 生成邀请码 → 在目标设备粘贴一行命令:自动完成 运行时安装 → 入网 → 自启 → 上线。
        </p>
      </div>

      <div className="card">
        <div className="form-grid">
          <div className="field">
            <label className="field-label" htmlFor="agent-type">Agent 类型</label>
            <select id="agent-type" className="select" value={agentType} onChange={(e) => setAgentType(e.target.value as AgentTypeId)}>
              {AGENT_TYPES.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </div>
          {agentType === 'dsh' && (
            <div className="field">
              <label className="field-label" htmlFor="dsh-version">dsh 运行时版本</label>
              <select id="dsh-version" className="select" value={dshVersion} onChange={(e) => setDshVersion(e.target.value)}>
                {dshInfo ? (
                  <>
                    {Object.entries(dshInfo.tags).map(([tag, v]) => (
                      <option key={tag} value={v}>{tag}(= {v})</option>
                    ))}
                    {dshInfo.versions.map((v) => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </>
                ) : (
                  <option value="latest">{dshError ? 'latest(加载失败)' : '加载中…'}</option>
                )}
              </select>
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
                固定版本安装到客户端(离线可用);不装则任务时走 npx。
              </div>
            </div>
          )}
          <button className="btn btn-primary" onClick={() => { void generate(); }} disabled={busy || !teamId}>
            {busy ? '生成中…' : '生成安装命令'}
          </button>
          {token && (
            <div style={{ fontSize: 12.5, color: 'var(--success)', alignSelf: 'center', flexBasis: '100%' }}>
              ✓ 安装命令已生成——复制下面这行,在目标设备 PowerShell 里粘贴回车即可
            </div>
          )}
        </div>
      </div>

      {token && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <strong style={{ fontSize: 14 }}>安装命令(复制粘贴回车)</strong>
            <button className="btn btn-ghost btn-sm" onClick={copy}>复制</button>
          </div>
          <pre className="code-block" style={{ fontSize: 14 }}>{oneLiner}</pre>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>
            安装器自动完成:下载 → SHA256 校验 → Agent 运行时安装 → 入网 → 自启 → 上线。
            卸载:<code className="mono">qlong --uninstall</code>(含凭证清除)。
          </div>
        </div>
      )}
    </div>
  );
}
