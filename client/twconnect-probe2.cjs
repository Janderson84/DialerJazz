const { Device } = require('@twilio/voice-sdk');
const TOKEN = process.argv[2];
const TO = process.argv[3] || '+12038292983';
const device = new Device(TOKEN, {});
device.on('error', (e) => console.log('[probe2] device.error:', e && e.name, '|', e && e.message, '|', e && e.description));
(async () => {
  await device.register();
  console.log('[probe2] registered');
  const call = await device.connect({ params: { To: TO, From: '+12173102729' } });
  console.log('[probe2] connect resolved; initial status =', call.status());
  call.on('statusChange', (s) => console.log('[probe2] statusChange:', JSON.stringify(s)));
  call.on('accept', () => console.log('[probe2] ACCEPTED, sid =', call.parameters && call.parameters.CallSid));
  call.on('error', (e) => console.log('[probe2] call.error:', e && e.name, e && e.message));
  call.on('disconnect', () => { console.log('[probe2] disconnected'); process.exit(0); });
  setTimeout(() => { console.log('[probe2] final status after 20s =', call.status()); process.exit(3); }, 20000);
})();
