
export default function Settings() {
  return (<div><h1 style={{ fontSize: 22, marginBottom: 4 }}>系统设置</h1>
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