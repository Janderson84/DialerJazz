import express, { Router, Request, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { getInsforgeClient } from '../lib/insforge.js';
import { ApiError } from '../middleware/errorHandler.js';
import { z } from 'zod';
import twilio from 'twilio';
import { MASTER_ID, getMasterTwilioSettings } from '../lib/masterSettings.js';

const router = Router();


async function fetchAdminToken(): Promise<string> {
  const base = process.env.INFORGE_URL || process.env.INSFORGE_URL || 'http://localhost:7130';
  const username = process.env.INSFORGE_ADMIN_USER || 'admin';
  const password = process.env.INSFORGE_ADMIN_PASSWORD;
  if (!password) throw new ApiError(500, 'Server missing InsForge admin credentials', 'config');
  const res = await fetch(`${base}/api/auth/admin/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new ApiError(500, 'Failed to authenticate with InsForge admin API', 'config');
  const data = await res.json();
  return data.accessToken || data.token;
}

// Middleware: only the master account may use these routes
const requireMaster = async (req: AuthenticatedRequest, res: Response, next: any) => {
  try {
    if (req.user!.id !== MASTER_ID()) {
      throw new ApiError(403, 'Only the master account can manage the team', 'not_master');
    }
    next();
  } catch (err) {
    next(err);
  }
};

// ── GET /api/team — list team members with per-rep stats ────────────
router.get('/', requireAuth, requireMaster, async (req: AuthenticatedRequest, res, next) => {
  try {
    const db = req.db!;
    const { data: members, error } = await db.database
      .from('team_members')
      .select('*')
      .eq('master_user_id', req.user!.id)
      .order('created_at', { ascending: true });
    if (error) throw new ApiError(500, error.message, 'db_error');

    const stats = await Promise.all(
      (members || []).map(async (m: any) => {
        const s = await repStats(m.rep_user_id);
        return {
          id: m.id,
          rep_user_id: m.rep_user_id,
          role: m.role,
          display_name: m.display_name,
          status: m.status,
          phone_number: m.phone_number || null,
          created_at: m.created_at,
          ...s,
        };
      })
    );
    res.json({ data: stats });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/team — invite a rep (creates auth user + membership) ──
const inviteSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  display_name: z.string().optional(),
  role: z.enum(['rep', 'manager']).default('rep'),
});

router.post('/', requireAuth, requireMaster, async (req: AuthenticatedRequest, res, next) => {
  try {
    const body = inviteSchema.parse(req.body);

    // 1. Create the auth user via the InsForge admin API
    const adminToken = await fetchAdminToken();
    const base = process.env.INFORGE_URL || process.env.INSFORGE_URL || 'http://localhost:7130';
    const createRes = await fetch(`${base}/api/auth/users`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: body.email, password: body.password, profile: {} }),
    });
    const createData = await createRes.json();
    if (!createRes.ok || !createData?.user?.id) {
      const msg = createData?.message || 'Failed to create rep account (email may already exist)';
      throw new ApiError(400, msg, 'invite_failed');
    }
    const repUserId = createData.user.id;

    // 2. Provision a dedicated Twilio number for this rep (inbound + outbound caller ID)
    let phoneNumber: string | null = null;
    let numberError: string | null = null;
    try {
      phoneNumber = await provisionRepNumber(repUserId);
    } catch (e: any) {
      numberError = e?.message || 'Number provisioning failed';
      console.error('[team] number provisioning failed for', body.email, numberError);
    }

    // 3. Link to master
    const { error } = await db(req).database
      .from('team_members')
      .upsert({
        master_user_id: req.user!.id,
        rep_user_id: repUserId,
        role: body.role,
        display_name: body.display_name || body.email.split('@')[0],
        status: 'active',
        phone_number: phoneNumber,
      }, { onConflict: 'rep_user_id' });
    if (error) throw new ApiError(500, error.message, 'db_error');

    res.status(201).json({
      data: {
        rep_user_id: repUserId,
        email: body.email,
        display_name: body.display_name || body.email.split('@')[0],
        role: body.role,
        status: 'active',
        phone_number: phoneNumber,
        number_error: numberError,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/team/:repUserId — update role/status/name ───────────
router.patch('/:repUserId', requireAuth, requireMaster, async (req: AuthenticatedRequest, res, next) => {
  try {
    const patchSchema = z.object({
      display_name: z.string().optional(),
      role: z.enum(['rep', 'manager']).optional(),
      status: z.enum(['active', 'disabled']).optional(),
    });
    const updates = patchSchema.parse(req.body);
    const { data, error } = await db(req).database
      .from('team_members')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('rep_user_id', req.params.repUserId)
      .eq('master_user_id', req.user!.id)
      .select()
      .single();
    if (error || !data) throw new ApiError(404, 'Team member not found', 'not_found');
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/team/:repUserId/number — provision a number for an existing rep
router.post('/:repUserId/number', requireAuth, requireMaster, async (req: AuthenticatedRequest, res, next) => {
  try {
    const repUserId = String(req.params.repUserId);
    const { data: existing } = await db(req).database
      .from('team_members')
      .select('phone_number')
      .eq('rep_user_id', repUserId)
      .eq('master_user_id', req.user!.id)
      .single();
    if (existing?.phone_number) {
      return res.json({ data: { phone_number: existing.phone_number, message: 'Rep already has a number' } });
    }
    const phoneNumber = await provisionRepNumber(repUserId);
    const { error } = await db(req).database
      .from('team_members')
      .update({ phone_number: phoneNumber, updated_at: new Date().toISOString() })
      .eq('rep_user_id', repUserId)
      .eq('master_user_id', req.user!.id);
    if (error) throw new ApiError(500, error.message, 'db_error');
    res.status(201).json({ data: { phone_number: phoneNumber } });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/team/:repUserId — remove membership (auth user kept) ─
// Also releases the rep's Twilio number back to the master account so it
// stops billing and can be reassigned to a future rep.
router.delete('/:repUserId', requireAuth, requireMaster, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { data, error } = await db(req).database
      .from('team_members')
      .delete()
      .eq('rep_user_id', String(req.params.repUserId))
      .eq('master_user_id', req.user!.id)
      .select()
      .single();
    if (error || !data) throw new ApiError(404, 'Team member not found', 'not_found');

    // Release the rep's Twilio number (non-fatal — if it fails, the number is
    // still on the master account and James can release it manually).
    let numberReleased: string | null = null;
    const phone = (data as any).phone_number as string | null;
    if (phone) {
      try {
        await releaseRepNumber(phone);
        numberReleased = phone;
      } catch (e: any) {
        console.error('[team] failed to release number', phone, e?.message);
      }
    }

    res.status(200).json({ data: { removed: true, number_released: numberReleased } });
  } catch (err) {
    next(err);
  }
});

/** Delete a Twilio incoming number from the master account. */
export async function releaseRepNumber(phoneNumber: string): Promise<void> {
  const { sid, token } = await twilioCreds();
  const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');

  // find its Sid
  const listRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PageSize=50`, {
    headers: { Authorization: auth },
  });
  if (!listRes.ok) throw new Error(`Twilio list failed (${listRes.status})`);
  const list = await listRes.json();
  const num = (list.incoming_phone_numbers || []).find((n: any) => n.phone_number === phoneNumber);
  if (!num) throw new Error('Number not found on Twilio account');

  const delRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers/${num.sid}.json`, {
    method: 'DELETE',
    headers: { Authorization: auth },
  });
  if (!delRes.ok && delRes.status !== 404) throw new Error(`Twilio release failed (${delRes.status})`);
  console.log('[team] released Twilio number', phoneNumber);
}

function db(req: AuthenticatedRequest) { return req.db!; }


// ── Twilio number provisioning ──────────────────────────────────────
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'https://2c3de6c6d1ba--5173.jackhamr.app';

/** Twilio credentials for the master account (never exposed to reps). */
async function twilioCreds(): Promise<{ sid: string; token: string }> {
  const settings = await getMasterTwilioSettings();
  if (!settings?.twilio_account_sid || !settings?.twilio_auth_token) {
    throw new Error('Master Twilio account not connected');
  }
  return { sid: settings.twilio_account_sid as string, token: settings.twilio_auth_token as string };
}

/**
 * Buy the next available US number and wire it for this rep:
 *  - VoiceUrl → /api/twilio/inbound?rep=<repUserId>  (inbound rings the rep's browser)
 *  - The number is also that rep's outbound caller ID (stored in team_members).
 */
export async function provisionRepNumber(repUserId: string): Promise<string> {
  const { sid, token } = await twilioCreds();
  const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');

  // 1. Find an available US number
  const availRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/AvailablePhoneNumbers/US/Local.json?PageSize=5`, {
    headers: { Authorization: auth },
  });
  if (!availRes.ok) throw new Error(`Twilio availability lookup failed (${availRes.status})`);
  const avail = await availRes.json();
  const candidates = (avail.available_phone_numbers || []).filter((n: any) => n.capabilities?.voice);
  if (!candidates.length) throw new Error('No US numbers available on the master Twilio account');

  // 2. Buy it with inbound routing straight to this rep
  const inboundUrl = `${PUBLIC_BASE}/api/twilio/inbound?rep=${repUserId}`;
  const buyRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      PhoneNumber: candidates[0].phone_number,
      FriendlyName: `Rep ${repUserId.slice(0, 8)}`,
      VoiceUrl: inboundUrl,
      VoiceMethod: 'POST',
      StatusCallbackUrl: `${PUBLIC_BASE}/api/twilio/webhook`,
      StatusCallbackMethod: 'POST',
    }).toString(),
  });
  const bought = await buyRes.json();
  if (!buyRes.ok) throw new Error(bought?.message || `Number purchase failed (${buyRes.status})`);

  // 3. Register it as a verified outgoing caller ID so reps can present it on outbound calls
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/OutgoingCallerIds.json`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ PhoneNumber: bought.phone_number, FriendlyName: `Rep ${repUserId.slice(0, 8)}` }).toString(),
  }).catch(() => null); // non-fatal: Twilio-owned numbers are usually auto-approved as caller IDs

  console.log('[team] provisioned number', bought.phone_number, 'for rep', repUserId);
  return bought.phone_number;
}

// ── Per-rep stats: calls, talk time, leads touched, campaigns ───────
async function repStats(repUserId: string) {
  const adminToken = await fetchAdminToken();
  const base = process.env.INFORGE_URL || process.env.INSFORGE_URL || 'http://localhost:7130';
  const anon = process.env.INFORGE_ANON_KEY || process.env.INSFORGE_ANON_KEY || '';
  const H = {
    'Authorization': `Bearer ${adminToken}`,
    'apikey': anon || adminToken,
    'Content-Type': 'application/json',
  };
  const since = new Date(Date.now() - 7 * 864e5).toISOString();

  const url = (path: string) => `${base}/api/database/records/${path}`;

  const [calls7, callsAll, leadsAll, campaigns, minutes7] = await Promise.all([
    fetch(url(`call_logs?user_id=eq.${repUserId}&started_at=gte.${since}`), { headers: H }).then(r => r.ok ? r.json() : []),
    fetch(url(`call_logs?user_id=eq.${repUserId}`), { headers: H }).then(r => r.ok ? r.json() : []),
    fetch(url(`leads?user_id=eq.${repUserId}&select=id,status`), { headers: H }).then(r => r.ok ? r.json() : []),
    fetch(url(`campaigns?user_id=eq.${repUserId}&select=id,status`), { headers: H }).then(r => r.ok ? r.json() : []),
    fetch(url(`call_logs?user_id=eq.${repUserId}&started_at=gte.${since}&select=duration_seconds`), { headers: H }).then(r => r.ok ? r.json() : []),
  ]);

  const arr = (x: any) => (Array.isArray(x) ? x : Array.isArray(x?.data) ? x.data : []);
  const allCalls = arr(callsAll);
  const calls7d = arr(calls7);
  const leads = arr(leadsAll);
  const camps = arr(campaigns);

  return {
    stats: {
      calls_7d: calls7d.length,
      calls_total: allCalls.length,
      minutes_7d: Math.round(arr(minutes7).reduce((s: number, c: any) => s + (c.duration_seconds || 0), 0) / 60),
      leads_total: leads.length,
      leads_dialed: leads.filter((l: any) => l.status && !['new', 'calling'].includes(l.status)).length,
      campaigns_total: camps.length,
      campaigns_active: camps.filter((c: any) => c.status === 'active').length,
    },
  };
}

export default router;
