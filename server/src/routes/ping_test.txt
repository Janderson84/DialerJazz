import { NextFunction } from 'express';
import { getInsforgeClient } from '../lib/insforge.js';

/**
 * Injects the MASTER account's Twilio settings for rep accounts so the
 * whole team dials through the house Twilio account (James's), not their own.
 *
 * Behavior:
  *  - Reps (any user != MASTER_USER_ID) get the master's twilio_* fields
 *     injected into their settings row view, without ever seeing the raw
  *     secrets in the UI (values are used server-side only for token minting).
 *  - The master account is unaffected.
 */

export const MASTER_ID = () =>
  process.env.MASTER_USER_ID || 'a4d41720-59e1-4850-8b15-e8841872e702';

const TWILIO_FIELDS = [
  'twilio_account_sid',
  'twilio_auth_token',