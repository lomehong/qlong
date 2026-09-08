import { useEffect, useState } from 'react';
import { api } from '../api/client';

interface AuditEvent { ts: string; event: string; node: string; team: string; reason: string; trace_id?: string }
const eventColors: Record<string, string> = {
  sig_verify_failed: '#ea3943', escalate: '#ea3943',
  reclaim: '#b8860b', cap_tag_removed: '#b8860b',
  stale_attempt_rejected: '#4361ee', dedup_mismatch: '#4361ee',
};
export default function Audit({ teamId }: { teamId: string }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!teamId) return;
    api.get<{ events: AuditEvent[] }>(`/v1/teams/${teamId}/audit`).then(d => setEvents(d.events)).catch(() => {}).finally(() => setLoading(false));
  }, [teamId]);
  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#718096' }}>加载中...</div>;
  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>审计日志</h1>
      <p style={{ color: '#718096', fontSize: 13, marginBottom: 24 }}>安全与操作审计(只读;P3:不记录 body)</p>
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['时间', '事件', '节点', '原因', 'trace_id'].map(h => <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, color: '#718096', borderBottom: '1px solid #e2e8f0' }}>{h}</th>)}</tr></thead>
          <tbody>{events.map((e, i) => (
            <tr key={i}>
              <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0', fontFamily: 'monospace', fontSize: 12 }}>{e.ts}</td>
              <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0' }}><span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: eventColors[e.event] ? '#f5f5f5' : '#f1f5f9', color: eventColors[e.event] ?? '#718096' }}>{e.event}</span></td>
              <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0', fontFamily: 'monospace', fontSize: 12 }}>{e.node}</td>
              <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0' }}>{e.reason}</td>
              <td style={{ padding: 12, borderBottom: '1px solid #e2e8f0', fontFamily: 'monospace', fontSize: 12 }}>{e.trace_id || '—'}</td>
            </tr>
          ))}
          {events.length === 0 && <tr><td colSpan={5} style={{ padding: 40, textAlign: 'center', color: '#718096' }}>暂无审计事件</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}