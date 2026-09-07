const TEAMS = [
  { name: '研发团队', id: '33333333-...', nodes: 5, online: 3, status: 'active', created: '2026-08-01' },
  { name: '研究团队', id: '34444444-...', nodes: 2, online: 1, status: 'active', created: '2026-08-10' },
];
export default function Teams({ onNav }: { onNav: (p: string) => void }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>团队管理</h1>
      <p style={{ color: '#718096', fontSize: 13, marginBottom: 24 }}>管理全部团队</p>
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['团队名称', 'team_id', '节点数', '在线', '状态', '创建时间', ''].map(h => <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, color: '#718096', borderBottom: '1px solid #e2e8f0' }}>{h}</th>)}</tr></thead>
          <tbody>{TEAMS.map(t => (
            <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => onNav('team-detail')}>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}><strong>{t.name}</strong></td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0', fontFamily: 'monospace', fontSize: 12 }}>{t.id}</td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>{t.nodes}</td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>{t.online}</td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}><span style={{ padding: '2px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600, background: '#e6f9f0', color: '#0a8f5c' }}>{t.status}</span></td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>{t.created}</td>
              <td style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}><a onClick={e => { e.stopPropagation(); onNav('team-detail'); }}>详情 →</a></td>
            </tr>))}
          </tbody>
        </table>
      </div>
    </div>
  );
}