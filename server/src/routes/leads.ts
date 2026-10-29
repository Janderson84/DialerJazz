import { MASTER_ID } from '../lib/masterSettings.js';
import { adminFetch } from './sms.js';
import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

const leadSchema = z.object({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  company: z.string().optional(),
  phone: z.string().min(1, 'Phone is required'),
  email: z.string().optional().or(z.literal('')),
  website: z.string().optional().or(z.literal('')),
  linkedin_url: z.string().optional().or(z.literal('')),
  google_maps_url: z.string().optional().or(z.literal('')),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zip: z.string().optional(),
  google_rating: z.number().optional(),
  review_count: z.number().optional(),
  business_category: z.string().optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
  status: z.string().default('new'),
  priority: z.number().default(0),
  custom_fields: z.record(z.string(), z.any()).optional()
});

const bulkLeadsSchema = z.object({
  campaign_id: z.string().uuid(),
  leads: z.array(leadSchema).min(1).max(2000)
});

// Mini-CRM: Fetch all leads globally for this user with server-side search/filter
router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(1, Number(req.query.per_page) || 25));
    const offset = (page - 1) * perPage;

    const search = req.query.search as string | undefined;
    const status = req.query.status as string | undefined;
    const tags = req.query.tags as string | undefined;
    let query = req.db!.database
      .from('leads')
      .select('*', { count: 'exact' })
      .eq('user_id', req.user.id);

    const minAttempts = Math.max(0, Number(req.query.min_attempts) || 0);
    // Filter to leads dialed at least N times: compute from call_logs first,
    // then constrain the leads query to that id set (PostgREST has no
    // server-side group-by through this client).
    if (minAttempts > 0) {
      const admin0 = await adminFetch();
      const clRes = await fetch(
        `${admin0.base}/api/database/records/call_logs?lead_id=not.is.null&select=lead_id&limit=5000`,
        { headers: admin0.headers() }
      ).catch(() => null);
      let idSet: string[] = [];
      if (clRes && clRes.ok) {
        const rows = ((await clRes.json()) || []) as any[];
        const counts = new Map<string, number>();
        for (const r of rows) counts.set(String(r.lead_id), (counts.get(String(r.lead_id)) || 0) + 1);
        idSet = [...counts.entries()].filter(([, n]) => n >= minAttempts).map(([id]) => id);
      }
      if (!idSet.length) {
        return res.json({ data: [], meta: { total: 0, page, per_page: perPage, total_pages: 0 } });
      }
      query = query.in('id', idSet);
    }

    // Server-side search across name, company, email, and phone
    if (search && search.trim()) {
      const searchTerm = `%${search.trim()}%`;
      query = query.or(`first_name.ilike.*${searchTerm}*,last_name.ilike.*${searchTerm}*,company.ilike.*${searchTerm}*,email.ilike.*${searchTerm}*,phone.ilike.*${searchTerm}*`);
    }

    // Filter by status
    if (status && status.trim()) {
      query = query.eq('status', status);
    }

    // Filter by tags (contains any of the specified tags)
    if (tags && tags.trim()) {
      const tagArray = tags.split(',').map(t => t.trim()).filter(Boolean);
      if (tagArray.length > 0) {
        query = query.overlaps('tags', tagArray);
      }
    }

    const { data, count, error } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + perPage - 1);

    if (error) throw new ApiError(500, error.message, 'db_error');

    // Call-attempt counts for the page's leads (how many times each was
    // dialed + last outcome) so dead numbers are visible at a glance.
    const pageIds = (data || []).map((l: any) => l.id);
    let attemptsByLead: Record<string, { attempts: number; last_disposition: string | null }> = {};
    if (pageIds.length) {
      const idsCsv = pageIds.map((id: string) => `"${id}"`).join(',');
      const admin = await adminFetch();
      const clRes = await fetch(
        `${admin.base}/api/database/records/call_logs?lead_id=in.(${idsCsv})&select=lead_id,disposition&order=created_at.desc&limit=1000`,
        { headers: admin.headers() }
      ).catch(() => null);
      if (clRes && clRes.ok) {
        const rows = ((await clRes.json()) || []) as any[];
        for (const r of rows) {
          const key = String(r.lead_id);
          const a = attemptsByLead[key] || { attempts: 0, last_disposition: null };
          a.attempts += 1;
          if (!a.last_disposition) a.last_disposition = r.disposition || null;
          attemptsByLead[key] = a;
        }
      }
    }
    const withAttempts = (data || []).map((l: any) => ({
      ...l,
      call_attempts: attemptsByLead[String(l.id)]?.attempts || 0,
      last_disposition: attemptsByLead[String(l.id)]?.last_disposition || null,
    }));

    const total = count || 0;

    res.json({
      data: withAttempts,
      meta: {
        total,
        page,
        per_page: perPage,
        total_pages: Math.ceil(total / perPage),
      },
    });
  } catch (error) {
    next(error);
  }
});

// Bulk Insert CSV into CRM and assign to campaign
router.post('/bulk', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const body = bulkLeadsSchema.parse(req.body);

    // Validate rows individually: skip bad rows instead of failing the whole
    // batch (a single malformed phone in a 500-row CSV used to kill it all).
    const validLeads: z.infer<typeof leadSchema>[] = [];
    const skipped: { index: number; reason: string }[] = [];
    const seenPhones = new Set<string>();
    body.leads.forEach((lead, index) => {
      const parsed = leadSchema.safeParse(lead);
      if (!parsed.success) {
        skipped.push({ index, reason: parsed.error.issues[0]?.message || 'invalid row' });
        return;
      }
      const phone = String(parsed.data.phone || '').trim();
      if (!phone) {
        skipped.push({ index, reason: 'missing phone' });
        return;
      }
      if (seenPhones.has(phone)) {
        skipped.push({ index, reason: `duplicate phone in file` });
        return;
      }
      seenPhones.add(phone);
      validLeads.push({ ...parsed.data, phone });
    });

    // Deduplicate leads by phone before interacting with DB
    const uniqueLeads = new Map();
    for (const l of validLeads) {
      uniqueLeads.set(l.phone, l);
    }

    const leadsToUpsert = Array.from(uniqueLeads.values()).map(lead => ({
      ...lead,
      user_id: req.user.id
    }));

    if (!leadsToUpsert.length) {
      throw new ApiError(400, `No valid rows to import. ${skipped.length} row(s) skipped: ${skipped.slice(0, 3).map(x => `#${x.index + 1} ${x.reason}`).join('; ')}`, 'no_valid_rows');
    }

    // Historical-quality check: how many of these numbers already produced
    // wrong-number or DNC outcomes? Warn so bad lists get caught before reps
    // burn dial time.
    let bad_history = 0;
    try {
      const phones = leadsToUpsert.map(l => String(l.phone).replace(/\D/g, '').slice(-10)).filter(Boolean);
      if (phones.length) {
        const admin = await adminFetch();
        const badRes = await fetch(
          `${admin.base}/api/database/records/call_logs?disposition=in.(wrong_number,dnc)&select=to_number&limit=1000`,
          { headers: admin.headers() }
        ).then(r => r.json()).catch(() => null);
        const badSet = new Set(((Array.isArray(badRes) ? badRes : badRes?.data || []) as any[])
          .map(r => String(r.to_number || '').replace(/\D/g, '').slice(-10)));
        bad_history = phones.filter(p => badSet.has(p)).length;
      }
    } catch { /* optional check */ }

    // Step 1: Upsert all leads based on User ID & Phone (prevents duplicate contacts globally)
    const { data: upsertedLeads, error: upsertError } = await req.db!
      .database.from('leads')
      .upsert(leadsToUpsert, { onConflict: 'user_id,phone' })
      .select('id');

    if (upsertError || !upsertedLeads) throw new ApiError(500, upsertError?.message || 'Failed to upsert leads', 'db_error');

    // Step 2: Map these lead IDs to the Campaign in the junction table
    const campaignLeadsToUpsert = upsertedLeads.map(lead => ({
      campaign_id: body.campaign_id,
      lead_id: lead.id,
      user_id: req.user.id
    }));

    const { error: junctionError } = await req.db!
      .database.from('campaign_leads')
      .upsert(campaignLeadsToUpsert, { onConflict: 'campaign_id,lead_id' });

    if (junctionError) throw new ApiError(500, junctionError.message, 'db_error');

    // Step 3: Update campaign total_leads count
    const { count } = await req.db!
      .database.from('campaign_leads')
      .select('*', { count: 'exact', head: true })
      .eq('campaign_id', body.campaign_id);

    if (count !== null) {
      await req.db!
        .database.from('campaigns')
        .update({
          total_leads: count,
          updated_at: new Date().toISOString()
        })
        .eq('id', body.campaign_id);
    }

    res.status(201).json({
      data: upsertedLeads,
      count: upsertedLeads.length,
      skipped_rows: skipped,
      skipped_count: skipped.length,
      bad_history,
    });
  } catch (error) {
    next(error);
  }
});

// Fetch Leads specifically bound to a campaign via Junction Table
router.get('/campaign/:campaignId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { limit = '50', offset = '0' } = req.query;

    // Master (admin) can view any campaign's leads; reps only their own.
    // DNC leads are EXCLUDED from the dialer feed — compliance: a lead the
    // rep marked "Do Not Call" must never re-enter the queue.
    let clQuery = req.db!
      .database.from('campaign_leads')
      .select(`
        id,
        leads!inner (*)
      `, { count: 'exact' })
      .eq('campaign_id', req.params.campaignId)
      .neq('leads.status', 'dnc');
    if (req.user.id !== MASTER_ID()) clQuery = clQuery.eq('user_id', req.user.id);
    const { data, count, error } = await clQuery
      .order('created_at', { ascending: true })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (error) throw new ApiError(500, error.message, 'db_error');

    // Flatten PostgREST structure for the frontend
    const flatData = data?.map((row: any) => ({
      ...row.leads,
      _campaign_lead_id: row.id,
      // override tracking status/tags if we intend to track state per campaign later
    })) || [];

    res.json({ data: flatData, meta: { total: count || 0, count: flatData.length } });
  } catch (error) {
    next(error);
  }
});

// Assign EXISTING leads from CRM to a campaign
router.post('/assign', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const assignSchema = z.object({
      campaign_id: z.string().uuid(),
      lead_ids: z.array(z.string().uuid()).min(1)
    });
    const body = assignSchema.parse(req.body);

    const campaignLeadsToUpsert = body.lead_ids.map(lead_id => ({
      campaign_id: body.campaign_id,
      lead_id,
      user_id: req.user.id
    }));

    const { error: junctionError } = await req.db!
      .database.from('campaign_leads')
      .upsert(campaignLeadsToUpsert, { onConflict: 'campaign_id,lead_id' });

    if (junctionError) throw new ApiError(500, junctionError.message, 'db_error');
    
    // Update count
    const { count } = await req.db!
      .database.from('campaign_leads')
      .select('*', { count: 'exact', head: true })
      .eq('campaign_id', body.campaign_id);
      
    if (count !== null) {
      await req.db!.database.from('campaigns').update({ total_leads: count }).eq('id', body.campaign_id);
    }

    res.status(201).json({ success: true, count: body.lead_ids.length });
  } catch (error) {
    next(error);
  }
});

router.patch('/:id/disposition', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const dispositionSchema = z.object({
      status: z.enum(['new', 'calling', 'answered', 'follow_up', 'appointment', 'not_interested', 'no_answer', 'voicemail', 'busy', 'wrong_number', 'failed', 'dnc'])
    });
    const { status } = dispositionSchema.parse(req.body);

    const { data, error } = await req.db!
      .database.from('leads')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) throw new ApiError(500, error.message, 'db_error');

    res.json({ data });
  } catch (error) {
    next(error);
  }
});

// GET /api/leads/export — CSV of the current leads view (search/status/
// min_attempts). Same filters as the list endpoint; ?token= auth for
// browser downloads.
router.get('/export', requireAuth, async (req: AuthenticatedRequest & { user?: any }, res: Response, next: NextFunction) => {
  try {
    const search = req.query.search as string | undefined;
    const status = req.query.status as string | undefined;
    const minAttempts = Math.max(0, Number(req.query.min_attempts) || 0);

    let query = req.db!.database
      .from('leads')
      .select('*')
      .eq('user_id', req.user.id);

    if (search && search.trim()) {
      const searchTerm = `%${search.trim()}%`;
      query = query.or(`first_name.ilike.*${searchTerm}*,last_name.ilike.*${searchTerm}*,company.ilike.*${searchTerm}*,email.ilike.*${searchTerm}*,phone.ilike.*${searchTerm}*`);
    }
    if (status && status.trim()) query = query.eq('status', status);

    if (minAttempts > 0) {
      const admin0 = await adminFetch();
      const clRes = await fetch(
        `${admin0.base}/api/database/records/call_logs?lead_id=not.is.null&select=lead_id&limit=5000`,
        { headers: admin0.headers() }
      ).catch(() => null);
      let idSet: string[] = [];
      if (clRes && clRes.ok) {
        const rows = ((await clRes.json()) || []) as any[];
        const counts = new Map<string, number>();
        for (const r of rows) counts.set(String(r.lead_id), (counts.get(String(r.lead_id)) || 0) + 1);
        idSet = [...counts.entries()].filter(([, n]) => n >= minAttempts).map(([id]) => id);
      }
      if (!idSet.length) { res.header('Content-Type', 'text/csv'); return res.send('no rows'); }
      query = query.in('id', idSet);
    }

    const { data, error } = await query.order('created_at', { ascending: false }).limit(5000);
    if (error) throw new ApiError(500, error.message, 'db_error');

    // attempts per lead for context
    const attemptsByLead = new Map<string, number>();
    if ((data || []).length) {
      const idsCsv = (data as any[]).map((l) => `"${l.id}"`).join(',');
      const admin = await adminFetch();
      const clRes = await fetch(
        `${admin.base}/api/database/records/call_logs?lead_id=in.(${idsCsv})&select=lead_id&limit=5000`,
        { headers: admin.headers() }
      ).catch(() => null);
      if (clRes && clRes.ok) {
        for (const r of ((await clRes.json()) || []) as any[]) {
          attemptsByLead.set(String(r.lead_id), (attemptsByLead.get(String(r.lead_id)) || 0) + 1);
        }
      }
    }

    const esc = (v: any) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = 'first_name,last_name,company,phone,email,state,status,tags,call_attempts,created_at';
    const lines = (data || []).map((l: any) => [
      esc(l.first_name), esc(l.last_name), esc(l.company), esc(l.phone), esc(l.email),
      esc(l.state), esc(l.status), esc((l.tags || []).join('; ')), esc(attemptsByLead.get(String(l.id)) || 0), esc(l.created_at),
    ].join(','));

    res.header('Content-Type', 'text/csv');
    res.header('Content-Disposition', `attachment; filename="leads-export-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send([header, ...lines].join('\n'));
  } catch (error) {
    next(error);
  }
});

export default router;

// POST /api/leads/purge-dead — master only. Removes leads with >= min
// outbound attempts that ended no_answer/wrong_number (default 3) from ALL
// campaigns (deletes campaign_leads junction rows; the lead record stays in
// the CRM). List-hygiene: dead numbers shouldn't sit in queues.
router.post('/purge-dead', requireAuth, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (req.user.id !== MASTER_ID()) throw new ApiError(403, 'Master only', 'forbidden');
    const min = Math.max(1, Number(req.body?.min_attempts) || 3);

    const admin = await adminFetch();
    const clRes = await fetch(
      `${admin.base}/api/database/records/call_logs?lead_id=not.is.null&disposition=in.(no_answer,wrong_number)&select=lead_id&limit=5000`,
      { headers: admin.headers() }
    );
    if (!clRes.ok) throw new ApiError(500, 'Failed to load call logs', 'db_error');
    const rows = ((await clRes.json()) || []) as any[];
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(String(r.lead_id), (counts.get(String(r.lead_id)) || 0) + 1);
    const dead = [...counts.entries()].filter(([, n]) => n >= min).map(([id]) => id);
    if (!dead.length) return res.json({ data: { purged: 0 } });

    const del = await fetch(
      `${admin.base}/api/database/records/campaign_leads?lead_id=in.(${dead.join(',')})`,
      { method: 'DELETE', headers: admin.headers() }
    );
    if (!del.ok) throw new ApiError(500, 'Failed to purge', 'db_error');

    res.json({ data: { purged: dead.length, leads: dead } });
  } catch (error) {
    next(error);
  }
});
