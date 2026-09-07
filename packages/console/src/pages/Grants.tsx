export default function Grants() {
  return (<div><h1 style={{ fontSize: 22, marginBottom: 4 }}>跨队授权</h1><p style={{ color: '#718096', fontSize: 13, marginBottom: 24 }}>全局 Grant 管理</p>
  <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20 }}>
  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
  <thead><tr>{['方向', 'from_team', 'to_team', 'caps_visible', '状态', ''].map(h => <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, color: '#718096', borderBottom: '1px solid #e2e8f0' }}>{h}</th>)}</tr></thead>
  <tbody>
  <tr><td style={{ padding: 12, borderBottom: '1px solid #e2e8f0' }}>X → Y</td><td style={{ padding: 12, borderBottom: '1px solid #e2e8f0', fontFamily: 'monospace', fontSize: 12 }}>33333...</td><td style={{ padding: 12, borderBottom: '1px solid #e2e8f0', fontFamily: 'monospace', fontSize: 12 }}>44444...</td><td style={{ padding: 12, borderBottom: '1px solid #e2e8f0' }}><span style={{ padding: '1px 8px', borderRadius: 12, fontSize: 11, background: '#eef2ff', color: '#4361ee' }}>tool:node@20</span></td><td style={{ padding: 12, borderBottom: '1px solid #e2e8f0' }}><span style={{ padding: '2px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600, background: '#e6f9f0', color: '#0a8f5c' }}>活跃</span></td><td style={{ padding: 12 }}><button style={{ padding: '4px 10px', fontSize: 12, borderRadius: 6, border: 'none', background: '#ea3943', color: '#fff' }}>撤销</button></td></tr>
  </tbody></table></div></div>);
}