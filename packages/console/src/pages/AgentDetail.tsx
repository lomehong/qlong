import { useStore } from '../store/useStore';
import { StatusDot } from '../components/StatusDot';
import { CopyChip } from '../components/CopyChip';
import { Loading } from '../components/ui';

export default function AgentDetail({ onBack, agentId }: { onBack: () => void; agentId: string }) {
  const { agents, suspendAgent, resumeAgent, revokeAgent } = useStore();
  // 按选中 id 取记录(此前恒取 agents[0],详情页永远显示第一个 Agent —— 真 bug 修复)
  const agent = agents.find((a) => a.node_id === agentId);
  if (!agent) return <Loading />;
  return (
    <div>
      <button type="button" className="back-link" onClick={onBack}>← 返回 Agent 列表</button>
      <div className="page-head">
        <h1 className="page-title">{agent.name || agent.node_id.slice(0, 8)}</h1>
        <p className="page-sub"><CopyChip value={agent.node_id} head={18} /></p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
        <div className="card">
          <h2 className="card-title">基本信息</h2>
          <dl className="dl">
            <dt>状态</dt><dd><StatusDot online={agent.online} status={agent.status} /></dd>
            <dt>平台</dt><dd>{agent.platform || '—'}</dd>
            <dt>版本</dt><dd>{agent.version || '—'}</dd>
            <dt>key_epoch</dt><dd className="mono">{agent.key_epoch}</dd>
            <dt>最近活跃</dt><dd>{agent.last_seen}</dd>
          </dl>
        </div>
        <div className="card">
          <h2 className="card-title">密钥信息</h2>
          <dl className="dl">
            <dt>当前纪元</dt><dd className="mono">{agent.key_epoch}</dd>
            <dt>caps_rev</dt><dd className="mono">{agent.caps_rev}</dd>
          </dl>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
        {agent.status === 'suspended' && <button className="btn btn-primary" onClick={() => resumeAgent(agent.team_id, agent.node_id).catch(e => useStore.getState().setError((e as Error).message))}>恢复</button>}
        {agent.status === 'active' && <button className="btn btn-ghost" onClick={() => suspendAgent(agent.team_id, agent.node_id).catch(e => useStore.getState().setError((e as Error).message))}>暂停</button>}
        <button className="btn btn-danger" onClick={() => { if (window.confirm('确认永久吊销? 此操作不可逆。')) revokeAgent(agent.team_id, agent.node_id).catch(e => useStore.getState().setError((e as Error).message)); }}>吊销</button>
      </div>
    </div>
  );
}
