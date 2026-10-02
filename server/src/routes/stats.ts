import { Router, Response, NextFunction } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

router.get('/dashboard', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const user_id = req.user.id;

    // Run parallel queries since postgrest doesn't easily let us do multi-table aggregate in one query
    const [campaignsResult, leadsResult, callsResult] = await Promise.all([
      req.db!.database.from('campaigns').select('id', { count: 'exact', head: true }).eq('user_id', user_id),
      req.db!.database.from('leads').select('id', { count: 'exact', head: true }).eq('user_id', user_id),
      // Count actual distinct call logs
      req.db!.database.from('call_logs').select('id', { count: 'exact', head: true }).eq('user_id', user_id)
    ]);

    if (campaignsResult.error) throw new ApiError(500, campaignsResult.error.message, 'db_error');
    if (leadsResult.error) throw new ApiError(500, leadsResult.error.message, 'db_error');
    if (callsResult.error) throw new ApiError(500, callsResult.error.message, 'db_error');

    res.json({
      data: {
        totalCampaigns: campaignsResult.count || 0,
        totalLeads: leadsResult.count || 0,
        totalCallsMade: callsResult.count || 0,
      }
    });
  } catch (error) {
    next(error);
  }
});

// ── GET /api/stats/team-pulse — today's per-rep outbound activity ─────
// Manager view: outbound calls per rep TODAY (caller's local day),
// connected = answered-type dispositions, plus talk time.
router.get('/team-pulse', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const adminBase = process.env.INSFORGE_URL || process.env.INFORGE_URL || 'http://localhost:7130';
    const username = process.env.INSFORGE_ADMIN_USER || 'admin';
    const password = process.env.INSFORGE_ADMIN_PASSWORD;
    if (!password) throw new ApiError(500, 'admin credentials missing', 'db_error');
    const s = await fetch(`${adminBase}/api/auth/admin/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!s.ok) throw new ApiError(500, 'admin session failed', 'db_error');
    const { accessToken } = await s.json();
    const H = { Authorization: `Bearer ${accessToken}`, apikey: accessToken };

    const rows = await fetch(
      `${adminBase}/api/database/records/call_logs?select=user_id,disposition,duration_seconds,started_at&direction=eq.outbound&order=started_at.desc&limit=2000`,
      { headers: H }
    ).then(r => r.json());
    const logs = (Array.isArray(rows) ? rows : rows?.data || []) as any[];

    const members = await fetch(
      `${adminBase}/api/database/records/team_members?select=rep_user_id,display_name`,
      { headers: H }
    ).then(r => r.json());
    const team = (Array.isArray(members) ? members : members?.data || []) as any[];

    // Day boundary in America/Vancouver (DST-aware via Intl)
    const tz = 'America/Vancouver';
    const nowParts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const todayLocal = nowParts; // YYYY-MM-DD
    const localDay = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(iso));

    const perRep = new Map<string, { calls: number; connected: number; secs: number }>();
    const CONNECTED = new Set(['answered', 'follow_up', 'not_interested', 'meeting_booked']);
    for (const l of logs) {
      if (!l.started_at || localDay(l.started_at) !== todayLocal) continue;
      const e = perRep.get(l.user_id) || { calls: 0, connected: 0, secs: 0 };
      e.calls += 1;
      if (CONNECTED.has(l.disposition)) e.connected += 1;
      e.secs += l.duration_seconds || 0;
      perRep.set(l.user_id, e);
    }

    const out: Record<string, unknown>[] = [];
    for (const m of team) {
      const e = perRep.get(m.rep_user_id);
      out.push({
        rep_user_id: m.rep_user_id,
        name: m.display_name || 'Rep',
        is_master: false,
        calls: e?.calls || 0,
        connected: e?.connected || 0,
        talk_secs: e?.secs || 0,
      });
    }
    // Master's own calls (not on the roster)
    const masterEntry = perRep.get(req.user.id);
    out.push({
      rep_user_id: req.user.id,
      name: req.user.name || 'You',
      is_master: true,
      calls: masterEntry?.calls || 0,
      connected: masterEntry?.connected || 0,
      talk_secs: masterEntry?.secs || 0,
    });

    res.json({ data: out });
  } catch (e) { next(e); }
});

export default router;
