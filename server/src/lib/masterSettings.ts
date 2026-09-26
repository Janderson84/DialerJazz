import { NextFunction } from 'express';
import { getInsforgeClient } from '../lib/insforge.js';

/**
 * Injects the MASTER account's Twilio settings for rep accounts so the
 * whole team dials through the house Twilio account (James's), not their own.
 *
 * Behavior:
 *  - Reps (any user != MASTER_USER_ID) get the master's twilio_* fields
 *    injected into their settings row view, without ever seeing the raw
 *    secrets in the UI (values are used server-side only for token minting).
 *  - The master account is unaffected.
 */

export const MASTER_ID = () =>
  process.env.MASTER_USER_ID || 'a4d41720-59e1-4850-8b15-e8841872e702';

const TWILIO_FIELDS = [
  'twilio_account_sid',
  'twilio_auth_token',
  'twilio_api_key',
  'twilio_api_secret',
  'twilio_twiml_app_sid',
] as const;

/** Fetch the master's Twilio settings using the admin API (bypasses RLS). */
export async function getMasterTwilioSettings(): Promise<Record<string, string | null> | null> {
  const base = process.env.INFORGE_URL || process.env.INSFORGE_URL || 'http://localhost:7130';
  const username = process.env.INSFORGE_ADMIN_USER || 'admin';
  const password = process.env.INSFORGE_ADMIN_PASSWORD;
  if (!password) return null;

  const res = await fetch(`${base}/api/auth/admin/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) return null;
  const { accessToken } = await res.json();
  if (!accessToken) return null;

  const masterId = MASTER_ID();
  const settingsRes = await fetch(
    `${base}/api/database/records/user_settings?user_id=eq.${masterId}&select=${TWILIO_FIELDS.join(',')}`,
    { headers: { Authorization: `Bearer ${accessToken}`, apikey: accessToken } }
  );
  if (!settingsRes.ok) return null;
  const data = await settingsRes.json();
  const arr = Array.isArray(data) ? data : data?.data || [];
  const row = arr[0];
  if (!row?.twilio_account_sid) return null;
  return row;
}

/**
 * Express helper: returns the effective Twilio settings for a user —
 * their own row if they're the master, otherwise the master's row.
 */
export async function effectiveTwilioSettings(userId: string): Promise<Record<string, string | null> | null> {
  if (userId === MASTER_ID()) {
    // master's own settings — read via admin API too (consistent path)
    return getMasterTwilioSettings();
  }
  return getMasterTwilioSettings();
}

/** True if this user id belongs to a rep under the master's team. */
export function isRep(userId: string): boolean {
  return userId !== MASTER_ID();
}

/** Fetch a single field from the master's user_settings row via admin API. */
export async function getMasterSettingsField(field: string): Promise<string | null> {
  const base = process.env.INFORGE_URL || process.env.INSFORGE_URL || 'http://localhost:7130';
  const username = process.env.INSFORGE_ADMIN_USER || 'admin';
  const password = process.env.INSFORGE_ADMIN_PASSWORD;
  if (!password) return null;
  const res = await fetch(`${base}/api/auth/admin/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) return null;
  const { accessToken } = await res.json();
  if (!accessToken) return null;
  const r = await fetch(
    `${base}/api/database/records/user_settings?user_id=eq.${MASTER_ID()}&select=${field}`,
    { headers: { Authorization: `Bearer ${accessToken}`, apikey: accessToken } }
  );
  if (!r.ok) return null;
  const data = await r.json();
  const row = (Array.isArray(data) ? data : data?.data || [])[0];
  return row?.[field] || null;
}
