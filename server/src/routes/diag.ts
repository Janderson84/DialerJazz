import { Router, Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { getMasterTwilioSettings } from '../lib/masterSettings.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Lightweight client-side telemetry sink: the browser posts SDK lifecycle
// events (registering, registered, connect attempts, errors) so we can see
// exactly where a stuck call stops — server logs alone only show the happy path.
const events: Array<{ ts: string; userId: string; event: string; detail?: string }> = [];

router.post('/event', (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { event, detail } = req.body || {};
    events.push({
      ts: new Date().toISOString(),
      userId: req.user?.id || 'anon',
      event: String(event || 'unknown').slice(0, 80),
      detail: detail ? String(detail).slice(0, 500) : undefined,
    });
    if (events.length > 500) events.splice(0, events.length - 500);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.get('/events', (req: AuthenticatedRequest, res: Response) => {
  res.json({ events: events.slice(-100) });
});

// Aggregated health readout for master: dial counts, error counts by type,
// register/recover cycles — enough to spot pacing problems (31206 rate
// limits correlate with dial speed) without reading raw events.
router.get('/summary', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  const since = Date.now() - 6 * 60 * 60 * 1000; // last 6h window
  const recent = events.filter((e) => Date.now() - new Date(e.ts).getTime() <= since);
  const count = (name: string) => recent.filter((e) => e.event === name).length;
  const errors: Record<string, number> = {};
  for (const e of recent) {
    if (e.event === 'device.error' || e.event === 'call.error.early') {
      const kind = (e.detail || 'unknown').split(/[:\s]/)[0];
      errors[kind] = (errors[kind] || 0) + 1;
    }
  }
  res.json({
    window_hours: 6,
    dials: count('voice.dial'),
    calls_accepted: count('call.accepted'),
    registers: count('device.register.done') + count('device.re_register.done'),
    re_register_attempts: count('device.re_register.attempt'),
    re_register_failures: count('device.re_register.fail'),
    errors,
    last_event: recent.length ? recent[recent.length - 1].ts : null,
  });
});


// ── GET /api/diag/webhooks — per-number wiring check (master only) ──
// For each number: current voice/sms webhook URLs from Twilio + whether
// they point at this deployment + the last call/SMS seen on the line.
router.get('/webhooks', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    if (req.user!.id !== MASTER_ID_SAFE()) throw new ApiError(403, 'Master only', 'forbidden');
    const master = await getMasterTwilioSettings();
    const acct = master?.twilio_account_sid || '';
    const tok = master?.twilio_auth_token || '';
    if (!acct || !tok) throw new ApiError(400, 'Twilio not connected', 'no_twilio');
    const auth = 'Basic ' + Buffer.from(`${acct}:${tok}`).toString('base64');
    const self = process.env.PUBLIC_BASE_URL || 'https://3a50c7f3047f--3001.jackhamr.app';

    const numsRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${acct}/IncomingPhoneNumbers.json?PageSize=50`, { headers: { Authorization: auth } });
    const nums = (await numsRes.json()).incoming_phone_numbers || [];

    const recentCalls = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${acct}/Calls.json?PageSize=50`, { headers: { Authorization: auth } }).then(r => r.json()).catch(() => ({ calls: [] }));
    const recentSms = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${acct}/Messages.json?PageSize=50`, { headers: { Authorization: auth } }).then(r => r.json()).catch(() => ({ messages: [] }));

    const lastCallByNum = new Map<string, string>();
    for (const c of recentCalls.calls || []) {
      for (const n of [c.from, c.to]) {
        if (n && n.startsWith('+') && !lastCallByNum.has(n)) lastCallByNum.set(n, c.start_time);
      }
    }
    const lastSmsByNum = new Map<string, string>();
    for (const m of recentSms.messages || []) {
      for (const n of [m.from, m.to]) {
        if (n && n.startsWith('+') && !lastSmsByNum.has(n)) lastSmsByNum.set(n, m.date_sent || m.date_created);
      }
    }

    const out = nums.map((n: any) => {
      const voiceUrl: string = n.voice_url || '';
      const smsUrl: string = n.sms_url || '';
      return {
        number: n.phone_number,
        friendly_name: n.friendly_name,
        voice_url: voiceUrl,
        sms_url: smsUrl,
        voice_wired: voiceUrl.includes(self),
        sms_wired: smsUrl.includes(self),
        last_call: lastCallByNum.get(n.phone_number) || null,
        last_sms: lastSmsByNum.get(n.phone_number) || null,
      };
    });
    res.json({ data: out, deployment: self });
  } catch (e) { next(e); }
});

function MASTER_ID_SAFE(): string {
  return 'a4d41720-59e1-4850-8b15-e8841872e702';
}

export default router;
