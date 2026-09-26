/**
 * Pipedrive integration — server side.
 *
 * AUTH: the master account's Pipedrive API token, stored in user_settings
 * (pipedrive_api_key). Reps use it transparently; only the master sees/edits it.
 *
 * Pull:  deals (+person phone/email, org, stage) → dialer leads for a campaign.
 * Push:  after a call, log a Pipedrive activity + note on the matched deal,
 *        and optionally update the deal's stage.
 */
import { Router, Request, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { getInsforgeClient } from '../lib/insforge.js';
import { MASTER_ID, getMasterSettingsField } from '../lib/masterSettings.js';

const router = Router();
const PD_BASE = 'https://api.pipedrive.com/api/v1';

// ── token helper ────────────────────────────────────────────────────
async function getPipedriveToken(req?: AuthenticatedRequest): Promise<string> {
  // 1. master's own settings
  const masterToken = await getMasterSettingsField('pipedrive_api_key');
  if (masterToken) return masterToken;
  throw new ApiError(400, 'Pipedrive not connected. Ask James to add the API token in Connectors.', 'pd_no_token');
}

/** Pipedrive GET with api_token param. */
async function pdGet(token: string, path: string, params: Record<string, string | number> = {}): Promise<any> {
  const url = new URL(`${PD_BASE}${path}`);
  url.searchParams.set('api_token', token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString());
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new ApiError(502, `Pipedrive API error (${res.status}): ${txt.slice(0, 200)}`, 'pd_api_error');
  }
  const json = await res.json();
  if (!json.success) throw new ApiError(502, `Pipedrive API rejected the call: ${json.error || 'unknown'}`, 'pd_api_error');
  return json.data;
}

/** Pipedrive POST/PUT. */
async function pdPost(token: string, path: string, body: Record<string, unknown>, method = 'POST'): Promise<any> {
  const res = await fetch(`${PD_BASE}${path}?api_token=${encodeURIComponent(token)}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new ApiError(502, `Pipedrive API error (${res.status}): ${txt.slice(0, 200)}`, 'pd_api_error');
  }
  const json = await res.json();
  if (!json.success) throw new ApiError(502, `Pipedrive API rejected the call: ${json.error || 'unknown'}`, 'pd_api_error');
  return json.data;
}

// ── POST /api/pipedrive/test — verify the stored token ─────────────
router.post('/test', requireAuth, async (req: AuthenticatedRequest, res: Response, next) => {
  try {
    const token = await getPipedriveToken(req);
    const me = await pdGet(token, '/users/me');
    res.json({ data: { company: me?.company_name || me?.company?.name || 'Pipedrive', user: me?.name || me?.email } });
  } catch (err) { next(err); }
});

// ── POST /api/pipedrive/token — save/replace the API token (master only) ──
router.post('/token', requireAuth, async (req: AuthenticatedRequest, res: Response, next) => {
  try {
    if (req.user!.id !== MASTER_ID()) throw new ApiError(403, 'Only the master account can set the Pipedrive token', 'not_master');
    const token = String(req.body?.api_token || '').trim();
    if (!token) throw new ApiError(400, 'api_token required', 'bad_input');

    // Verify before saving
    const me = await pdGet(token, '/users/me');
    const { error } = await getInsforgeClient(req.user!.token).database
      .from('user_settings')
      .update({ pipedrive_api_key: token, updated_at: new Date().toISOString() })
      .eq('user_id', MASTER_ID());
    if (error) throw new ApiError(500, error.message, 'db_error');
    res.json({ data: { company: me?.company_name || me?.company?.name || 'connected', verified: true } });
  } catch (err) { next(err); }
});

// ── GET /api/pipedrive/pipelines — pick source pipeline ────────────
router.get('/pipelines', requireAuth, async (req: AuthenticatedRequest, res: Response, next) => {
  try {
    const token = await getPipedriveToken(req);
    const pipelines = await pdGet(token, '/pipelines');
    res.json({ data: pipelines.map((p: any) => ({ id: p.id, name: p.name })) });
  } catch (err) { next(err); }
});

// ── GET /api/pipedrive/stages?pipeline_id= — stages for the picker ──
router.get('/stages', requireAuth, async (req: AuthenticatedRequest, res: Response, next) => {
  try {
    const token = await getPipedriveToken(req);
    const pipelineId = Number(req.query.pipeline_id);
    const stages = await pdGet(token, '/stages', pipelineId ? { pipeline_id: pipelineId } : {});
    res.json({ data: stages.map((s: any) => ({ id: s.id, name: s.name, pipeline_id: s.pipeline_id })) });
  } catch (err) { next(err); }
});

// ── POST /api/pipedrive/import — pull deals into a campaign as leads ──
// body: { campaign_id, pipeline_id?, stage_ids?, deal_status: 'open'|'all', limit? }
router.post('/import', requireAuth, async (req: AuthenticatedRequest, res: Response, next) => {
  try {
    const campaignId = String(req.body?.campaign_id || '');
    if (!campaignId) throw new ApiError(400, 'campaign_id required', 'bad_input');
    const token = await getPipedriveToken(req);

    const pipelineId = req.body?.pipeline_id ? Number(req.body.pipeline_id) : null;
    const stageIds: number[] = Array.isArray(req.body?.stage_ids) ? req.body.stage_ids.map(Number) : [];
    const dealStatus = req.body?.deal_status === 'all' ? 'all_not_deleted' : 'open';
    const limit = Math.min(Number(req.body?.limit) || 100, 500);

    // Walk deals with pagination
    const params: Record<string, string | number> = { status: dealStatus, limit, start: 0 };
    if (pipelineId) params.pipeline_id = pipelineId;
    if (stageIds.length === 1) params.stage_id = stageIds[0];

    const deals = await pdGet(token, '/deals', params);
    let filtered = deals as any[];
    if (stageIds.length > 1) filtered = filtered.filter((d) => stageIds.includes(d.stage_id));

    // Fetch person details for phone/email (batched via /persons/:id)
    const leads = [] as any[];
    const seen = new Set<string>();
    for (const deal of filtered) {
      let phone = '', email = '', personName = '', orgName = '';
      const personId = deal.person_id;
      if (personId) {
        try {
          const person = await pdGet(token, `/persons/${personId}`);
          phone = person.phone?.[0]?.value || person.primary_phone || '';
          email = person.email?.[0]?.value || person.primary_email || '';
          personName = person.name || '';
        } catch { /* person fetch failed — still import with deal title */ }
      }
      if (deal.org_id && !orgName) {
        try {
          const org = await pdGet(token, `/organizations/${deal.org_id}`);
          orgName = org.name || '';
        } catch { /* ignore */ }
      }
      const nameParts = (personName || deal.title || '').split(' ');
      const phoneKey = phone.replace(/\D/g, '');
      if (!phoneKey || seen.has(phoneKey)) continue; // dialer requires a phone; dedupe
      seen.add(phoneKey);
      leads.push({
        first_name: nameParts[0] || '',
        last_name: nameParts.slice(1).join(' ') || '',
        phone,
        email,
        company: orgName || deal.title || '',
        notes: deal.title || '',
        status: 'new',
        pipedrive_deal_id: deal.id,
      });
    }
    if (!leads.length) {
      return res.json({ data: { imported: 0, skipped_no_phone: filtered.length, message: 'No deals with phone numbers found in this selection.' } });
    }

    // Upsert leads (dedupe on user_id+phone) and link to the campaign
    const client = getInsforgeClient(req.user!.token);
    const rows = leads.map((l) => ({ ...l, user_id: req.user!.id }));
    const { data: upserted, error } = await client.database
      .from('leads')
      .upsert(rows, { onConflict: 'user_id,phone' })
      .select('id');
    if (error || !upserted) throw new ApiError(500, error?.message || 'Lead upsert failed', 'db_error');

    const links = (upserted as any[]).map((l) => ({ campaign_id: campaignId, lead_id: l.id }));
    const { error: linkErr } = await client.database
      .from('campaign_leads')
      .upsert(links, { onConflict: 'campaign_id,lead_id' });
    if (linkErr) throw new ApiError(500, linkErr.message, 'db_error');

    res.json({ data: { imported: upserted.length, skipped_no_phone: filtered.length - leads.length } });
  } catch (err) { next(err); }
});


// ── GET /api/pipedrive/users — for matching reps to Pipedrive owners ──
router.get('/users', requireAuth, async (req: AuthenticatedRequest, res: Response, next) => {
  try {
    const token = await getPipedriveToken(req);
    const users = await pdGet(token, '/users');
    res.json({ data: users.map((u: any) => ({ id: u.id, name: u.name, email: u.email })) });
  } catch (err) { next(err); }
});

/**
 * Resolve a dialer user to their Pipedrive user id.
 * Cached mapping lives in team_members.pd_user_id; falls back to
 * best-effort email match against the Pipedrive users list.
 */
async function resolvePdUserId(req: AuthenticatedRequest, token: string): Promise<number | null> {
  const client = getInsforgeClient(req.user!.token);
  const dialerEmail = req.user!.email?.toLowerCase();

  // cached?
  const { data: member } = await client.database
    .from('team_members')
    .select('pd_user_id')
    .eq('rep_user_id', req.user!.id)
    .single();
  if ((member as any)?.pd_user_id) return (member as any).pd_user_id as number;

  // match by email against Pipedrive users
  const users = await pdGet(token, '/users');
  const match = (users as any[]).find(
    (u) => (u.email || '').toLowerCase() === dialerEmail
  );
  if (match) {
    await client.database
      .from('team_members')
      .update({ pd_user_id: match.id, updated_at: new Date().toISOString() })
      .eq('rep_user_id', req.user!.id);
    return match.id;
  }
  return null;
}

// ── POST /api/pipedrive/log-call — push a call outcome to Pipedrive ──
// body: { pipedrive_deal_id, disposition, duration_secs, notes?, rep_name? }
router.post('/log-call', requireAuth, async (req: AuthenticatedRequest, res: Response, next) => {
  try {
    const dealId = Number(req.body?.pipedrive_deal_id);
    const disposition = String(req.body?.disposition || 'call');
    const duration = Number(req.body?.duration_secs) || 0;
    const notes = String(req.body?.notes || '');
    if (!dealId) throw new ApiError(400, 'pipedrive_deal_id required', 'bad_input');
    const token = await getPipedriveToken(req);

    const subject = `Call (${disposition}) — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    const note = [
      `Cold Call Machine: ${disposition}`,
      duration ? `Duration: ${Math.floor(duration / 60)}m ${duration % 60}s` : '',
      notes ? `Notes: ${notes}` : '',
      req.body?.rep_name ? `Rep: ${req.body.rep_name}` : '',
      req.user?.email ? `Logged for: ${req.user.email}` : '',
    ].filter(Boolean).join('\n');

    // Attribute the activity to the actual rep (falls back to the master/token owner)
    const pdUserId = await resolvePdUserId(req, token);
    const activity = await pdPost(token, '/activities', {
      deal_id: dealId,
      subject,
      type: 'call',
      note,
      done: 1,
      ...(pdUserId ? { user_id: pdUserId } : {}),
    });

    res.json({ data: { activity_id: activity?.id } });
  } catch (err) { next(err); }
});


// ── GET /api/pipedrive/team-mapping — master sees rep→Pipedrive-owner mapping ──
router.get('/team-mapping', requireAuth, async (req: AuthenticatedRequest, res: Response, next) => {
  try {
    if (req.user!.id !== MASTER_ID()) throw new ApiError(403, 'Master only', 'not_master');
    const token = await getPipedriveToken(req);
    const client = getInsforgeClient(req.user!.token);
    const { data: members } = await client.database
      .from('team_members')
      .select('rep_user_id, display_name, email, pd_user_id, phone_number')
      .eq('master_user_id', MASTER_ID());
    let pdUsers: any[] = [];
    try { pdUsers = await pdGet(token, '/users'); } catch { /* not connected */ }
    res.json({ data: {
      reps: (members || []).map((m: any) => ({
        rep_user_id: m.rep_user_id,
        display_name: m.display_name,
        email: m.email,
        pd_user_id: m.pd_user_id || null,
      })),
      pd_users: pdUsers.map((u: any) => ({ id: u.id, name: u.name, email: u.email })),
    }});
  } catch (err) { next(err); }
});

// ── POST /api/pipedrive/team-mapping — master sets a rep's Pipedrive owner ──
router.post('/team-mapping', requireAuth, async (req: AuthenticatedRequest, res: Response, next) => {
  try {
    if (req.user!.id !== MASTER_ID()) throw new ApiError(403, 'Master only', 'not_master');
    const repUserId = String(req.body?.rep_user_id || '');
    const pdUserId = req.body?.pd_user_id ? Number(req.body.pd_user_id) : null;
    if (!repUserId) throw new ApiError(400, 'rep_user_id required', 'bad_input');
    const client = getInsforgeClient(req.user!.token);
    const { error } = await client.database
      .from('team_members')
      .update({ pd_user_id: pdUserId, updated_at: new Date().toISOString() })
      .eq('rep_user_id', repUserId)
      .eq('master_user_id', MASTER_ID());
    if (error) throw new ApiError(500, error.message, 'db_error');
    res.json({ data: { ok: true, pd_user_id: pdUserId } });
  } catch (err) { next(err); }
});

// ── GET /api/pipedrive/status — is the token set + valid? ──────────
router.get('/status', requireAuth, async (req: AuthenticatedRequest, res: Response, next) => {
  try {
    const masterId = MASTER_ID();
    const { data } = await getInsforgeClient(req.user!.token).database
      .from('user_settings')
      .select('pipedrive_api_key')
      .eq('user_id', masterId)
      .single();
    const hasToken = Boolean((data as any)?.pipedrive_api_key);
    res.json({ data: { connected: hasToken } });
  } catch (err) { next(err); }
});

export default router;
