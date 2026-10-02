import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
import { getMasterTwilioSettings, MASTER_ID } from '../lib/masterSettings.js';

const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'https://3a50c7f3047f--5173.jackhamr.app';

async function main() {
  const settings = await getMasterTwilioSettings();
  if (!settings?.twilio_account_sid || !settings?.twilio_auth_token) {
    console.error('Master Twilio creds not configured');
    process.exit(1);
  }
  const sid = settings.twilio_account_sid;
  const auth = 'Basic ' + Buffer.from(`${sid}:${settings.twilio_auth_token}`).toString('base64');

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PageSize=50`, {
    headers: { Authorization: auth },
  });
  const data = await res.json();
  const numbers = data.incoming_phone_numbers || [];

  const base = process.env.INFORGE_URL || process.env.INSFORGE_URL || 'http://localhost:7130';
  const admin = await fetch(`${base}/api/auth/admin/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.INSFORGE_ADMIN_USER || 'admin', password: process.env.INSFORGE_ADMIN_PASSWORD }),
  }).then(r => r.json());
  const token = admin.accessToken;
  const H = { Authorization: `Bearer ${token}`, apikey: token };
  const reps = await fetch(`${base}/api/database/records/team_members?select=rep_user_id,phone_number`, { headers: H }).then(r => r.json());
  const repRows = (Array.isArray(reps) ? reps : reps?.data || []) as { rep_user_id: string; phone_number: string | null }[];
  const phoneToRep = new Map<string, string>();
  for (const r of repRows) if (r.phone_number) phoneToRep.set(r.phone_number, r.rep_user_id);
  console.log('reps with numbers:', [...phoneToRep.entries()]);

  for (const n of numbers) {
    const rep = phoneToRep.get(n.phone_number) || MASTER_ID();
    const smsUrl = `${PUBLIC_BASE}/api/sms/inbound?rep=${rep}`;
    if (n.sms_url === smsUrl) {
      console.log(`OK   ${n.phone_number} already -> ${smsUrl}`);
      continue;
    }
    const upd = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers/${n.sid}.json`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ SmsUrl: smsUrl, SmsMethod: 'POST' }).toString(),
    });
    console.log(upd.ok ? `SET  ${n.phone_number} -> ${smsUrl}` : `FAIL ${n.phone_number}: ${upd.status}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
