import { apiFetch } from './api';

export interface TeamMember {
  id: string;
  rep_user_id: string;
  role: 'rep' | 'manager';
  display_name: string;
  status: 'active' | 'disabled';
  created_at: string;
  phone_number: string | null;
  email?: string;
  stats: {
    calls_7d: number;
    calls_total: number;
    minutes_7d: number;
    leads_total: number;
    leads_dialed: number;
    campaigns_total: number;
    campaigns_active: number;
  };
}

export const teamApi = {
  list: () => apiFetch<TeamMember[]>('/team'),

  invite: (email: string, password: string, display_name?: string, role: 'rep' | 'manager' = 'rep') =>
    apiFetch<TeamMember>('/team', {
      method: 'POST',
      body: JSON.stringify({ email, password, display_name, role }),
    }),

  update: (repUserId: string, updates: { display_name?: string; role?: 'rep' | 'manager'; status?: 'active' | 'disabled' }) =>
    apiFetch<TeamMember>(`/team/${repUserId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }),

  remove: (repUserId: string) =>
    apiFetch(`/team/${repUserId}`, { method: 'DELETE' }),
};
