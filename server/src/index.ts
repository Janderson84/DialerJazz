import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { requireAuth, AuthenticatedRequest } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';

import settingsRouter from './routes/settings.js';
import campaignsRouter from './routes/campaigns.js';
import leadsRouter from './routes/leads.js';
import statsRouter from './routes/stats.js';
import callsRouter from './routes/calls.js';
import telnyxRouter from './routes/telnyx.js';
import twilioRouter, { startTranscriptPoller, startCallSidSweeper } from './routes/twilio.js';
import { ensureWebhooksWired } from './scripts/update-twilio-webhooks.js';
import followupsRouter from './routes/followups.js';
import teamRouter from './routes/team.js';
import voicemailRouter from './routes/voicemail.js';
import pipedriveRouter from './routes/pipedrive.js';
import diagRouter from './routes/diag.js';
import smsRouter, { startScheduledSweep } from './routes/sms.js';
import { ensureSchema } from './scripts/ensure-schema.js';

// In dev, load .env from parent dir. In production (Docker), env vars are injected.
if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: '../.env' });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175'
].filter(Boolean) as string[];

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  },
});

// InsForge auth bridge (parity with the Vite dev proxy). The @insforge/sdk
// posts auth calls to `${origin}/_bf/api/...` because the public tunnel edge
// blocks the /api/auth path prefix. In production the built client is served
// by THIS Express app, so /_bf must be proxied here too or login 404s.
// MUST sit before express.json(): a JSON parser consumes the request stream
// and the proxy then hangs waiting for a body that will never arrive.
const { createProxyMiddleware } = await import('http-proxy-middleware');
app.use('/_bf', createProxyMiddleware({
  target: process.env.INSFORGE_BACKEND_URL || 'http://127.0.0.1:7130',
  changeOrigin: true,
  pathRewrite: (p: string) => p.replace(/^\/_bf/, ''),
  cookiePathRewrite: { '/api/auth': '/_bf/api/auth' },
}));

// Middleware
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Protected Route Example
app.get('/api/me', requireAuth, (req: AuthenticatedRequest, res, next) => {
  try {
    res.json({
      message: 'Authentication successful',
      user: req.user,
    });
  } catch(err) {
    next(err);
  }
});

// ─── Rate Limiting ─────────────────────────────────────────
// General: 100 requests per minute per IP
app.set('trust proxy', 1); // behind the jackhamr tunnel / single reverse proxy

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many requests. Please try again later.' } },
});

// Strict: 10 requests per minute for expensive operations
const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many requests for this endpoint.' } },
});

app.use('/api', apiLimiter);

// InsForge auth bridge (parity with the Vite dev proxy) — mounted above,
// BEFORE the JSON body parser (a consumed stream makes the proxy hang).

// API Routes
app.use('/api/settings', settingsRouter);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/stats', statsRouter);
app.use('/api/calls', callsRouter);
app.use('/api/telnyx/token', strictLimiter);  // Extra protection on token generation
app.use('/api/telnyx', telnyxRouter);
app.use('/api/twilio/token', strictLimiter);  // Extra protection on token generation
app.use('/api/twilio', twilioRouter);
app.use('/api/followups', followupsRouter);
app.use('/api/team', teamRouter);
app.use('/api/voicemail', voicemailRouter);
app.use('/api/pipedrive', pipedriveRouter);
app.use('/api/diag', diagRouter);
app.use('/api/sms', smsRouter);

// ─── Static client: serve UI on both ports (5173 dev server and 3001 API) ─────────
// The 3001 API port also serves the built client so the published URL shows the app
// instead of a bare 404. Dev mode (tsx watch) still gets the client via Vite:5173.
const clientDist = path.resolve(__dirname, '../../client/dist');
app.use(express.static(clientDist));

// SPA catch-all: any non-API route returns index.html (all modes — dev
// server proxies /api here, and the published 3001 URL serves deep links too)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(clientDist, 'index.html'));
});

// Centralized Error handler (must be last middleware)
app.use(errorHandler);

// Socket.io connection
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3001;
if (process.env.NODE_ENV !== 'test') {
  ensureSchema(); // re-apply fragile SQL (campaign counter RPC) — InsForge reconciler drops unknown functions
  startScheduledSweep(); // fires due scheduled SMS every minute
  startTranscriptPoller(); // attaches completed call transcriptions
  startCallSidSweeper(); // stamps missing call_sids from Twilio records

  // Webhook drift guard: verify all lines' webhooks on boot and nightly;
  // auto-rewire if any drifted (caught Joe's line pointing at an old app).
  void ensureWebhooksWired().catch((e) => console.error('[webhook-guard] boot check failed:', e?.message || e));
  setInterval(() => {
    void ensureWebhooksWired().catch((e) => console.error('[webhook-guard] nightly check failed:', e?.message || e));
  }, 24 * 60 * 60 * 1000);
  httpServer.listen(PORT, () => {
    console.log(`🚀 SalesCloser Cold Call Machine API running on http://localhost:${PORT}`);
  });
}

export { app, io };
