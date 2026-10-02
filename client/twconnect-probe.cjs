const { Device } = require('@twilio/voice-sdk');
const TOKEN = process.argv[2];
const TO = process.argv[3] || '+12038292983';
console.log('[probe] creating device...');
const device = new Device(TOKEN, {});
device.on('registered', () => console.log('[probe] registered'));
device.on('error', (e) => console.log('[probe] device.error:', e && e.name, e && e.message));
(async () => {
  try {
    await device.register();
    console.log('[probe] register() resolved');
    const timer = setTimeout(() => {
      console.log('[probe] RESULT: connect() NEVER SETTLED after 25s — signaling hang confirmed');
      process.exit(2);
    }, 25000);
    const call = await device.connect({ params: { To: TO, From: '+12173102729' } });
    clearTimeout(timer);
    console.log('[probe] connect() RESOLVED. CallSid:', call.parameters && call.parameters.CallSid);
    setTimeout(() => { try{call.disconnect();}catch(e){} process.exit(0); }, 4000);
  } catch (e) {
    console.log('[probe] connect REJECTED:', e && e.name, e && e.message);
    process.exit(1);
  }
})();
