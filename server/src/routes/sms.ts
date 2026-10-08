import { Router, Request } from 'express';
import type { Response } from 'express-serve-static-core';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { getMasterTwilioSettings, MASTER_ID } from '../lib/masterSettings.js';
import twilio from 'twilio';

/**
 * SMS messaging module (Quo-inspired, one-to-one only):
 *  - Templates (snippets) with {{variables}}
 *  - One-to-one send on the rep's own Twilio number
 *  - Conversation threads (by contact number) with open/closed status
 *  - Scheduled messages (auto-cancelled if the contact replies first)
 *  - Auto-replies (inbound text / missed call / voicemail; hours-aware)
 *  - Inbound SMS webhook ingestion
 *
 * NOTE: scheduled sending is performed by an in-process interval (see
 * startScheduledSweep). If the server process dies, pending scheduled
 * messages remain and send when the process restarts.
 */

const router = Router();

const MASTER_EMAIL_FALLBACK = 'team@salescloser.ai';

function formatE164(raw: string): string {
  const d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return d;
}

// ── Template variable interpolation ─────────────────────────────────
// Supports {{first_name}}, {{last_name}}, {{company}}, {{rep_name}}
async function interpolate(body: string, userId: string, leadId: string | null): Promise<string> {
  const vars: Record<string, string> = {
    first_name: 'there',
    last_name: '',
    company: '',
    rep_name: '',
  };

  if (leadId) {
    try {
      const admin = await adminFetch();
      const res = await fetch(`${admin.base}/api/database/records/leads?id=eq.${leadId}&select=first_name,last_name,company`, {
        headers: admin.headers(),
      });
      if (res.ok) {
        const j: any = await res.json();
const rows = Array.isArray(j) ? j : j?.data || [];
        const lead = rows[0];
        if (lead) {
          vars.first_name = lead.first_name || 'there';
          vars.last_name = lead.last_name || '';
          vars.company = lead.company || '';
        }
      }
    } catch (e) {
      console.error('[sms] lead lookup for interpolation failed:', e);
    }
  }

  // rep display name from team_members (or master)
  try {
    const admin = await adminFetch();
    const res = await fetch(`${admin.base}/api/database/records/team_members?rep_user_id=eq.${userId}&select=display_name&limit=1`, {
      headers: admin.headers(),
    });
    if (res.ok) {
      const j: any = await res.json();
const rows = Array.isArray(j) ? j : j?.data || [];
      vars.rep_name = rows[0]?.display_name || '';
    }
  } catch { /* non-fatal */ }

  // Dotted aliases map to the same vars (Quo-style: {{first.name}})
  const alias: Record<string, string> = {
    'first.name': 'first_name',
    'last.name': 'last_name',
    'company.name': 'company',
    'rep.name': 'rep_name',
    'full.name': 'first_name', // no separate full_name var; fall back to first
  };
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const resolved = vars[key] ?? vars[alias[key] ?? ''] ?? '';
    return resolved;
  });
}

// ── Admin API helper (server-side, bypasses RLS) ────────────────────
let adminCache: { token: string; exp: number } | null = null;
export async function adminFetch() {
  const base = process.env.INFORGE_URL || process.env.INSFORGE_URL || 'http://localhost:7130';
  const username = process.env.INSFORGE_ADMIN_USER || 'admin';
  const password = process.env.INSFORGE_ADMIN_PASSWORD;
  if (!password) throw new ApiError(500, 'Server admin credentials not configured', 'config_missing');

  if (adminCache && adminCache.exp > Date.now()) {
    return {
      base,
      headers: () => ({ Authorization: `Bearer ${adminCache!.token}`, apikey: adminCache!.token, 'Content-Type': 'application/json' }),
    };
  }

  const res = await fetch(`${base}/api/auth/admin/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new ApiError(500, 'Could not authenticate to database', 'db_auth');
  const { accessToken } = await res.json();
  adminCache = { token: accessToken, exp: Date.now() + 10 * 60 * 1000 };
  return {
    base,
    headers: () => ({ Authorization: `Bearer ${adminCache!.token}`, apikey: adminCache!.token, 'Content-Type': 'application/json' }),
  };
}

// ── Twilio creds from master settings ───────────────────────────────
async function twilioCreds(): Promise<{ sid: string; token: string }> {
  const settings = await getMasterTwilioSettings();
  if (!settings?.twilio_account_sid || !settings?.twilio_auth_token) {
    throw new ApiError(400, 'Twilio not connected. Go to Connectors page.', 'config_missing');
  }
  return { sid: settings.twilio_account_sid, token: settings.twilio_auth_token };
}

/** Get the sending number for a user: their rep number, or master's caller number. */
async function senderNumberFor(userId: string): Promise<string> {
  try {
    const admin = await adminFetch();
    const res = await fetch(`${admin.base}/api/database/records/team_members?rep_user_id=eq.${userId}&select=phone_number&limit=1`, {
      headers: admin.headers(),
    });
    if (res.ok) {
      const json = await res.json();
      const rows = Array.isArray(json) ? json : json?.data || [];
      if (rows[0]?.phone_number) return rows[0].phone_number;
    }
  } catch { /* fall through */ }
  const settings = await getMasterTwilioSettings();
  if (settings?.twilio_caller_number) return settings.twilio_caller_number;
  throw new ApiError(400, 'No phone number configured for sending', 'config_missing');
}

// ══ Templates ═══════════════════════════════════════════════════════

router.get('/templates', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const admin = await adminFetch();
    const res2 = await fetch(
      `${admin.base}/api/database/records/sms_templates?user_id=eq.${req.user!.id}&order=updated_at.desc`,
      { headers: admin.headers() }
    );
    if (!res2.ok) throw new ApiError(500, 'Failed to load templates', 'db_error');
    const data = await res2.json();
    let rows = Array.isArray(data) ? data : data?.data || [];
    // Reps start with an empty template list — fall back to the master's
    // templates so they have something to send on day one. Master's rows
    // are marked shared: edits/deletes stay scoped to the owner's rows.
    if (rows.length === 0 && req.user!.id !== MASTER_ID()) {
      const mres = await fetch(
        `${admin.base}/api/database/records/sms_templates?user_id=eq.${MASTER_ID()}&order=updated_at.desc`,
        { headers: admin.headers() }
      );
      if (mres.ok) {
        const mdata = await mres.json();
        rows = (Array.isArray(mdata) ? mdata : mdata?.data || []).map((t: any) => ({ ...t, shared: true }));
      }
    }
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.post('/templates', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { name, body } = req.body || {};
    if (!name || !body) throw new ApiError(400, 'Template name and body are required', 'bad_request');
    const admin = await adminFetch();
    const res2 = await fetch(`${admin.base}/api/database/records/sms_templates`, {
      method: 'POST',
      headers: admin.headers(),
      body: JSON.stringify({ user_id: req.user!.id, name: String(name).slice(0, 80), body: String(body).slice(0, 1000) }),
    });
    if (!res2.ok) throw new ApiError(500, 'Failed to create template', 'db_error');
    const created = await res2.json();
    res.json({ data: Array.isArray(created) ? created[0] : created?.data || created });
  } catch (e) { next(e); }
});

router.patch('/templates/:id', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { name, body } = req.body || {};
    const admin = await adminFetch();
    const res2 = await fetch(`${admin.base}/api/database/records/sms_templates?id=eq.${req.params.id}&user_id=eq.${req.user!.id}`, {
      method: 'PATCH',
      headers: admin.headers(),
      body: JSON.stringify({
        ...(name !== undefined ? { name: String(name).slice(0, 80) } : {}),
        ...(body !== undefined ? { body: String(body).slice(0, 1000) } : {}),
      }),
    });
    if (!res2.ok) throw new ApiError(500, 'Failed to update template', 'db_error');
    res.json({ data: { ok: true } });
  } catch (e) { next(e); }
});

router.delete('/templates/:id', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const admin = await adminFetch();
    const res2 = await fetch(`${admin.base}/api/database/records/sms_templates?id=eq.${req.params.id}&user_id=eq.${req.user!.id}`, {
      method: 'DELETE',
      headers: admin.headers(),
    });
    if (!res2.ok) throw new ApiError(500, 'Failed to delete template', 'db_error');
    res.json({ data: { ok: true } });
  } catch (e) { next(e); }
});

// ══ Send (one-to-one, immediate or scheduled) ═══════════════════════

router.post('/send', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const userId = req.user!.id;
    const { to, body, lead_id, template_id, scheduled_for } = req.body || {};
    if (!to || !body) throw new ApiError(400, 'Recipient and message body are required', 'bad_request');
    const toE164 = formatE164(String(to));
    if (!/^\+\d{10,15}$/.test(toE164)) throw new ApiError(400, `Invalid phone number: ${to}`, 'bad_number');

    const rendered = await interpolate(String(body).slice(0, 1000), userId, lead_id || null);

    // Scheduled send: store as pending, the sweeper fires it later
    if (scheduled_for) {
      const when = new Date(scheduled_for);
      if (isNaN(when.getTime()) || when.getTime() < Date.now()) {
        throw new ApiError(400, 'scheduled_for must be a future time', 'bad_request');
      }
      const admin = await adminFetch();
      const insert = await fetch(`${admin.base}/api/database/records/sms_messages`, {
        method: 'POST',
        headers: admin.headers(),
        body: JSON.stringify({
          user_id: userId,
          lead_id: lead_id || null,
          direction: 'outbound',
          from_number: await senderNumberFor(userId).catch(() => ''),
          to_number: toE164,
          body: rendered,
          status: 'scheduled',
          scheduled_for: when.toISOString(),
        }),
      });
      if (!insert.ok) throw new ApiError(500, 'Failed to schedule message', 'db_error');
      return res.json({ data: { scheduled: true, send_at: when.toISOString() } });
    }

    const fromNumber = await senderNumberFor(userId);
    if (fromNumber && fromNumber === toE164) {
      throw new ApiError(400, 'Cannot send a text to the same number it is sent from', 'same_number');
    }
    const { sid, token } = await twilioCreds();

    const twRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: fromNumber, To: toE164, Body: rendered }).toString(),
    });
    const twJson = await twJson_await(twRes);
    if (!twRes.ok) {
      // Record the failure so the UI shows it
      const admin = await adminFetch();
      await fetch(`${admin.base}/api/database/records/sms_messages`, {
        method: 'POST',
        headers: admin.headers(),
        body: JSON.stringify({
          user_id: userId, lead_id: lead_id || null, direction: 'outbound',
          from_number: fromNumber, to_number: toE164, body: rendered,
          status: 'failed', error_message: twJson?.message || `Twilio error ${twRes.status}`,
        }),
      }).catch(() => null);
      throw new ApiError(502, twJson?.message || `Twilio error ${twRes.status}`, 'send_failed');
    }

    const admin = await adminFetch();
    const insert = await fetch(`${admin.base}/api/database/records/sms_messages`, {
      method: 'POST',
      headers: admin.headers(),
      body: JSON.stringify({
        user_id: userId,
        lead_id: lead_id || null,
        direction: 'outbound',
        from_number: fromNumber,
        to_number: toE164,
        body: rendered,
        status: twJson.status || 'sent',
        twilio_sid: twJson.sid,
      }),
    });
    if (!insert.ok) {
      // sent but not logged — report success anyway, log server-side
      console.error('[sms/send] message sent but DB insert failed', await insert.text().catch(() => ''));
    }
    return res.json({ data: { sent: true, sid: twJson.sid, status: twJson.status } });
  } catch (e) { next(e); }
});

// helper to avoid double-json parse mistakes
async function twJson_await(r: globalThis.Response): Promise<any> {
  try { return await r.json(); } catch { return null; }
}

// ══ Conversations (threads by contact number) ═══════════════════════

// GET /api/sms/threads — list distinct contact numbers with last message
router.get('/threads', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const admin = await adminFetch();
    const res2 = await fetch(
      `${admin.base}/api/rpc/sms_threads?user_id=${req.user!.id}`,
      { headers: admin.headers() }
    );
    if (res2.ok) {
      const data = await res2.json();
      return res.json({ data: data || [] });
    }
    // Fallback: derive in JS from recent messages (fine for small volumes)
    const res3 = await fetch(
      `${admin.base}/api/database/records/sms_messages?user_id=eq.${req.user!.id}&order=created_at.desc&limit=500`,
      { headers: admin.headers() }
    );
    if (!res3.ok) throw new ApiError(500, 'Failed to load messages', 'db_error');
    const all = await res3.json();
    const msgs = Array.isArray(all) ? all : all?.data || [];
    const map = new Map<string, any>();
    for (const m of msgs) {
      const peer = m.direction === 'outbound' ? m.to_number : m.from_number;
      if (!peer || peer === '') continue;
      const existing = map.get(peer);
      if (!existing || new Date(m.created_at) > new Date(existing.created_at)) {
        map.set(peer, { ...m, peer });
      }
    }
    const threads = [...map.values()].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    return res.json({ data: threads });
  } catch (e) { next(e); }
});

// GET /api/sms/threads/:peer — full thread with a contact (E.164 or digits)
router.get('/threads/:peer', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const peer = formatE164(decodeURIComponent(String(req.params.peer)));
    const admin = await adminFetch();
    // inbound messages from peer OR outbound messages to peer — this user's only
    // RLS on sms_messages isn't guaranteed configured; use admin + user_id filter
    const res2 = await fetch(
      `${admin.base}/api/database/records/sms_messages?user_id=eq.${req.user!.id}&order=created_at.asc&limit=500`,
      { headers: admin.headers() }
    );
    if (!res2.ok) throw new ApiError(500, 'Failed to load thread', 'db_error');
    const all = await res2.json();
    const msgs = (Array.isArray(all) ? all : all?.data || []).filter(
      (m: any) => (m.direction === 'outbound' ? m.to_number === peer : m.from_number === peer)
    );
    res.json({ data: msgs });
  } catch (e) { next(e); }
});

// PATCH /api/sms/threads/:peer/status — open/closed the whole conversation
router.patch('/threads/:peer/status', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const peer = formatE164(decodeURIComponent(String(req.params.peer)));
    const { status } = req.body || {};
    if (!['open', 'closed'].includes(status)) throw new ApiError(400, 'status must be open or closed', 'bad_request');
    const admin = await adminFetch();
    // outbound to this peer OR inbound from this peer
    for (const q of [
      `to_number=eq.${encodeURIComponent(peer)}`,
      `from_number=eq.${encodeURIComponent(peer)}`,
    ]) {
      await fetch(
        `${admin.base}/api/database/records/sms_messages?user_id=eq.${req.user!.id}&${q}`,
        { method: 'PATCH', headers: admin.headers(), body: JSON.stringify({ conversation_status: status }) }
      ).catch(() => null);
    }
    res.json({ data: { ok: true, status } });
  } catch (e) { next(e); }
});

// ══ Scheduled sweep ═════════════════════════════════════════════════

async function sendDueScheduled(): Promise<void> {
  try {
    const admin = await adminFetch();
    const now = new Date().toISOString();
    const res = await fetch(
      `${admin.base}/api/database/records/sms_messages?status=eq.scheduled&scheduled_for=lte.${now}&limit=20`,
      { headers: admin.headers() }
    );
    if (!res.ok) return;
    const rows = (await res.json()) || [];
    const due = Array.isArray(rows) ? rows : rows?.data || [];
    for (const m of due) {
      try {
        const { sid, token } = await twilioCreds();
        const twRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
          method: 'POST',
          headers: {
            Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ From: m.from_number, To: m.to_number, Body: m.body }).toString(),
        });
        const twJson = await twRes.json().catch(() => null);
        const patch = await fetch(`${admin.base}/api/database/records/sms_messages?id=eq.${m.id}`, {
          method: 'PATCH',
          headers: admin.headers(),
          body: JSON.stringify(
            twRes.ok
              ? { status: twJson?.status || 'sent', twilio_sid: twJson?.sid, sent_at: now }
              : { status: 'failed', error_message: twJson?.message || `Twilio error ${twRes.status}` }
          ),
        });
        if (!patch.ok) console.error('[sms/sweep] patch failed for', m.id);
      } catch (e) {
        console.error('[sms/sweep] send failed for', m.id, e);
      }
    }
  } catch (e) {
    console.error('[sms/sweep] error:', e);
  }
}

let sweepTimer: NodeJS.Timeout | null = null;
export function startScheduledSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(sendDueScheduled, 60_000);
  sweepTimer.unref?.();
}

// ══ Auto-replies ════════════════════════════════════════════════════

router.get('/auto-replies', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const admin = await adminFetch();
    const res2 = await fetch(
      `${admin.base}/api/database/records/sms_auto_replies?user_id=eq.${req.user!.id}&order=updated_at.desc`,
      { headers: admin.headers() }
    );
    if (!res2.ok) throw new ApiError(500, 'Failed to load auto-replies', 'db_error');
    const data = await res2.json();
    res.json({ data: Array.isArray(data) ? data : data?.data || [] });
  } catch (e) { next(e); }
});

router.post('/auto-replies', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { name, trigger_event, body, schedule_mode, business_hours } = req.body || {};
    if (!name || !trigger_event || !body) {
      throw new ApiError(400, 'name, trigger_event and body are required', 'bad_request');
    }
    if (!['inbound_text', 'missed_call', 'voicemail'].includes(trigger_event)) {
      throw new ApiError(400, 'invalid trigger_event', 'bad_request');
    }
    const admin = await adminFetch();
    const insert = await fetch(`${admin.base}/api/database/records/sms_auto_replies`, {
      method: 'POST',
      headers: admin.headers(),
      body: JSON.stringify({
        user_id: req.user!.id,
        name: String(name).slice(0, 80),
        trigger_event,
        body: String(body).slice(0, 1000),
        schedule_mode: ['always', 'business_hours', 'after_hours'].includes(schedule_mode) ? schedule_mode : 'always',
        business_hours: business_hours || { start: '9', end: '17', tz: 'America/Chicago' },
      }),
    });
    if (!insert.ok) throw new ApiError(500, 'Failed to create auto-reply', 'db_error');
    const created = await insert.json();
    res.json({ data: Array.isArray(created) ? created[0] : created?.data || created });
  } catch (e) { next(e); }
});

router.patch('/auto-replies/:id', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const allowed = ['name', 'body', 'active', 'schedule_mode', 'business_hours', 'trigger_event'];
    const patch: Record<string, unknown> = {};
    for (const k of allowed) if (req.body?.[k] !== undefined) patch[k] = req.body[k];
    const admin = await adminFetch();
    const res2 = await fetch(
      `${admin.base}/api/database/records/sms_auto_replies?id=eq.${req.params.id}&user_id=eq.${req.user!.id}`,
      { method: 'PATCH', headers: admin.headers(), body: JSON.stringify(patch) }
    );
    if (!res2.ok) throw new ApiError(500, 'Failed to update auto-reply', 'db_error');
    res.json({ data: { ok: true } });
  } catch (e) { next(e); }
});

router.delete('/auto-replies/:id', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const admin = await adminFetch();
    const res2 = await fetch(
      `${admin.base}/api/database/records/sms_auto_replies?id=eq.${req.params.id}&user_id=eq.${req.user!.id}`,
      { method: 'DELETE', headers: admin.headers() }
    );
    if (!res2.ok) throw new ApiError(500, 'Failed to delete auto-reply', 'db_error');
    res.json({ data: { ok: true } });
  } catch (e) { next(e); }
});

// ══ Auto-reply firing (shared with Twilio dial-action for missed calls) ══
export async function fireAutoReplies(opts: {
  userId: string;
  triggerEvent: 'inbound_text' | 'missed_call' | 'voicemail';
  fromNumber: string; // the contact (message goes TO them)
  repNumber: string;  // our rep number the message comes FROM
}): Promise<void> {
  try {
    const admin = await adminFetch();
    const arRes = await fetch(
      `${admin.base}/api/database/records/sms_auto_replies?user_id=eq.${opts.userId}&trigger_event=eq.${opts.triggerEvent}&active=eq.true`,
      { headers: admin.headers() }
    );
    if (!arRes.ok) return;
    const arRows = (await arRes.json()) || [];
    const rules = (Array.isArray(arRows) ? arRows : arRows?.data || []) as any[];
    const nowHour = Number(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Chicago' }).format(new Date())
    );
    for (const rule of rules) {
      const { start, end } = rule.business_hours || { start: '9', end: '17' };
      const inHours = nowHour >= Number(start) && nowHour < Number(end);
      if (rule.schedule_mode === 'business_hours' && !inHours) continue;
      if (rule.schedule_mode === 'after_hours' && inHours) continue;
      const rendered = rule.body
        .replace(/\{\{\s*first_name\s*\}\}/gi, '')
        .trim();
      if (!rendered) continue;
      const { sid, token } = await twilioCreds();
      const twRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ From: opts.repNumber, To: opts.fromNumber, Body: rendered }).toString(),
      });
      const twJson = await twRes.json().catch(() => null);
      if (twRes.ok) {
        await fetch(`${admin.base}/api/database/records/sms_messages`, {
          method: 'POST',
          headers: admin.headers(),
          body: JSON.stringify({
            user_id: opts.userId, direction: 'outbound', from_number: opts.repNumber, to_number: opts.fromNumber,
            body: rendered, status: twJson?.status || 'sent', twilio_sid: twJson?.sid,
          }),
        });
      }
    }
  } catch (e) {
    console.error('[sms/auto-reply] fire error:', e);
  }
}

// ══ Inbound SMS webhook (Twilio) ════════════════════════════════════
// Wire each rep number's SmsUrl to PUBLIC_BASE/api/sms/inbound?rep=<repUserId>
// Rep lookup is by the rep query param (same pattern as voice inbound).

router.post('/inbound', (req: Request, res: Response) => {
  (async () => {
    try {
      const from = req.body.From || '';
      const to = req.body.To || '';
      const body = req.body.Body || '';
      const repId = (req.query.rep as string) || '';
      console.log(`[sms/inbound] to=${to} from=${from} rep=${repId || '<none>'} body="${body.slice(0, 50)}"`);

      const admin = await adminFetch();

      // Who owns this receiving number? rep param, else match team_members.phone_number
      let ownerId = repId;
      if (!/^[0-9a-f-]{36}$/.test(ownerId)) {
        // Test-webhook body values are unformatted; normalize both sides before matching
        const toNorm = '+' + String(to).replace(/[^\d]/g, '');
        const res2 = await fetch(
          `${admin.base}/api/database/records/team_members?phone_number=eq.${toNorm}&select=rep_user_id&limit=1`,
          { headers: admin.headers() }
        );
        const rows = res2.ok ? ((await res2.json()) || []) : [];
        const arr = Array.isArray(rows) ? rows : rows?.data || [];
        ownerId = arr[0]?.rep_user_id || '';
      }
      if (!/^[0-9a-f-]{36}$/.test(ownerId)) {
        // Master's own line (James): default ownership to the master user
        const settings = await getMasterTwilioSettings();
        if (settings?.twilio_caller_number && ('+' + String(to).replace(/[^\d]/g, '')) === settings.twilio_caller_number) {
          ownerId = MASTER_ID();
          console.log('[sms/inbound] resolved to master line', to);
        }
      }
      if (!/^[0-9a-f-]{36}$/.test(ownerId)) {
        console.error('[sms/inbound] could not resolve owner for', to);
        res.status(200).send('OK');
        return;
      }

      // 1. Log the inbound message
      await fetch(`${admin.base}/api/database/records/sms_messages`, {
        method: 'POST',
        headers: admin.headers(),
        body: JSON.stringify({
          user_id: ownerId, direction: 'inbound',
          from_number: from, to_number: to, body, status: 'received',
          conversation_status: 'open',
        }),
      });

      // 2. Cancel scheduled outbound messages to this contact (Quo-style:
      //    reply-first cancels the scheduled send)
      await fetch(
        `${admin.base}/api/database/records/sms_messages?user_id=eq.${ownerId}&to_number=eq.${encodeURIComponent(from)}&status=eq.scheduled`,
        { method: 'PATCH', headers: admin.headers(), body: JSON.stringify({ status: 'cancelled' }) }
      );

      // 3. Fire matching auto-replies (inbound_text trigger, hours-aware)
      await fireAutoReplies({ userId: ownerId, triggerEvent: 'inbound_text', fromNumber: from, repNumber: to });

      // TwiML: empty response = no further action
      const twiml = new twilio.twiml.MessagingResponse();
      res.type('text/xml').send(twiml.toString());
    } catch (e) {
      console.error('[sms/inbound] error:', e);
      res.status(200).type('text/xml').send('<Response/>'); // Twilio retries on 5xx; don't loop
    }
  })();
});

export default router;
