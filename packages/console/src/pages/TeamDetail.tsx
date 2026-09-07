import { useState } from 'react';
export default function TeamDetail({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState('members');
  const tabs = [
    { key: 'members', label: '成员' }, { key: 'tokens', label: 'Enroll Token' },
    { key: 'grants', label: '跨队授权' }, { key: 'settings', label: '设置' },
  ];
  return (
    <div>
      <a onClick={onBack} style={{ color: '#718096', fontSize: 13, cursor: 'pointer', display: 'inline-flex', marginBottom: 16 }}>← 返回团队列表</a>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>研发团队</h1>
      <p style={{ color: '#718096', fontSize: 13, marginBottom: 24, fontFamily: 'monospace' }}>team_id: 33333333-3333-4333-8333-333333333333</p>
      <div style={{ display: 'flex', borderBottom: '2px solid #e2e8f0', marginBottom: 20 }}>
        {tabs.map(t => (
          <a key={t.key} onClick={() => setTab(t.key)} style={{ padding: '10px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: tab === t.key ? '#4361ee' : '#718096', borderBottom: tab === t.key ? '2px solid #4361ee' : '2px solid transparent', marginBottom: -2 }}>{t.label}</a>
        ))}
      </div>
      {tab === 'members' && <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20 }}><h2>团队成员</h2><p style={{ color: '#718096', fontSize: 13 }}>5 个节点(dev-machine/build-server/gpu-node/macbook-pro/old-laptop),点击 Agent 管理查看详情。</p></div>}
      {tab === 'tokens' && <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20 }}><h2>Enroll Token</h2><p style={{ color: '#718096', fontSize: 13 }}>Token 签发/活跃/已消费列表(见原型)。</p></div>}
      {tab === 'grants' && <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20 }}><h2>跨队授权</h2><p style={{ color: '#718096', fontSize: 13 }}>本团队的 Grant 管理(见原型)。</p></div>}
      {tab === 'settings' && <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20 }}><h2>设置</h2><p style={{ color: '#718096', fontSize: 13 }}>团队基本信息 + Danger Zone(见原型)。</p></div>}
    </div>
  );
}