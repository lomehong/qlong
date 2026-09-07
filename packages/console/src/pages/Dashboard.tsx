const stats = [
  { n: 8, label: 'Agent 总数', target: 'agents' as const },
  { n: 5, label: '在线', target: 'agents' as const },
  { n: 3, label: '进行中任务', target: 'tasks' as const },
  { n: 47, label: '近 24h 审计', target: 'audit' as const },
];
const teams = [
  { name: '研发团队', nodes: 5, online: 3, status: 'active' },
  { name: '研究团队', nodes: 2, online: 1, status: 'active' },
];
const audits = [
  { ts: '21:18:32', event: 'stale_attempt_rejected', cls: 'ev-blu', reason: 'inbound attempt 1 < current 2' },
  { ts: '21:17:15', event: 'reclaim', cls: 'ev-org', reason: 'lease lost' },
  { ts: '21:15:03', event: 'sig_verify_failed', cls: 'ev-red', reason: '验签失败' },
];
export default function Dashboard({ onNav }: { onNav: (p: string) => void }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>总览</h1>
      <p style={{ color: '#718096', fontSize: 13, marginBottom: 24 }}>全平台聚合数据</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16, marginBottom: 24 }}>
        {stats.map(s => (
          <div key={s.label} onClick={() => onNav(s.target)} style={{ background: '#fff', borderRadius: 8, padding: 18, border: '1px solid #e2e8f0', cursor: 'pointer' }}>
            <div style={{ fontSize: 30, fontWeight: 700 }}>{s.n}</div>
            <div style={{ fontSize: 12, color: '#718096', marginTop: 4 }}>{s.label}</div>
          </div>
        ))}
      </div>
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>团队概况</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['团队', '节点数', '在线', '状态'].map(h => <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, color: '#718096', borderBottom: '1px solid #e2e8f0' }}>{h}</th>)}</tr></thead>
          <tbody>{teams.map(t => (
            <tr key={t.name}>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}><strong>{t.name}</strong></td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>{t.nodes}</td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>{t.online}</td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}><span style={{ padding: '2px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600, background: '#e6f9f0', color: '#0a8f5c' }}>{t.status}</span></td>
            </tr>))}
          </tbody>
        </table>
      </div>
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>最近审计事件</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['时间', '事件', '原因'].map(h => <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, color: '#718096', borderBottom: '1px solid #e2e8f0' }}>{h}</th>)}</tr></thead>
          <tbody>{audits.map(a => (
            <tr key={a.ts}>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0', fontFamily: 'monospace', fontSize: 12 }}>{a.ts}</td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}><span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: a.cls === 'ev-red' ? '#feecea' : a.cls === 'ev-org' ? '#fff8e1' : '#eef2ff', color: a.cls === 'ev-red' ? '#ea3943' : a.cls === 'ev-org' ? '#b8860b' : '#4361ee' }}>{a.event}</span></td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>{a.reason}</td>
            </tr>))}
          </tbody>
        </table>
      </div>
    </div>
  );
}