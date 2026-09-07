import { useEffect } from 'react';
import { useStore } from '../store/useStore';

export default function Audit({ teamId }: { teamId: string }) {
  const { fetchOverview, overview } = useStore();
  useEffect(() => { if (teamId) fetchOverview(teamId); }, [teamId]);
  return (<div><h1 style={{ fontSize: 22, marginBottom: 4 }}>审计日志</h1><p style={{ color: '#718096', fontSize: 13, marginBottom: 24 }}>安全与操作审计(只读)</p>
  <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 20 }}>
  <p style={{ color: '#718096', fontSize: 13 }}>审计事件通过 GET /v1/teams/{'{'}teamId{'}'}/audit 获取;后端路由已就绪(registry logAudit/getAuditEvents)。</p>
  </div></div>);
}