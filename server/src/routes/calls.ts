import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { getPipedriveToken, resolvePdByPhone, pushPdCallActivity, resolvePdUserId, createPdPersonIfMissing } from './pipedrive.js';

const router = Router();

// ── Zod Validation Schema ──────────────────────────────────────────
const callLogSchema = z.object({
  lead_id: z.string().uuid('lead_id must be a valid UUID').optional().nullable(),
  campaign_id: z.string().uuid('campaign_id must be a valid UUID').optional().nullable().or(z.literal('')),
  duration_seconds: z.number().int().min(0).default(0),
  status: z.string().min(1).max(50).default('completed'),
  disposition: z.string().min(1).max(50).optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
  provider: z.enum(['telnyx', 'twilio', 'local']).default('telnyx'),
  direction: z.enum(['outbound', 'inbound']).default('outbound'),
  to_number: z.string().max(40).optional().nullable(),
  from_number: z.string().max(40).optional().nullable(),
});

// POST /api/calls/log
router.post('/log', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, 'Unauthorized', 'auth_required');

    console.log('[calls/log] Received payload:', req.body);

    // Validate input with Zod — throws ZodError caught by centralized errorHandler
    const validated = callLogSchema.parse(req.body);

    console.log('[calls/log] Validated data:', validated);

    // Resolve the dialed number for campaign calls (lead record) BEFORE the
    // insert so the log row itself carries the number — call history must
    // show what was dialed even when the client doesn't send it.
    if (validated.lead_id && !validated.to_number && !validated.from_number) {
      try {
        const { data: leadRow } = await req.db!.database
          .from('leads')
          .select('phone')
          .eq('id', validated.lead_id)
          .eq('user_id', userId)
          .single();
        if (leadRow?.phone) validated.to_number = leadRow.phone;
      } catch { /* non-fatal */ }
    }

    // Insert call log
    const { data: logData, error: logError } = await req.db!.database
      .from('call_logs')
      .insert({
        user_id: userId,
        lead_id: validated.lead_id,
        campaign_id: validated.campaign_id || null,
        provider: validated.provider,
        duration_seconds: validated.duration_seconds,
        status: validated.status,
        disposition: validated.disposition || null,
        notes: validated.notes || null,
        direction: validated.direction,
        to_number: validated.to_number || null,
        from_number: validated.from_number || null,
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (logError) {
      console.error('[calls/log] Insert error:', logError);
      throw new ApiError(500, logError.message, 'db_error');
    }

    console.log('[calls/log] Inserted log:', logData);

    // ── Pipedrive push (best-effort, non-fatal).
    // EVERY logged call should land in Pipedrive as a done call activity with
    // per-rep attribution (user_id = rep's Pipedrive owner via email match).
    // For campaign calls (lead_id set) the phone comes from the lead record;
    // for manual calls the client sends to/from. Never blocks or fails the
    // call log: no token / no match / PD error all return 200 with a
    // `pipedrive` status field.
    let pdResult: unknown = null;
    if (validated.to_number || validated.from_number) {
      try {
        const phone = validated.direction === 'inbound'
          ? (validated.from_number || '')
          : (validated.to_number || '');
        // Skip obvious non-customer numbers (browser clients, etc.)
        if (!/\d{7,}/.test(phone.replace(/\D/g, ''))) {
          pdResult = { matched: false };
        } else {
          const token = await getPipedriveToken(req);
          const pdUserId = await resolvePdUserId(req, token);
          let match = await resolvePdByPhone(token, phone);
          // Every call must land as an activity on a prospect (per James).
          // Unmatched number → create the Pipedrive person from the lead
          // record (name/company when known, phone-only fallback), then log
          // the call activity against them.
          let personId: number | null = match.matched ? match.person_id : null;
          if (!match.matched) {
            let leadInfo: { first_name?: string; last_name?: string; company?: string; email?: string } = {};
            if (validated.lead_id) {
              try {
                const { data: leadRow } = await req.db!.database
                  .from('leads')
                  .select('first_name,last_name,company,email')
                  .eq('id', validated.lead_id)
                  .eq('user_id', userId)
                  .single();
                leadInfo = (leadRow as any) || {};
              } catch { /* non-fatal */ }
            }
            const createdId = await createPdPersonIfMissing(token, {
              phone,
              name: [leadInfo.first_name, leadInfo.last_name].filter(Boolean).join(' ') || undefined,
              company: leadInfo.company || undefined,
              email: leadInfo.email || undefined,
              owner_pd_user_id: pdUserId ?? undefined,
            });
            if (createdId) {
              personId = createdId;
              match = { matched: true, person_id: createdId, person_name: leadInfo.first_name ? [leadInfo.first_name, leadInfo.last_name].filter(Boolean).join(' ') : phone, deal_id: null, deal_title: null, duplicates: [] };
            }
          }
          // Push an activity for EVERY call (per James: N calls = N activities).
          const act = await pushPdCallActivity(token, {
            deal_id: match.matched ? match.deal_id : null,
            person_id: personId,
            direction: validated.direction,
            disposition: validated.disposition || 'call',
            duration_secs: validated.duration_seconds,
            notes: validated.notes || undefined,
            rep_name: req.user?.name,
            rep_email: req.user?.email,
            pd_user_id: pdUserId,
            duplicates: match.matched ? (match.duplicates || []) : [],
            phone,
          });
          pdResult = {
            ...(act as any),
            matched: match.matched,
            person_created: !match.matched ? false : undefined,
            ...(match.matched ? { person_name: match.person_name, deal_title: match.deal_title } : {}),
          };
        }
      } catch (e: any) {
        console.warn('[calls/log] Pipedrive push skipped:', e?.message || e);
        pdResult = { skipped: true };
      }
    }

    // Step 1: Check if this lead was previously uncalled (status is 'new' or 'calling')
    if (validated.lead_id && validated.campaign_id && validated.disposition) {
      const { data: leadData } = await req.db!.database
        .from('leads')
        .select('status')
        .eq('id', validated.lead_id)
        .eq('user_id', userId)
        .single();

      const wasUncalled = !leadData?.status || leadData.status === 'new' || leadData.status === 'calling';

      // Step 2: Update lead status to the disposition, and count this attempt.
      // call_attempts increments on EVERY logged call (answered, no_answer, busy, ...)
      // so the campaign dialer can enforce a minimum-attempts rule per lead.
      const { error: leadError } = await req.db!.database
        .rpc('increment_lead_attempts', {
          p_lead_id: validated.lead_id,
          p_user_id: userId,
          p_status: validated.disposition,
        });

      if (leadError) {
        console.error('[calls/log] Lead update error:', leadError);
      }

      // Step 3: If this was a fresh call, atomically recount the campaign progress
      // Uses a DB function to avoid read-modify-write race conditions
      if (validated.campaign_id && wasUncalled) {
        try {
          const { data: countResult, error: rpcError } = await req.db!.database
            .rpc('increment_campaign_calls', { p_campaign_id: validated.campaign_id });

          if (rpcError) {
            console.error('[calls/log] RPC counter error:', rpcError);
          } else {
            console.log('[calls/log] Campaign counter synced to:', countResult);
          }
        } catch (e) {
          console.error('[calls/log] Campaign counter update error:', e);
        }
      }
    }

    res.status(200).json({ data: logData, pipedrive: pdResult });
  } catch (err) {
    next(err);
  }
});
// GET /api/calls — List call logs. Reps see their own; the master account
// (team owner) sees EVERYONE's, with an optional ?rep=<rep_user_id> filter
// and a resolved rep name on each row.
router.get('/', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const userId = req.user!.id;
    const { campaign_id, lead_id, rep } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(1, Number(req.query.per_page) || 25));
    const offset = (page - 1) * perPage;

    // Roster (admin fetch): determines whether the caller is the master and
    // gives us rep ids + display names for attribution.
    const base = process.env.INFORGE_URL || process.env.INSFORGE_URL || 'http://localhost:7130';
    const adminUser = process.env.INSFORGE_ADMIN_USER || 'admin';
    const adminPassword = process.env.INSFORGE_ADMIN_PASSWORD;
    let isMaster = false;
    const repNames = new Map<string, string>();
    const rosterIds = new Set<string>();
    if (adminPassword) {
      try {
        const s = await fetch(`${base}/api/auth/admin/sessions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: adminUser, password: adminPassword }),
        });
        if (s.ok) {
          const { accessToken } = await s.json();
          const H = { Authorization: `Bearer ${accessToken}`, apikey: accessToken };
          const rows = await fetch(`${base}/api/database/records/team_members?select=rep_user_id,display_name,master_user_id`, { headers: H }).then(r => r.json());
          const team = (Array.isArray(rows) ? rows : rows?.data || []) as any[];
          for (const m of team) {
            rosterIds.add(m.rep_user_id);
            repNames.set(m.rep_user_id, m.display_name || 'Rep');
            if (m.master_user_id === userId) isMaster = true;
          }
        }
      } catch { /* best effort — falls back to own-logs view */ }
    }

    // Scope: master with explicit rep filter sees that rep only; master with
    // no filter sees the whole team + own logs; reps always see only their own.
    let scopeIds: string[];
    if (isMaster && typeof rep === 'string' && /^[0-9a-f-]{36}$/i.test(rep)) {
      scopeIds = [rep];
    } else if (isMaster) {
      scopeIds = [...rosterIds, userId];
    } else {
      scopeIds = [userId];
    }

    let query = req.db!.database
      .from('call_logs')
      .select(`
        id,
        lead_id,
        campaign_id,
        provider,
        direction,
        from_number,
        to_number,
        status,
        disposition,
        disposition_sub,
        duration_seconds,
        recording_url,
        notes,
        started_at,
        ended_at,
        created_at,
        user_id,
        leads (first_name, last_name, company, phone),
        campaigns (name)
      `, { count: 'exact' })
      .in('user_id', scopeIds)
      .order('created_at', { ascending: false });

    if (campaign_id) {
      query = query.eq('campaign_id', campaign_id as string);
    }
    if (lead_id) {
      query = query.eq('lead_id', lead_id as string);
    }
    // Date range (inclusive), compared against the call start timestamp.
    // Dates are interpreted in the team's local timezone (America/Vancouver),
    // not UTC — "from=2026-10-06" must include calls made 00:00–07:00 UTC.
    const TZ = 'America/Vancouver';
    const localDayToUtcRange = (day: string): { gte: string; lte: string } => {
      // DST-aware: 00:00 local on `day` -> UTC instant (Intl-based offset probe)
      const noonUtc = new Date(`${day}T12:00:00Z`);
      const localMidnightOffsetMs = (() => {
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(noonUtc);
        const [h, m, sec] = parts.split(':').map(Number);
        return (h * 3600 + m * 60 + sec) * 1000 - 12 * 3600 * 1000; // local-noon offset from UTC noon
      })();
      const startMs = noonUtc.getTime() - 12 * 3600 * 1000 - localMidnightOffsetMs;
      return {
        gte: new Date(startMs).toISOString(),
        lte: new Date(startMs + 24 * 3600 * 1000 - 1).toISOString(),
      };
    };
    if (typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)) {
      query = query.gte('started_at', localDayToUtcRange(req.query.from).gte);
    }
    if (typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)) {
      query = query.lte('started_at', localDayToUtcRange(req.query.to).lte);
    }

    const { data, count, error } = await query.range(offset, offset + perPage - 1);

    if (error) {
      console.error('[calls/list] Query error:', error);
      throw new ApiError(500, error.message, 'db_error');
    }

    const formattedData = data?.map((row: any) => ({
      ...row,
      rep_name: repNames.get(row.user_id) || (row.user_id === userId ? (req.user!.name || 'You') : undefined),
      lead: row.leads ? {
        first_name: row.leads.first_name,
        last_name: row.leads.last_name,
        company: row.leads.company,
        phone: row.leads.phone
      } : null,
      campaign: row.campaigns ? { name: row.campaigns.name } : null
    })) || [];

    const total = count || 0;

    res.json({
      data: formattedData,
      meta: {
        total,
        page,
        per_page: perPage,
        total_pages: Math.ceil(total / perPage),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/calls/stats — Get call statistics
router.get('/stats', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const userId = req.user!.id;
    const { campaign_id } = req.query;

    let baseQuery = req.db!.database
      .from('call_logs')
      .select('id, status, disposition, duration_seconds', { count: 'exact', head: true })
      .eq('user_id', userId);

    if (campaign_id) {
      baseQuery = baseQuery.eq('campaign_id', campaign_id as string);
    }

    const { data, error } = await baseQuery;

    if (error) throw new ApiError(500, error.message, 'db_error');

    const totalCalls = data?.length || 0;
    const answeredCalls = data?.filter((c: any) => c.status === 'completed' || c.status === 'answered').length || 0;
    const totalDuration = data?.reduce((sum: number, c: any) => sum + (c.duration_seconds || 0), 0) || 0;
    
    const dispositionCounts: Record<string, number> = {};
    data?.forEach((c: any) => {
      if (c.disposition) {
        dispositionCounts[c.disposition] = (dispositionCounts[c.disposition] || 0) + 1;
      }
    });

    res.json({
      data: {
        totalCalls,
        answeredCalls,
        totalDuration,
        avgDuration: totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0,
        dispositionCounts
      }
    });
  } catch (err) {
    next(err);
  }
});

export default router;
