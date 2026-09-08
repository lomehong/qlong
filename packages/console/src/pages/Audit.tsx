import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { CopyChip } from '../components/CopyChip';
import { Loading, Empty } from '../components/ui';

interface AuditEvent { ts: string; event: string; node: string; team: string; reason: string; trace_id?: string }
const eventBadge: Record<string, string> = {
  sig_verify_failed: 'badge-danger', escalate: 'badge-danger',
  reclaim: 'badge-warning', cap_tag_removed: 'badge-warning',
  stale_attempt_rejected: 'badge-info', dedup_mismatch: 'badge-info',
};
export default function Audit({ teamId }: { teamId: string }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!teamId) return;
    api.get<{ events: AuditEvent[] }>(`/v1/teams/${teamId}/audit`).then(d => setEvents(d.events)).catch(() => {}).finally(() => setLoading(false));
  }, [teamId]);
  if (loading) return <Loading />;
  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">审计日志</h1>
        <p className="page-sub">安全与操作审计(只读;P3:不记录 body)</p>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr>{['时间', '事件', '节点', '原因', 'trace_id'].map(h => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{events.map((e, i) => (
              <tr key={i}>
                <td className="mono">{e.ts}</td>
                <td><span className={`badge ${eventBadge[e.event] ?? 'badge-neutral'}`}>{e.event}</span></td>
                <td className="mono">{e.node}</td>
                <td>{e.reason}</td>
                <td>{e.trace_id ? <CopyChip value={e.trace_id} /> : '—'}</td>
              </tr>
            ))}
            </tbody>
          </table>
          {events.length === 0 && <Empty icon="📜" text="暂无审计事件" />}
        </div>
      </div>
    </div>
  );
}
