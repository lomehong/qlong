import { AGENTS, StatusDot } from './Agents';
export default function AgentDetail({ onBack }: { onBack: () => void }) {
  const agent = AGENTS[0];
  return (
    <div>
      <a onClick={onBack} style={{ color: '#718096', fontSize: 13, cursor: 'pointer', display: 'inline-flex', marginBottom: 16 }}>← 返回 Agent 列表</a>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>{agent.name}</h1>
      <p style={{ color: '#718096', fontSize: 13, marginBottom: 24, fontFamily: 'monospace' }}>{agent.id}</p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>基本信息</h2>
          <dl style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 6, fontSize: 13 }}>
            <dt style={{ color: '#718096' }}>所属团队</dt><dd>{agent.team}</dd>
            <dt style={{ color: '#718096' }}>平台</dt><dd>{agent.platform}</dd>
            <dt style={{ color: '#718096' }}>状态</dt><dd><StatusDot online={agent.online} status={agent.status} /></dd>
            <dt style={{ color: '#718096' }}>最近活跃</dt><dd>{agent.lastSeen}</dd>
          </dl>
        </div>
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>密钥信息</h2>
          <dl style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 6, fontSize: 13 }}>
            <dt style={{ color: '#718096' }}>当前纪元</dt><dd style={{ fontFamily: 'monospace' }}>{agent.epoch}</dd>
            <dt style={{ color: '#718096' }}>公钥指纹</dt><dd style={{ fontFamily: 'monospace' }}>{agent.id}...</dd>
          </dl>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <button style={{ padding: '7px 16px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer' }}>恢复</button>
        <button style={{ padding: '7px 16px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer' }}>暂停</button>
        <button style={{ padding: '7px 16px', borderRadius: 6, border: 'none', background: '#ea3943', color: '#fff', cursor: 'pointer' }}>吊销</button>
      </div>
    </div>
  );
}