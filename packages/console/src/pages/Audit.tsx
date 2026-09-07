const AUDITS = [
  { ts: '2026-09-06 21:18:32', event: 'stale_attempt_rejected', color: '#4361ee', bg: '#eef2ff', node: '2c0f...37fa', team: '研发团队', reason: 'inbound attempt 1 < current 2' },
  { ts: '2026-09-06 21:17:15', event: 'reclaim', color: '#b8860b', bg: '#fff8e1', node: '2c0f...37fa', team: '研发团队', reason: 'lease lost' },
  { ts: '2026-09-06 21:15:03', event: 'sig_verify_failed', color: '#ea3943', bg: '#feecea', node: '8a1b...2c3d', team: '研发团队', reason: '验签失败' },
  { ts: '2026-09-06 21:12:40', event: 'dedup_mismatch', color: '#4361ee', bg: '#eef2ff', node: '2c0f...37fa', team: '研发团队', reason: '同键异体' },
];
export default function Audit() {
  return (<div><h1 style={{ fontSize: 22, marginBottom: 4 }}>审计日志</h1><p style={{ color: '#718096', fontSize: 13, marginBottom: 24 }}>安全与操作审计(只读)</p>
  <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20 }}>
  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
  <thead><tr>{['时间', '事件', '节点', '团队', '原因'].map(h => <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, color: '#718096', borderBottom: '1px solid #e2e8f0' }}>{h}</th>)}</tr></thead>
  <tbody>{AUDITS.map(a => (<tr key={a.ts}>
  <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0', fontFamily: 'monospace', fontSize: 12 }}>{a.ts}</td>
  <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0' }}><span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: a.bg, color: a.color }}>{a.event}</span></td>
  <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0', fontFamily: 'monospace', fontSize: 12 }}>{a.node}</td>
  <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0' }}>{a.team}</td>
  <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0' }}>{a.reason}</td>
  </tr>))}</tbody></table></div></div>);
}