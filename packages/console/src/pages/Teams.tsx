import { CopyChip } from '../components/CopyChip';

const TEAMS = [
  { name: '研发团队', id: '33333333-3333-4333-8333-333333333333', nodes: 5, online: 3, status: 'active', created: '2026-08-01' },
  { name: '研究团队', id: '34444444-4444-4444-8444-444444444444', nodes: 2, online: 1, status: 'active', created: '2026-08-10' },
];
export default function Teams({ onNav }: { onNav: (p: string) => void }) {
  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">团队管理</h1>
        <p className="page-sub">管理全部团队</p>
      </div>
      <div className="card card-flush">
        <div className="table-wrap">
          <table className="table">
            <thead><tr>{['团队名称', 'team_id', '节点数', '在线', '状态', '创建时间', ''].map(h => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{TEAMS.map(t => (
              <tr key={t.id} className="row-clickable" onClick={() => onNav('team-detail')}>
                <td><strong>{t.name}</strong></td>
                <td><CopyChip value={t.id} /></td>
                <td className="mono">{t.nodes}</td>
                <td className="mono">{t.online}</td>
                <td><span className="badge badge-success">{t.status}</span></td>
                <td>{t.created}</td>
                <td style={{ color: 'var(--accent)', fontSize: 13, whiteSpace: 'nowrap' }}>详情 →</td>
              </tr>))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
