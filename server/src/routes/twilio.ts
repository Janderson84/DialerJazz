import express, { Router, Request, Response } from 'express';
import twilio from 'twilio';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { getMasterTwilioSettings, MASTER_ID } from '../lib/masterSettings.js';
import { fireAutoReplies, adminFetch } from './sms.js';

const PUBLIC_BASE_URL = () =>
  process.env.PUBLIC_BASE_URL || 'https://3a50c7f3047f--3001.jackhamr.app';

// ── Rep caller-ID resolution ───────────────────────────────────────
// A rep's outbound caller ID must be the rep's OWN line (team_members
// phone_number), never the master account's number — otherwise every
// rep's calls display as the master line. Falls back to null when the
// rep has no line on the roster (caller ID resolution then uses what
// the client sent).
async function getRepLineNumber(repId: string | undefined): Promise<string | null> {
  if (!repId || !/^[0-9a-f-]{36}$/i.test(repId)) return null;
  try {
    const base = process.env.INFORGE_URL || process.env.INSFORGE_URL || 'http://localhost:7130';
    const username = process.env.INSFORGE_ADMIN_USER || 'admin';
    const password = process.env.INSFORGE_ADMIN_PASSWORD;
    if (!password) return null;
    const s = await fetch(`${base}/api/auth/admin/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!s.ok) return null;
    const { accessToken } = await s.json();
    const rows = await fetch(`${base}/api/database/records/team_members?rep_user_id=eq.${repId}&select=phone_number`, {
      headers: { Authorization: `Bearer ${accessToken}`, apikey: accessToken },
    }).then(r => r.json());
    const row = (Array.isArray(rows) ? rows : rows?.data || [])[0];
    return row?.phone_number || null;
  } catch { return null; }
}

const router = Router();
const { AccessToken } = twilio.jwt;
const { VoiceGrant } = AccessToken;

// ── POST /api/twilio/token ─────────────────────────────────────────
// Authenticated. Generates a short-lived Twilio Access Token with VoiceGrant.
router.post('/token', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, 'Unauthorized', 'auth_required');

    // Fetch Twilio credentials — reps dial through the MASTER's Twilio account
    const master = await getMasterTwilioSettings();
    const settings = master || null;

    if (!settings?.twilio_account_sid) {
      throw new ApiError(400, 'Twilio Account SID not configured. Go to Connectors page.', 'config_missing');
    }
    if (!settings?.twilio_api_key || !settings?.twilio_api_secret) {
      throw new ApiError(400, 'Twilio API Key/Secret not configured. Go to Connectors page.', 'config_missing');
    }
    if (!settings?.twilio_twiml_app_sid) {
      throw new ApiError(400, 'TwiML App SID not configured. Go to Connectors page.', 'config_missing');
    }

    console.log(`[${new Date().toISOString()}] [twilio/token] Generating token for user: ${userId}`);

    const token = new AccessToken(
      settings.twilio_account_sid,
      settings.twilio_api_key,
      settings.twilio_api_secret,
      { identity: `user_${userId}` }
    );

    const grant = new VoiceGrant({
      outgoingApplicationSid: settings.twilio_twiml_app_sid,
      incomingAllow: true,
    });
    token.addGrant(grant);

    console.log('[twilio/token] Token generated successfully');
    res.json({ data: { token: token.toJwt() } });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/twilio/voice ─────────────────────────────────────────
// Unauthenticated TwiML webhook. Twilio calls this when a browser
// client initiates an outbound call via device.connect().
// Returns TwiML XML instructing Twilio how to route the call.
router.post('/voice', express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  try {
    const twiml = new twilio.twiml.VoiceResponse();
    const to = req.body.To;
    const from = req.body.From || req.body.Caller;

    console.log(`[${new Date().toISOString()}] [Twilio Voice Webhook] To=${to}, From=${from}, CallSid=${req.body.CallSid}`);

    // Validate callerId - Twilio requires a verified phone number for outbound calls
    // The client already validates this before calling device.connect() (TwilioContext line 313)
    if (!from || !/^\+?\d{10,15}$/.test(from.replace(/[\s\-()]/g, ''))) {
      console.error('[Twilio Voice Webhook] Missing or invalid callerId (From):', from);
      twiml.say('Caller ID not configured. Please set a verified phone number in your connector settings.');
      res.type('text/xml').send(twiml.toString());
      return;
    }

    // Safety: if an inbound call to one of OUR lines ever lands on the outbound
    // route (webhook misconfiguration), do NOT out-dial — that loops (we would
    // dial ourselves). Hand it to inbound routing for the master instead.
    if (to && req.query.rep === undefined) {
      const cleanTo = to.replace(/[^\d+]/g, '');
      const masterSettings2 = await getMasterTwilioSettings().catch(() => null);
      const ourLines = new Set<string>();
      if (masterSettings2?.twilio_caller_number) ourLines.add(String(masterSettings2.twilio_caller_number).replace(/[^\d+]/g, ''));
      // Rep numbers from team_members (admin fetch, best effort)
      try {
        const base = process.env.INFORGE_URL || process.env.INSFORGE_URL || 'http://localhost:7130';
        const username = process.env.INSFORGE_ADMIN_USER || 'admin';
        const password = process.env.INSFORGE_ADMIN_PASSWORD;
        if (password) {
          const s = await fetch(`${base}/api/auth/admin/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
          if (s.ok) {
            const { accessToken } = await s.json();
            const rows = await fetch(`${base}/api/database/records/team_members?select=phone_number`, { headers: { Authorization: `Bearer ${accessToken}`, apikey: accessToken } }).then(r => r.json());
            for (const r of (Array.isArray(rows) ? rows : rows?.data || [])) {
              if (r?.phone_number) ourLines.add(String(r.phone_number).replace(/[^\d+]/g, ''));
            }
          }
        }
      } catch { /* best effort */ }
      if (ourLines.has(cleanTo)) {
        const inboundTwiML = new twilio.twiml.VoiceResponse();
        const dialIn = inboundTwiML.dial({ callerId: from, timeout: 25 });
        dialIn.client(`user_${MASTER_ID()}`);
        res.type('text/xml').send(inboundTwiML.toString());
        return;
      }
    }

    if (to && /^[\d+\-() ]+$/.test(to)) {
      // Outbound to a phone number — use answering machine detection with a
      // rep-aware callback. If the callee is a machine, Twilio drops the rep's
      // voicemail; if human, the callback bridges the call to the rep's browser.
      // Rep-aware caller ID: use the rep's own roster line, not the master number.
      // connect() params arrive in the POST body (To/From/Rep).
      const repId = (req.body.Rep as string) || (req.query.rep as string) || '';
      const attributionId = /^[0-9a-f-]{36}$/i.test(repId) ? repId : MASTER_ID();
      const repLine = await getRepLineNumber(repId);
      const outboundCallerId = repLine || from;
      console.log(`[Twilio Voice Webhook] outbound callerId=${outboundCallerId} (rep=${repId || 'master'}, repLine=${repLine || 'none'})`);
      const clean = to.replace(/[^\d+]/g, '');
      const amd = twiml.dial({
        callerId: outboundCallerId,
        machineDetection: 'DetectMessageEnd',
        machineDetectionTimeout: 10,
        record: 'record-from-answer-dual',
        recordingStatusCallback: `${PUBLIC_BASE_URL()}/api/twilio/recording-status?rep=${attributionId}`,
        recordingStatusCallbackEvent: 'completed',
      } as any);
      amd.number({
        url: `${PUBLIC_BASE_URL()}/api/voicemail/amd-callback?rep=${attributionId}`,
        method: 'POST',
      } as any, clean);
    } else if (to) {
      // Client identity — dial as client (internal transfer)
      const dial = twiml.dial({ callerId: from });
      dial.client(to);
    } else {
      twiml.say('No destination number was provided.');
    }

    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('[Twilio Voice Webhook] Error:', err);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('An application error occurred.');
    res.type('text/xml').status(500).send(twiml.toString());
  }
});


// ── POST /api/twilio/inbound ────────────────────────────────────────
// Inbound voice webhook for per-rep numbers. Routes the call to the
// rep's registered browser client (identity: user_<repUserId>).
// Rep id comes from the query string that provisionRepNumber baked in.
router.post('/inbound', express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  try {
    const twiml = new twilio.twiml.VoiceResponse();
    const repId = (req.query.rep as string) || '';
    const from = req.body.From || req.body.Caller || 'Unknown';
    console.log(`[Twilio Inbound] Call to rep ${repId || '<none>'} from ${from}`);

    let targetClient = `user_${repId}`;
    if (!/^[0-9a-f-]{36}$/i.test(repId)) {
      // Fallback: ring the master's browser
      targetClient = `user_${MASTER_ID()}`;
      console.log('[Twilio Inbound] invalid rep id, falling back to master');
    }

    const dial = twiml.dial({
      callerId: from,
      timeout: 25,
      record: 'record-from-answer-dual',
      recordingStatusCallback: `${PUBLIC_BASE_URL()}/api/twilio/recording-status?rep=${repId}`,
      recordingStatusCallbackEvent: 'completed',
      action: `${PUBLIC_BASE_URL()}/api/twilio/dial-status?rep=${repId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(req.body.To || '')}`,
      method: 'POST',
    } as any);
    dial.client(targetClient);
    // If the rep doesn't answer, take a voicemail
    twiml.say('The person you are calling is unavailable. Please leave a message after the tone.');

    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('[Twilio Inbound] Error:', err);
    res.status(500).type('text/xml').send('<Response><Say>An error occurred.</Say></Response>');
  }
});

// ── POST /api/twilio/dial-status ───────────────────────────────────
// Dial action callback: fires when the inbound call to a rep's browser
// ends or times out. DialCallStatus = completed | busy | no-answer |
// canceled. Anything but completed = missed call -> fire auto-replies
// and take a voicemail.
router.post('/dial-status', express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  try {
    const repId = (req.query.rep as string) || '';
    const from = (req.query.from as string) || req.body.From || '';
    const to = (req.query.to as string) || req.body.To || req.body.Called || '';
    const status = req.body.DialCallStatus || 'unknown';
    const duration = Number(req.body.DialCallDuration || req.body.AnsweredBy || 0) || 0;
    console.log(`[Twilio dial-status] rep=${repId} from=${from} to=${to} status=${status} dur=${duration}`);

    // Log the inbound call to history (was missing entirely: inbound calls
    // never appeared in Call Logs). owner = rep if valid, else master.
    if (/^[0-9a-f-]{36}$/i.test(repId) && from && to) {
      try {
        const admin = await adminFetch();
        // Attach the Twilio CallSid so recordings (which callback with the
        // parent CallSid) can be matched back to this log row.
        const dialSid = req.body.DialCallSid || req.body.CallSid || '';
        if (dialSid) {
          // Prefer the newest outbound row to the SAME number within the last
          // 30 min (exact match), falling back to the newest outbound row.
          const cleanTo = to.replace(/[^\d+]/g, '');
          const match = await fetch(
            `${admin.base}/api/database/records/call_logs?user_id=eq.${repId}&direction=eq.outbound&to_number=like.*${encodeURIComponent(cleanTo.slice(-10))}*&order=created_at.desc&limit=1`,
            { headers: admin.headers() }
          ).then(r => r.json()).catch(() => null);
          const row = (Array.isArray(match) ? match : match?.data || [])[0];
          const idFilter = row?.id ? `id=eq.${row.id}` : `user_id=eq.${repId}&direction=eq.outbound&order=created_at.desc&limit=1`;
          await fetch(`${admin.base}/api/database/records/call_logs?${idFilter}`, {
            method: 'PATCH',
            headers: { ...admin.headers(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ call_sid: dialSid }),
          }).catch(() => {});
        }
        const logBody = {
          user_id: repId,
          direction: 'inbound',
          from_number: from,
          to_number: to,
          provider: 'twilio',
          status: status === 'completed' ? 'completed' : 'missed',
          disposition: status === 'completed' ? 'answered' : 'missed',
          duration_seconds: duration,
          started_at: new Date().toISOString(),
          ended_at: new Date().toISOString(),
        };
        const lr = await fetch(`${admin.base}/api/database/records/call_logs`, {
          method: 'POST',
          headers: { ...admin.headers(), 'Content-Type': 'application/json' },
          body: JSON.stringify(logBody),
        });
        if (!lr.ok) console.error('[dial-status] call log insert failed:', (await lr.text()).slice(0, 200));
        else console.log('[dial-status] inbound call logged');
      } catch (e: any) {
        console.error('[dial-status] call log error:', e?.message || e);
      }
    }

    if (status !== 'completed' && from && to) {
      // missed call — auto-replies fire from OUR number (to) to the contact (from)
      const ownerId = /^[0-9a-f-]{36}$/.test(repId) ? repId : MASTER_ID();
      fireAutoReplies({ userId: ownerId, triggerEvent: 'missed_call', fromNumber: from, repNumber: to })
        .catch((e) => console.error('[dial-status] auto-reply error:', e));
    }

    // Continue the original TwiML flow: take a voicemail
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('The person you are calling is unavailable. Please leave a message after the tone.');
    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('[Twilio dial-status] error:', err);
    res.status(200).type('text/xml').send('<Response/>');
  }
});

// ── POST /api/twilio/recording-status ──────────────────────────────
// Recording finished. Match the parent CallSid to a call_log row and
// persist the recording URL for playback in call history.
router.post('/recording-status', express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  try {
    const sid = req.body.CallSid || '';
    const url = req.body.RecordingUrl || '';
    const duration = Number(req.body.RecordingDuration || 0) || 0;
    console.log(`[Twilio recording-status] sid=${sid} dur=${duration} url=${url.slice(0, 80)}`);
    if (!sid || !url) return res.status(200).send('OK');
    const admin = await adminFetch();
    const found = await fetch(`${admin.base}/api/database/records/call_logs?call_sid=eq.${encodeURIComponent(sid)}&select=id&limit=1`, { headers: admin.headers() }).then(r => r.json());
    const row = (Array.isArray(found) ? found : found?.data || [])[0];
    if (!row) {
      console.log('[Twilio recording-status] no matching call_log for sid', sid);
      return res.status(200).send('OK');
    }
    await fetch(`${admin.base}/api/database/records/call_logs?id=eq.${row.id}`, {
      method: 'PATCH',
      headers: { ...admin.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ recording_url: `${url}.mp3` }),
    });
    console.log('[Twilio recording-status] recording attached to log', row.id);

    // Fire-and-forget: create a Twilio Intelligence transcript for this
    // recording (uses the master account; no extra API key needed).
    try {
      const master = await getMasterTwilioSettings();
      const twilioAccountSid = master?.twilio_account_sid || '';
      const twilioAuthToken = master?.twilio_auth_token || '';
      if (twilioAccountSid && twilioAuthToken) {
        const serviceSid = process.env.TWILIO_INTELLIGENCE_SID || '';
        const body: Record<string, string> = {
          SourceSid: (req.body.RecordingSid || ''),
        };
        if (serviceSid) body.ServiceSid = serviceSid;
        const tr = await fetch(`https://intelligence.twilio.com/v2/Transcripts`, {
          method: 'POST',
          headers: {
            Authorization: 'Basic ' + Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams(body).toString(),
        });
        const tj = await tr.json().catch(() => ({}));
        if (tr.ok && tj?.sid) {
          await fetch(`${admin.base}/api/database/records/call_logs?id=eq.${row.id}`, {
            method: 'PATCH',
            headers: { ...admin.headers(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ transcription_sid: tj.sid, transcription_status: 'in-progress' }),
          });
          console.log('[Twilio recording-status] transcript job created:', tj.sid);
        } else {
          console.warn('[Twilio recording-status] transcript create failed:', tr.status, JSON.stringify(tj).slice(0, 200));
        }
      }
    } catch (e: any) {
      console.warn('[Twilio recording-status] transcript error:', e?.message || e);
    }
    res.status(200).send('OK');
  } catch (err) {
    console.error('[Twilio recording-status] error:', err);
    res.status(200).send('OK');
  }
});

// ── GET/POST /api/twilio/transcript-status ─────────────────────────
// Twilio Intelligence fires this when a transcript completes (or we poll).
// Pull the transcript text and attach it to the matching call_log row.
async function attachTranscript(transcriptSid: string): Promise<void> {
  const master = await getMasterTwilioSettings();
  const acct = master?.twilio_account_sid || '';
  const tok = master?.twilio_auth_token || '';
  if (!acct || !tok) return;
  const auth = 'Basic ' + Buffer.from(`${acct}:${tok}`).toString('base64');
  const tr = await fetch(`https://intelligence.twilio.com/v2/Transcripts/${transcriptSid}/Sentences`, { headers: { Authorization: auth } });
  if (!tr.ok) throw new Error(`sentences fetch ${tr.status}`);
  const sentences = await tr.json().catch(() => ({}));
  const text = (sentences?.sentences || []).map((s: any) => s.transcript || '').join(' ').trim();
  if (!text) return;
  // Speaker-segmented form for the killer-calls scoring feed: each turn with
  // speaker label + audio offset, so downstream scoring gets clean rep/prospect
  // turns without re-diarization. Kept alongside the plain-text blob.
  // Intelligence doesn't return speaker labels — but dual-channel recordings
  // tag each sentence with media_channel (1 = rep leg, 2 = prospect leg).
  const segments = (sentences?.sentences || []).map((s: any) => ({
    speaker: s.media_channel === 1 ? 'rep' : s.media_channel === 2 ? 'prospect' : (s.speaker ?? null),
    text: (s.transcript || '').trim(),
    offset_ms: s.start_time != null ? Math.round(parseFloat(s.start_time) * 1000) : null,
  })).filter((seg: any) => seg.text);
  const admin = await adminFetch();
  await fetch(`${admin.base}/api/database/records/call_logs?transcription_sid=eq.${transcriptSid}`, {
    method: 'PATCH',
    headers: { ...admin.headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      transcription: text.slice(0, 10000),
      transcript_segments: segments.length ? JSON.stringify(segments.slice(0, 500)) : null,
      transcription_status: 'completed',
    }),
  });
  console.log(`[transcript-status] attached transcript for ${transcriptSid} (${text.length} chars)`);
}

router.all('/transcript-status', express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  try {
    const sid = req.body?.TranscriptSid || req.query?.TranscriptSid || '';
    if (sid) await attachTranscript(String(sid));
    res.status(200).send('OK');
  } catch (err: any) {
    console.error('[transcript-status] error:', err?.message || err);
    res.status(200).send('OK');
  }
});

// ── POST /api/twilio/webhook ───────────────────────────────────────
// Status callback webhook for call events (optional, for future use)
router.post('/webhook', express.json(), async (req: Request, res: Response) => {
  try {
    const eventType = req.body?.CallStatus;
    console.log(`[Twilio Webhook] Status: ${eventType}`);
    res.status(200).send('OK');
  } catch (err) {
    console.error('[Twilio Webhook] Error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Poll in-progress transcripts every 2 minutes (belt-and-braces alongside
// the webhook; Intelligence webhooks need per-service config).
export function startTranscriptPoller(): void {
  setInterval(async () => {
    try {
      const admin = await adminFetch();
      const pending = await fetch(`${admin.base}/api/database/records/call_logs?transcription_status=eq.in-progress&select=transcription_sid&limit=10`, { headers: admin.headers() }).then(r => r.json());
      const rows = (Array.isArray(pending) ? pending : pending?.data || []) as any[];
      for (const row of rows) {
        if (!row.transcription_sid) continue;
        try {
          await attachTranscript(row.transcription_sid);
        } catch {
          // Intelligence may still be processing — check its status explicitly
          try {
            const master = await getMasterTwilioSettings();
            const auth = 'Basic ' + Buffer.from(`${master?.twilio_account_sid}:${master?.twilio_auth_token}`).toString('base64');
            const st = await fetch(`https://intelligence.twilio.com/v2/Transcripts/${row.transcription_sid}`, { headers: { Authorization: auth } }).then(r => r.json());
            if (st?.status === 'failed' || st?.status === 'canceled') {
              await fetch(`${admin.base}/api/database/records/call_logs?transcription_sid=eq.${row.transcription_sid}`, {
                method: 'PATCH',
                headers: { ...admin.headers(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ transcription_status: 'failed' }),
              });
            }
          } catch { /* next poll */ }
        }
      }
    } catch { /* non-fatal */ }
  }, 2 * 60 * 1000);
}


// ── Killer-calls scoring feed (read-only, for the KillerCalls agent) ──
// GET /api/twilio/killer-calls/feed?since=<ISO>&rep=<uuid>&limit=<n>
// Returns completed calls with disposition answered|follow_up|redial,
// including recording proxy URLs + speaker-segmented transcripts.
// Auth: X-KillerCalls-Key header must match KILLER_CALLS_FEED_KEY env,
// OR a valid rep/master Bearer token (scoped to own rows).
const FEED_DISPOSITIONS = ['answered', 'follow_up', 'redial'];

router.get('/killer-calls/feed', async (req: Request, res: Response) => {
  try {
    const feedKey = process.env.KILLER_CALLS_FEED_KEY;
    const providedKey = String(req.headers['x-killercalls-key'] || '');
    const authHeader = req.headers.authorization || '';
    let scopeUserId: string | null = null;
    let authorized = false;

    if (feedKey && providedKey && providedKey === feedKey) {
      authorized = true; // full team scope
    } else if (authHeader.startsWith('Bearer ')) {
      // fall back to authenticated-user scope (rep sees own rows)
      try {
        const admin = await adminFetch();
        const me = await fetch(`${admin.base}/api/auth/admin/sessions`, { method: 'HEAD' }).catch(() => null);
        // Light-weight: decode JWT for user id (same pattern as requireAuth)
        const jwt = authHeader.slice(7);
        const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
        if (payload?.sub) { scopeUserId = String(payload.sub); authorized = true; }
      } catch { /* fall through */ }
    }
    if (!authorized) return res.status(401).json({ error: 'unauthorized' });

    const since = String(req.query.since || '');
    const sinceIso = since ? new Date(since).toISOString() : new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '100'), 10) || 100, 1), 500);

    const admin = await adminFetch();
    const filters = [
      `status=eq.completed`,
      `disposition=in.(${FEED_DISPOSITIONS.join(',')})`,
      `started_at=gt.${sinceIso}`,
      `order=started_at.asc`,
      `limit=${limit}`,
    ];
    if (scopeUserId) filters.push(`user_id=eq.${scopeUserId}`);
    if (req.query.rep) filters.push(`user_id=eq.${encodeURIComponent(String(req.query.rep))}`);
    const url = `${admin.base}/api/database/records/call_logs?${filters.join('&')}`;
    const r = await fetch(url, { headers: admin.headers() });
    if (!r.ok) return res.status(502).json({ error: 'upstream_error' });
    const data = await r.json();
    const rows = (Array.isArray(data) ? data : data?.data || []) as any[];

    const out = rows.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      lead_id: row.lead_id,
      campaign_id: row.campaign_id,
      direction: row.direction,
      duration_seconds: row.duration_seconds,
      disposition: row.disposition,
      disposition_sub: row.disposition_sub,
      notes: row.notes,
      from_number: row.from_number,
      to_number: row.to_number,
      call_sid: row.call_sid,
      started_at: row.started_at,
      ended_at: row.ended_at,
      recording_url: row.recording_url ? `${PUBLIC_BASE_URL()}/api/twilio/killer-calls/recording/${row.call_sid}` : null,
      transcription: row.transcription || null,
      transcript_segments: row.transcript_segments
        ? (typeof row.transcript_segments === 'string' ? JSON.parse(row.transcript_segments) : row.transcript_segments)
        : null,
    }));

    // Overlap hint: caller should re-poll from the last row's started_at minus
    // 60s; we also advertise the server's now so the cursor is unambiguous.
    res.json({
      data: out,
      cursor: {
        since_next: out.length ? out[out.length - 1].started_at : sinceIso,
        overlap_seconds: 60,
        server_now: new Date().toISOString(),
      },
    });
  } catch (err: any) {
    console.error('[killer-calls/feed] error:', err?.message);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ── Recording proxy (authenticated Twilio media → stream) ───────────
// GET /api/twilio/killer-calls/recording/:callSid
router.get('/killer-calls/recording/:callSid', async (req: Request, res: Response) => {
  try {
    const feedKey = process.env.KILLER_CALLS_FEED_KEY;
    const providedKey = String(req.headers['x-killercalls-key'] || '');
    const authHeader = req.headers.authorization || '';
    const authorized = (feedKey && providedKey === feedKey) || authHeader.startsWith('Bearer ');
    if (!authorized) return res.status(401).json({ error: 'unauthorized' });

    const master = await getMasterTwilioSettings();
    const acct = master?.twilio_account_sid || '';
    const tok = master?.twilio_auth_token || '';
    if (!acct || !tok) return res.status(503).json({ error: 'no_twilio_creds' });

    // Find the recording SID for this call
    const listRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${acct}/Recordings.json?CallSid=${encodeURIComponent(String(req.params.callSid))}&PageSize=5`,
      { headers: { Authorization: 'Basic ' + Buffer.from(`${acct}:${tok}`).toString('base64') } }
    );
    if (!listRes.ok) return res.status(502).json({ error: 'twilio_list_failed' });
    const list = await listRes.json();
    const rec = list?.recordings?.[0];
    if (!rec) return res.status(404).json({ error: 'no_recording' });

    const media = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${acct}/Recordings/${rec.sid}.mp3?Download=true`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${acct}:${tok}`).toString('base64') },
    });
    if (!media.ok || !media.body) return res.status(502).json({ error: 'twilio_media_failed' });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    const buf = Buffer.from(await media.arrayBuffer());
    res.send(buf);
  } catch (err: any) {
    console.error('[killer-calls/recording] error:', err?.message);
    res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
