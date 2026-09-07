import { create } from 'zustand';
import { api } from '../api/client';

export interface AgentRecord { node_id: string; name: string; team_id: string; status: string; online: boolean; platform: string; version: string; key_epoch: number; caps_rev: number; last_seen: string; }
export interface GrantRecord { grant_id: string; from_team: string; to_team: string; caps_visible: string[]; expires_at?: number; }
export interface AuditRecord { ts: string; event: string; node: string; team: string; reason: string; trace_id?: string; }
export interface TeamOverview { team_id: string; nodes: AgentRecord[]; grants: GrantRecord[]; stats: { total: number; online: number }; }

interface Store {
  loading: boolean;
  error: string | null;
  overview: TeamOverview | null;
  agents: AgentRecord[];
  grants: GrantRecord[];
  audits: AuditRecord[];
  fetchOverview: (teamId: string) => Promise<void>;
  fetchGrants: (teamId: string) => Promise<void>;
  suspendAgent: (teamId: string, nodeId: string) => Promise<void>;
  resumeAgent: (teamId: string, nodeId: string) => Promise<void>;
  revokeAgent: (teamId: string, nodeId: string) => Promise<void>;
  createGrant: (teamId: string, to: string, caps: string[], ttlMs?: number) => Promise<void>;
  revokeGrant: (teamId: string, gid: string) => Promise<void>;
  issueToken: (teamId: string, ttlMs?: number) => Promise<{ node_token: string; expires_at: string }>;
  setError: (e: string | null) => void;
}
export const useStore = create<Store>()((set, get) => ({
  loading: false, error: null, overview: null, agents: [], grants: [], audits: [],
  setError: (e) => set({ error: e }),
  fetchOverview: async (teamId) => {
    set({ loading: true, error: null });
    try {
      const data = await api.get<TeamOverview>(`/v1/teams/${teamId}/overview`);
      set({ overview: data, agents: data.nodes ?? [], loading: false });
    } catch (e) { set({ error: (e as Error).message, loading: false }); }
  },
  fetchGrants: async (teamId) => {
    try { const d = await api.get<{ grants: GrantRecord[] }>(`/v1/teams/${teamId}/grants`); set({ grants: d.grants }); }
    catch (e) { set({ error: (e as Error).message }); }
  },
  suspendAgent: async (teamId, nodeId) => {
    await api.post(`/v1/teams/${teamId}/nodes/${nodeId}/suspend`);
    await get().fetchOverview(teamId);
  },
  resumeAgent: async (teamId, nodeId) => {
    await api.post(`/v1/teams/${teamId}/nodes/${nodeId}/resume`);
    await get().fetchOverview(teamId);
  },
  revokeAgent: async (teamId, nodeId) => {
    await api.del(`/v1/teams/${teamId}/nodes/${nodeId}`);
    await get().fetchOverview(teamId);
  },
  createGrant: async (teamId, to, caps, ttlMs) => {
    await api.post(`/v1/teams/${teamId}/grants`, { to_team: to, caps_visible: caps, ttl_ms: ttlMs });
    await get().fetchGrants(teamId);
  },
  revokeGrant: async (teamId, gid) => {
    await api.del(`/v1/teams/${teamId}/grants/${gid}`);
    await get().fetchGrants(teamId);
  },
  issueToken: async (teamId, ttlMs) => {
    return api.post<{ node_token: string; expires_at: string }>(`/v1/teams/${teamId}/enroll-tokens`, { ttl_ms: ttlMs });
  },
}));