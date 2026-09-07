import { useStore } from '../store/useStore';
import { StatusDot } from '../components/StatusDot';
export default function AgentDetail({ onBack }: { onBack: () => void }) {
  const { agents, suspendAgent, resumeAgent, revokeAgent } = useStore();
  const agent = agents[0];
  if (!agent) return <div style={{ padding: 40, textAlign: 'center', color: '#718096' }}>加载中...</div>;
  return (
    <div>
      <a onClick={onBack} style={{ color: '#718096', fontSize: 13, cursor: 'pointer', display: 'inline-flex', marginBottom: 16 }}>← 返回 Agent 列表</a>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>{agent.name || agent.node_id.slice(0, 8)}</h1>
      <p style={{ color: '#718096', fontSize: 13, marginBottom: 24, fontFamily: 'monospace' }}>{agent.node_id}</p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>基本信息</h2>
          <dl style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 6, fontSize: 13 }}>
            <dt style={{ color: '#718096' }}>状态</dt><dd><StatusDot online={agent.online} status={agent.status} /></dd>
            <dt style={{ color: '#718096' }}>平台</dt><dd>{agent.platform || '—'}</dd>
            <dt style={{ color: '#718096' }}>版本</dt><dd>{agent.version || '—'}</dd>
            <dt style={{ color: '#718096' }}>key_epoch</dt><dd style={{ fontFamily: 'monospace' }}>{agent.key_epoch}</dd>
            <dt style={{ color: '#718096' }}>最近活跃</dt><dd>{agent.last_seen}</dd>
          </dl>
        </div>
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>密钥信息</h2>
          <dl style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 6, fontSize: 13 }}>
            <dt style={{ color: '#718096' }}>当前纪元</dt><dd style={{ fontFamily: 'monospace' }}>{agent.key_epoch}</dd>
            <dt style={{ color: '#718096' }}>caps_rev</dt><dd>{agent.caps_rev}</dd>
          </dl>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        {agent.status === 'suspended' && <button onClick={() => resumeAgent('33333333-3333-4333-8333-333333333333', agent.node_id).catch(e => useStore.getState().setError((e as Error).message))} style={{ padding: '7px 16px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer' }}>恢复</button>}
        {agent.status === 'active' && <button onClick={() => suspendAgent('33333333-3333-4333-8333-333333333333', agent.node_id).catch(e => useStore.getState().setError((e as Error).message))} style={{ padding: '7px 16px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer' }}>暂停</button>}
        <button onClick={() => { if (window.confirm('确认永久吊销? 此操作不可逆。')) revokeAgent('33333333-3333-4333-8333-333333333333', agent.node_id).catch(e => useStore.getState().setError((e as Error).message)); }} style={{ padding: '7px 16px', borderRadius: 6, border: 'none', background: '#ea3943', color: '#fff', cursor: 'pointer' }}>吊销</button>
      </div>
    </div>
  );
}