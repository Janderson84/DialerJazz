/* Rewires SmsUrl + dial-action webhooks for every provisioned Twilio number. */
import { config } from 'dotenv';
config({ path: '../../.env' });
import { getInsforgeClient } from '../lib/insforge.js';
import { getMasterTwilioSettings, MASTER_ID } from '../lib/masterSettings.js';

const BASE = process.env.PUBLIC_BASE_URL || 'https://3a50c7f3047f--3001.jackhamr.app';

async function main() {
  const { sid, token } = await (async () => {
    const s = await getMasterTwilioSettings();
    if (!s?.twilio_account_sid || !s?.twilio_auth_token) throw new Error('no master twilio creds');
    return { sid: s.twilio_account_sid, token: s.twilio_auth_token };
  })();
  const master = MASTER_ID();

  const admin = await getInsforgeClient();
  const rowsRes = await fetch(`${admin.base}/api/database/records/team_members?select=rep_user_id,phone_number&limit=50`, { headers: admin.headers() });
  const rows = (await rowsRes.json()) || [];
  const reps = (Array.isArray(rows) ? rows : rows?.data || []) as any[];
  const targets: { rep: string; number: string }[] = reps
    .filter((r) => r.phone_number)
    .map((r) => ({ rep: r.rep_user_id, number: r.phone_number }));
  targets.push({ rep: master, number: '' }); // master numbers discovered via API

  const listRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PageSize=50`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64') },
  });
  const list = await listRes.json();
  for (const num of list.incoming_phone_numbers || []) {
    const match = targets.find((t) => t.number === num.phone_number);
    const repId = match?.rep || master;
    const smsUrl = `${BASE}/api/sms/inbound?rep=${repId}`;
    const voiceUrl = `${BASE}/api/twilio/inbound?rep=${repId}`;
    const statusUrl = `${BASE}/api/twilio/webhook`;
    const upd = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers/${num.sid}.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        SmsUrl: smsUrl,
        VoiceUrl: voiceUrl,
        StatusCallback: statusUrl,
      }).toString(),
    });
    console.log(upd.ok ? `OK ${num.phone_number} -> rep ${repId.slice(0, 8)}` : `FAIL ${num.phone_number}: ${await upd.text()}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
