// Deep signaling trace: wrap ws to log every frame sent/received.
const WS = require('ws');
const origSend = WS.prototype.send;
WS.prototype.send = function (data) {
  console.log('[WS>]', String(data).slice(0, 240));
  return origSend.call(this, data);
};
const origEmit = WS.prototype.emit;
WS.prototype.emit = function (ev, data) {
  if (ev === 'message') console.log('[WS<]', String(data).slice(0, 240));
  return origEmit.apply(this, arguments);
};
const { Device } = require('@twilio/voice-sdk');
const TOKEN = process.argv[2];
const TO = process.argv[3] || '+12038292983';
const device = new Device(TOKEN, {});
(async () => {
  await device.register();
  console.log('[probe3] registered; now connecting to', TO);
  const call = await device.connect({ params: { To: TO, From: '+12173102729' } });
  call.on('disconnect', () => { console.log('[probe3] DISCONNECTED'); process.exit(0); });
  call.on('accept', () => { console.log('[probe3] ACCEPTED'); setTimeout(()=>process.exit(0), 2000); });
  setTimeout(() => { console.log('[probe3] still hanging after 20s'); process.exit(3); }, 20000);
})();
