const TASKS = [
  { id: 'd41a...8b2c', type: 'project', team: '研发团队', lead: 'dev-machine', exec: 'build-server', attempt: '1/3', status: 'done', cls: 'g' },
  { id: 'a3b2...c1d0', type: 'aid', team: '研发团队', lead: 'dev-machine', exec: 'gpu-node', attempt: '2/3', status: 'running', cls: 'b' },
  { id: 'e7f2...1a4d', type: 'aid', team: '研发团队', lead: 'build-server', exec: 'gpu-node', attempt: '3/3', status: 'escalated', cls: 'r' },
  { id: 'f8c3...2e5a', type: 'project', team: '研究团队', lead: 'research-01', exec: 'research-02', attempt: '1/3', status: 'cancelled', cls: 'o' },
];
const badgeColors: Record<string, string> = { g: '#e6f9f0', b: '#eef2ff', r: '#feecea', o: '#fff8e1' };
const badgeText: Record<string, string> = { g: '#0a8f5c', b: '#4361ee', r: '#ea3943', o: '#b8860b' };
export default function Tasks() {
  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>任务管理</h1>
      <p style={{ color: '#718096', fontSize: 13, marginBottom: 24 }}>全部任务(跨团队)</p>
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['task_id', '类型', '团队', '牵头方', '执行方', 'attempt', '状态', '更新时间'].map(h => <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, color: '#718096', borderBottom: '1px solid #e2e8f0' }}>{h}</th>)}</tr></thead>
          <tbody>{TASKS.map(t => (
            <tr key={t.id}>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0', fontFamily: 'monospace', fontSize: 12 }}>{t.id}</td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>{t.type}</td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>{t.team}</td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>{t.lead}</td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>{t.exec}</td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>{t.attempt}</td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}><span style={{ padding: '2px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600, background: badgeColors[t.cls], color: badgeText[t.cls] }}>{t.status}</span></td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>{t.status === 'done' ? '2 分钟前' : t.status === 'running' ? '5 分钟前' : '1 小时前'}</td>
            </tr>))}
          </tbody>
        </table>
      </div>
    </div>
  );
}