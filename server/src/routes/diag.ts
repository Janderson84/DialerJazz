import { Router, Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.js';

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

export default router;
