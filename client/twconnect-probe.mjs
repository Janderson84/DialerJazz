import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const loglevel = require('loglevel');
import { Device } from '@twilio/voice-sdk';
loglevel.setLevel('warn');

const TOKEN = process.argv[2];
const TO = process.argv[3] || '+12038292983';

console.log('[probe] creating device...');
const device = new Device(TOKEN, { loggerFactory: () => ({ trace(){}, debug(){}, info(){}, warn(){}, error(){} }) });

device.on('registered', () => console.log('[probe] registered'));
device.on('error', (e) => console.log('[probe] device.error:', e?.name, e?.message));

try {
  console.log('[probe] connecting to', TO, '...');
  const timer = setTimeout(() => {
    console.log('[probe] RESULT: connect() NEVER SETTLED after 25s — signaling hang confirmed');
    process.exit(2);
  }, 25000);
  const call = await device.connect({ params: { To: TO, From: '+12173102729' } });
  clearTimeout(timer);
  console.log('[probe] connect() RESOLVED. CallSid:', call.parameters?.CallSid);
  console.log('[probe] status:', call.status());
  setTimeout(() => { call.disconnect(); process.exit(0); }, 4000);
} catch (e) {
  console.log('[probe] connect REJECTED:', e?.name, e?.message);
  process.exit(1);
}
