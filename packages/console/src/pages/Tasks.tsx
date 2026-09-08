import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { api } from '../api/client';

interface TaskRow { task_id: string; type: string; team_id: string; lead: string; exec: string; attempt: number; status: string; updated_at: string; }
const statusColors: Record<string, { bg: string; fg: string }> = {
  running: { bg: '#eef2ff', fg: '#4361ee' }, done: { bg: '#e6f9f0', fg: '#0a8f5c' },
  escalated: { bg: '#feecea', fg: '#ea3943' }, cancelled: { bg: '#fff8e1', fg: '#b8860b' },
  failed: { bg: '#feecea', fg: '#ea3943' },
};
export default function Tasks({ teamId }: { teamId: string }) {
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!teamId) return;
    api.get<{ tasks: TaskRow[] }>(`/v1/teams/${teamId}/tasks`).then(d => setTasks(d.tasks)).catch(() => {}).finally(() => setLoading(false));
  }, [teamId]);
  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#718096' }}>加载中...</div>;
  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>任务管理</h1>
      <p style={{ color: '#718096', fontSize: 13, marginBottom: 24 }}>全部任务(跨团队)</p>
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['task_id', '类型', '牵头方', '执行方', 'attempt', '状态', '更新时间'].map(h => <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, color: '#718096', borderBottom: '1px solid #e2e8f0' }}>{h}</th>)}</tr></thead>
          <tbody>{tasks.map(t => {
            const sc = statusColors[t.status] ?? statusColors.running!;
            return (
              <tr key={t.task_id}>
                <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0', fontFamily: 'monospace', fontSize: 12 }}>{t.task_id.slice(0, 12)}...</td>
                <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0' }}>{t.type}</td>
                <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0' }}>{t.lead}</td>
                <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0' }}>{t.exec}</td>
                <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0' }}>{t.attempt}/3</td>
                <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0' }}><span style={{ padding: '2px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600, background: sc.bg, color: sc.fg }}>{t.status}</span></td>
                <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0' }}>{new Date(t.updated_at).toLocaleString()}</td>
              </tr>
            );
          })}
          {tasks.length === 0 && <tr><td colSpan={7} style={{ padding: 40, textAlign: 'center', color: '#718096' }}>暂无任务</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}