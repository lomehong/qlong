import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { CopyChip } from '../components/CopyChip';
import { Loading, Empty } from '../components/ui';

interface TaskRow { task_id: string; type: string; team_id: string; lead: string; exec: string; attempt: number; status: string; updated_at: string; }
const statusBadge: Record<string, string> = {
  running: 'badge-info', done: 'badge-success',
  escalated: 'badge-danger', failed: 'badge-danger',
  cancelled: 'badge-warning',
};
export default function Tasks({ teamId }: { teamId: string }) {
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!teamId) return;
    api.get<{ tasks: TaskRow[] }>(`/v1/teams/${teamId}/tasks`).then(d => setTasks(d.tasks)).catch(() => {}).finally(() => setLoading(false));
  }, [teamId]);
  if (loading) return <Loading />;
  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">任务管理</h1>
        <p className="page-sub">全部任务(跨团队)</p>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr>{['task_id', '类型', '牵头方', '执行方', 'attempt', '状态', '更新时间'].map(h => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{tasks.map(t => (
              <tr key={t.task_id}>
                <td><CopyChip value={t.task_id} head={12} /></td>
                <td>{t.type}</td>
                <td>{t.lead}</td>
                <td>{t.exec}</td>
                <td className="mono">{t.attempt}/3</td>
                <td><span className={`badge ${statusBadge[t.status] ?? 'badge-neutral'}`}>{t.status}</span></td>
                <td>{new Date(t.updated_at).toLocaleString()}</td>
              </tr>
            ))}</tbody>
          </table>
          {tasks.length === 0 && <Empty icon="📋" text="暂无任务" />}
        </div>
      </div>
    </div>
  );
}
