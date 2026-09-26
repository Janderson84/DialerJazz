import express, { Router, Request, Response } from 'express';
import twilio from 'twilio';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { getMasterTwilioSettings, MASTER_ID } from '../lib/masterSettings.js';

const PUBLIC_BASE_URL = () =>
  process.env.PUBLIC_BASE_URL || 'https://2c3de6c6d1ba--5173.jackhamr.app';

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

    console.log('[twilio/token] Generating token for user:', userId);

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
router.post('/voice', express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  try {
    const twiml = new twilio.twiml.VoiceResponse();
    const to = req.body.To;
    const from = req.body.From || req.body.Caller;

    console.log(`[Twilio Voice Webhook] To=${to}, From=${from}`);

    // Validate callerId - Twilio requires a verified phone number for outbound calls
    // The client already validates this before calling device.connect() (TwilioContext line 313)
    if (!from || !/^\+?\d{10,15}$/.test(from.replace(/[\s\-()]/g, ''))) {
      console.error('[Twilio Voice Webhook] Missing or invalid callerId (From):', from);
      twiml.say('Caller ID not configured. Please set a verified phone number in your connector settings.');
      res.type('text/xml').send(twiml.toString());
      return;
    }

    if (to && /^[\d+\-() ]+$/.test(to)) {
      // Outbound to a phone number — use answering machine detection with a
      // rep-aware callback. If the callee is a machine, Twilio drops the rep's
      // voicemail; if human, the callback bridges the call to the rep's browser.
      const repId = (req.query.rep as string) || MASTER_ID();
      const clean = to.replace(/[^\d+]/g, '');
      const amd = twiml.dial({ callerId: from, machineDetection: 'DetectMessageEnd', machineDetectionTimeout: 10 } as any);
      amd.number({
        url: `${PUBLIC_BASE_URL()}/api/voicemail/amd-callback?rep=${repId}`,
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

    const dial = twiml.dial({ callerId: from, timeout: 25 });
    dial.client(targetClient);
    // If the rep doesn't answer, take a voicemail
    twiml.say('The person you are calling is unavailable. Please leave a message after the tone.');

    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('[Twilio Inbound] Error:', err);
    res.status(500).type('text/xml').send('<Response><Say>An error occurred.</Say></Response>');
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

export default router;