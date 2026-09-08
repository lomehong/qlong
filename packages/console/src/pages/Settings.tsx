import { useState } from 'react';
import { setOwnerToken } from '../api/client';

function OwnerTokenCard() {
  const [val, setVal] = useState(localStorage.getItem('qlong_owner_token') ?? '');
  const [saved, setSaved] = useState(false);
  return (
    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20, marginBottom: 20 }}>
      <strong style={{ fontSize: 14 }}>Owner 访问密钥</strong>
      <p style={{ color: '#718096', fontSize: 12, margin: '6px 0 12px' }}>
        与创空间环境变量 QLONG_OWNER_TOKEN 同值;用于生成邀请码、暂停/吊销节点等 owner 操作。
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={val} onChange={(e) => setVal(e.target.value)} placeholder="粘贴 QLONG_OWNER_TOKEN"
          style={{ flex: 1, maxWidth: 420, padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 13 }} />
        <button onClick={() => { setOwnerToken(val); setSaved(true); }}
          style={{ padding: '8px 16px', border: 0, borderRadius: 6, background: '#4361ee', color: '#fff', cursor: 'pointer', fontSize: 13 }}>保存</button>
      </div>
      {saved && <div style={{ color: '#0a8f5c', fontSize: 12, marginTop: 8 }}>已保存(本机 localStorage)</div>}
    </div>
  );
}

export default function Settings() {
  return (<div><OwnerTokenCard /><h1 style={{ fontSize: 22, marginBottom: 4 }}>系统设置</h1>
  <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20, marginBottom: 20 }}>
  <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>全局参数</h2>
  <dl style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 6, fontSize: 13 }}>
  {['offer TTL(project):300s', 'lease(project):400s', 'max_attempts:3', 'max_dispatch_rounds:3', 'exp 漂移预算:10 分钟', 'max_hops:8'].map(s => { const [k, v] = s.split(':'); return <div key={k} style={{ display: 'contents' }}><dt style={{ color: '#718096' }}>{k}</dt><dd style={{ margin: 0 }}>{v}</dd></div>; })}
  </dl></div>
  <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20 }}>
  <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Owner</h2>
  <dl style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 6, fontSize: 13 }}>
  <dt style={{ color: '#718096' }}>owner_user_id</dt><dd style={{ margin: 0 }}>u1</dd>
  <dt style={{ color: '#718096' }}>邮箱</dt><dd style={{ margin: 0 }}>owner@qlong.io</dd>
  </dl></div></div>);
}