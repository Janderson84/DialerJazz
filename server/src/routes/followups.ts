import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getInsforgeClient } from '../lib/insforge.js';
import { MASTER_ID } from '../lib/masterSettings.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const SCHEMA = z.object({
  lead_id: z.string().uuid().optional().nullable(),
  campaign_id: z.string().uuid().optional().nullable(),
  due_at: z.string().min(10),
  notes: z.string().max(2000).optional().nullable(),
});

function isMaster(id: string): boolean {
  return id === MASTER_ID();
}

// ── GET /api/followups?status=open|done&range=overdue|today|upcoming ──
router.get('/', requireAuth, async (req: Request & { user?: any }, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const client = getInsforgeClient(req.headers.authorization?.replace('Bearer ', ''));
    let q = client.database.from('follow_ups').select('*, leads(first_name, last_name, company, phone)').order('due_at', { ascending: true }).limit(200);
    const status = req.query.status === 'done' ? 'done' : 'open';
    q = q.eq('status', status);
    if (!isMaster(userId)) q = q.eq('user_id', userId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    // Master view: annotate the owning rep's name (team roster).
    const nameByUser = new Map<string, string>();
    if (isMaster(userId)) {
      try {
        const adminBase = process.env.INFORGE_URL || process.env.INSFORGE_URL || 'http://localhost:7130';
        const adminUser = process.env.INSFORGE_ADMIN_USER || 'admin';
        const adminPassword = process.env.INSFORGE_ADMIN_PASSWORD;
        if (adminPassword) {
          const s2 = await fetch(`${adminBase}/api/auth/admin/sessions`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: adminUser, password: adminPassword }),
          });
          if (s2.ok) {
            const { accessToken } = await s2.json();
            const members = await fetch(`${adminBase}/api/database/records/team_members?select=rep_user_id,display_name`, { headers: { Authorization: `Bearer ${accessToken}`, apikey: accessToken } }).then(r => r.json()).catch(() => null);
            for (const m of (Array.isArray(members) ? members : members?.data || []) as any[]) {
              if (m?.rep_user_id && m?.display_name) nameByUser.set(String(m.rep_user_id), String(m.display_name));
            }
          }
        }
      } catch { /* optional annotation */ }
    }
    const rows = (data || []).map((r: any) => {
      const lead = Array.isArray(r.leads) ? r.leads[0] : r.leads;
      return {
        ...r,
        lead_name: lead ? [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.company || null : null,
        lead_phone: lead?.phone || null,
        lead_company: lead?.company || null,
        rep_name: nameByUser.get(String(r.user_id)) || null,
        leads: undefined,
      };
    });
    res.json({ data: rows });
  } catch (e) { next(e); }
});

// ── POST /api/followups — create one ────────────────────────────────
router.post('/', requireAuth, async (req: Request & { user?: any }, res: Response, next: NextFunction) => {
  try {
    const body = SCHEMA.parse(req.body);
    const client = getInsforgeClient(req.headers.authorization?.replace('Bearer ', ''));
    const { data, error } = await client.database.from('follow_ups').insert({
      user_id: req.user!.id,
      lead_id: body.lead_id || null,
      campaign_id: body.campaign_id || null,
      due_at: body.due_at,
      notes: body.notes || null,
    }).select().single();
    if (error) throw new Error(error.message);
    res.json({ data });
  } catch (e) { next(e); }
});

// ── PATCH /api/followups/:id — complete / reopen / edit ─────────────
router.patch('/:id', requireAuth, async (req: Request & { user?: any }, res: Response, next: NextFunction) => {
  try {
    const patch: Record<string, unknown> = {};
    if (req.body.status === 'done') patch.status = 'done', patch.completed_at = new Date().toISOString();
    if (req.body.status === 'open') patch.status = 'open', patch.completed_at = null;
    if (typeof req.body.notes === 'string') patch.notes = req.body.notes.slice(0, 2000);
    if (typeof req.body.due_at === 'string') patch.due_at = req.body.due_at;
    const client = getInsforgeClient(req.headers.authorization?.replace('Bearer ', ''));
    let q = client.database.from('follow_ups').update(patch).eq('id', req.params.id);
    if (!isMaster(req.user!.id)) q = q.eq('user_id', req.user!.id);
    const { data, error } = await q.select().single();
    if (error) throw new Error(error.message);
    res.json({ data });
  } catch (e) { next(e); }
});

// ── DELETE /api/followups/:id ───────────────────────────────────────
router.delete('/:id', requireAuth, async (req: Request & { user?: any }, res: Response, next: NextFunction) => {
  try {
    const client = getInsforgeClient(req.headers.authorization?.replace('Bearer ', ''));
    let q = client.database.from('follow_ups').delete().eq('id', req.params.id);
    if (!isMaster(req.user!.id)) q = q.eq('user_id', req.user!.id);
    const { error } = await q;
    if (error) throw new Error(error.message);
    res.json({ data: { deleted: true } });
  } catch (e) { next(e); }
});

export default router;
