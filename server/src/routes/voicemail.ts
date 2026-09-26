import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import twilio from 'twilio';
import express from 'express';
import { getInsforgeClient } from '../lib/insforge.js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { getMasterTwilioSettings, MASTER_ID } from '../lib/masterSettings.js';

const router = Router();

const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'https://2c3de6c6d1ba--5173.jackhamr.app';

// ── Storage: one file per user at a time (replaced on upload) ───────
const VOICEMAIL_DIR = path.join(process.cwd(), 'uploads', 'voicemail');
fs.mkdirSync(VOICEMAIL_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB raw audio cap
  fileFilter: (_req, file, cb) => {
    const ok = /^audio\//.test(file.mimetype) || /\.(wav|mp3|m4a|ogg|flac)$/i.test(file.originalname);
    if (ok) cb(null, true);
    else cb(new ApiError(400, 'Only audio files are allowed (wav, mp3, m4a, ogg, flac)', 'bad_upload'));
  },
});

/** Convert any uploaded audio to Twilio-friendly mono 8kHz WAV via ffmpeg. */
function normalizeAudio(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y', '-i', inputPath,
      '-ar', '8000', '-ac', '1', '-codec:a', 'pcm_s16le',
      outputPath,
    ]);
    ff.stderr.on('data', () => { /* discard ffmpeg noise */ });
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    ff.on('error', reject);
  });
}

// ── POST /api/voicemail — upload (or replace) my voicemail drop ─────
router.post('/', requireAuth, upload.single('audio'), async (req: AuthenticatedRequest, res: Response, next) => {
  try {
    if (!req.file) throw new ApiError(400, 'No audio file received', 'bad_upload');

    const userId = req.user!.id;
    const rawPath = path.join(VOICEMAIL_DIR, `raw_${userId}`);
    const wavPath = path.join(VOICEMAIL_DIR, `${userId}.wav`);
    fs.writeFileSync(rawPath, req.file.buffer);

    await normalizeAudio(rawPath, wavPath);
    fs.unlinkSync(rawPath);

    // Remember who has a drop uploaded (metadata in user_settings)
    const { error } = await getInsforgeClient(req.user!.token).database
      .from('user_settings')
      .update({ voicemail_drop: `${PUBLIC_BASE}/api/voicemail/audio/${userId}`, updated_at: new Date().toISOString() })
      .eq('user_id', userId);
    if (error) throw new ApiError(500, error.message, 'db_error');

    // Set per-rep Twilio machine detection so their number auto-drops on machines
    // (outbound calls made through the shared webhook are dialled via <Number>; AMD params are set per-call in the client)
    res.json({ data: { voicemail_url: `${PUBLIC_BASE}/api/voicemail/audio/${userId}` } });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/voicemail/mine — current drop info ─────────────────────
router.get('/mine', requireAuth, async (req: AuthenticatedRequest, res: Response, next) => {
  try {
    const { data } = await getInsforgeClient(req.user!.token).database
      .from('user_settings')
      .select('voicemail_drop')
      .eq('user_id', req.user!.id)
      .single();
    res.json({ data: { voicemail_url: (data as any)?.voicemail_drop || null } });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/voicemail/mine — remove my drop ─────────────────────
router.delete('/mine', requireAuth, async (req: AuthenticatedRequest, res: Response, next) => {
  try {
    const userId = req.user!.id;
    const wavPath = path.join(VOICEMAIL_DIR, `${userId}.wav`);
    if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
    const { error } = await getInsforgeClient(req.user!.token).database
      .from('user_settings')
      .update({ voicemail_drop: null, updated_at: new Date().toISOString() })
      .eq('user_id', userId);
    if (error) throw new ApiError(500, error.message, 'db_error');
    res.json({ data: { ok: true } });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/voicemail/audio/:userId — public playback URL (Twilio fetches this) ──
router.get('/audio/:userId', (req: Request, res: Response) => {
  const wavPath = path.join(VOICEMAIL_DIR, path.basename(String(req.params.userId)) + '.wav');
  if (!fs.existsSync(wavPath)) {
    return res.status(404).type('text/xml').send('<Response><Say>No message available</Say></Response>');
  }
  res.setHeader('Content-Type', 'audio/wav');
  fs.createReadStream(wavPath).pipe(res);
});


// ── POST /api/voicemail/pivot — redirect the CURRENT outbound leg to the drop ──
// The rep clicks "Drop voicemail" mid-call; the client sends the CallSid of the
// outbound leg and Twilio redirects that leg to the drop TwiML.
router.post('/pivot', requireAuth, async (req: AuthenticatedRequest, res: Response, next) => {
  try {
    const callSid = String(req.body?.callSid || '');
    if (!/^CA[0-9a-f]{32}$/i.test(callSid)) throw new ApiError(400, 'Valid callSid required', 'bad_call_sid');

    const master = await getMasterTwilioSettings();
    const sid = master?.twilio_account_sid as string;
    const token = master?.twilio_auth_token as string;
    if (!sid || !token) throw new ApiError(400, 'Master Twilio not connected', 'no_twilio');
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');

    const repId = req.user!.id;
    const updateRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${callSid}.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ Url: `${PUBLIC_BASE}/api/voicemail/drop?rep=${repId}`, Method: 'POST' }).toString(),
    });
    if (!updateRes.ok) {
      const errTxt = await updateRes.text();
      throw new ApiError(502, `Twilio rejected redirect: ${errTxt.slice(0, 200)}`, 'twilio_error');
    }
    res.json({ data: { ok: true } });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/voicemail/drop — TwiML to play a drop during a live call ──
// Called by the client's Twilio Device with machineDetection params, or by the
// inbound fallback. Expects ?rep=<uuid> or resolves to caller's own drop.
router.post('/drop', express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  try {
    const repId = String((req.query.rep as string) || (req.body.rep as string) || MASTER_ID());
    const wavPath = path.join(VOICEMAIL_DIR, `${path.basename(repId)}.wav`);
    const twiml = new (await import('twilio')).default.twiml.VoiceResponse();
    if (!fs.existsSync(wavPath)) {
      twiml.say('No voicemail message has been recorded for this rep.');
    } else {
      twiml.play(`${PUBLIC_BASE}/api/voicemail/audio/${path.basename(repId)}`);
    }
    twiml.hangup();
    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('[voicemail/drop]', err);
    res.status(500).type('text/xml').send('<Response><Say>Error</Say></Response>');
  }
});

// ── POST /api/voicemail/amd-callback — machine detection result handler ──
// When the client dials with machineDetection, Twilio calls this with the
// outcome (human / machine_end / fax / unknown). If machine → play drop.
router.post('/amd-callback', express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  const status = req.body.AnsweredBy || 'unknown';
  const repId = req.query.rep as string;
  const callSid = req.body.CallSid;
  console.log(`[AMD] call ${callSid} answered by: ${status} (rep ${repId})`);

  const twiml = new twilio.twiml.VoiceResponse();
  if (status === 'machine_end_beep' || status === 'machine_end_silence' || status === 'machine_end_other') {
    // Machine finished greeting — play the voicemail drop
    const wavPath = path.join(VOICEMAIL_DIR, `${path.basename(repId || '')}.wav`);
    if (repId && fs.existsSync(wavPath)) {
      twiml.play(`${PUBLIC_BASE}/api/voicemail/audio/${path.basename(repId)}`);
    } else {
      twiml.say('No voicemail message available.');
    }
  } else if (status === 'human') {
    // Human answered — bridge the call to the rep's browser (normal connect flow)
    twiml.dial().client(`user_${repId}`);
  } else {
    // unknown/fax — safest is to bridge like a human; rep can drop manually
    twiml.dial().client(`user_${repId}`);
  }
  res.type('text/xml').send(twiml.toString());
});

export default router;
