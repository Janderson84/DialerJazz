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
    let q = client.database.from('follow_ups').select('*').order('due_at', { ascending: true }).limit(200);
    const status = req.query.status === 'done' ? 'done' : 'open';
    q = q.eq('status', status);
    if (!isMaster(userId)) q = q.eq('user_id', userId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    res.json({ data: data || [] });
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
