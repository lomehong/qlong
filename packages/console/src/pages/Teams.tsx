import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { CopyChip } from '../components/CopyChip';
import { Empty } from '../components/ui';

const STATE_LABEL: Record<string, { text: string; cls: string }> = {
  active: { text: 'active', cls: 'badge badge-success' },
  'self-owned': { text: 'self-owned', cls: 'badge badge-success' },
  orphan: { text: 'orphan', cls: 'badge badge-warning' },
};

export default function Teams({ onOpen }: { onOpen: (teamId: string) => void }) {
  const { teams, loadTeams } = useStore();
  const [loading, setLoading] = useState(true);
  useEffect(() => { loadTeams().catch(() => {}).finally(() => setLoading(false)); }, [loadTeams]);
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
            <tbody>{teams.map(t => {
              const st = STATE_LABEL[t.state] ?? { text: t.state, cls: 'badge' };
              return (
                <tr key={t.team_id} className="row-clickable" onClick={() => onOpen(t.team_id)}>
                  <td><strong>{t.name}</strong></td>
                  <td><CopyChip value={t.team_id} /></td>
                  <td className="mono">{t.nodes}</td>
                  <td className="mono">{t.online}</td>
                  <td><span className={st.cls}>{st.text}</span></td>
                  <td>{t.created_at?.slice(0, 10) || '—'}</td>
                  <td style={{ color: 'var(--accent)', fontSize: 13, whiteSpace: 'nowrap' }}>详情 →</td>
                </tr>
              );
            })}</tbody>
          </table>
          {teams.length === 0 && !loading && <Empty icon="🏢" text="暂无团队——安装第一个节点后自动创建" />}
        </div>
      </div>
    </div>
  );
}
