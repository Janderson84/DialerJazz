import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('loglevel').setLevel('trace');
const { Device } = require('@twilio/voice-sdk');
const BASE='https://2c3de6c6d1ba--5173.jackhamr.app';
const anon='anon_bcfc813ef10de83615d15e342740dcdbe95b83a8';
const login = await fetch(BASE+'/_bf/api/auth/sessions',{method:'POST',headers:{'content-type':'application/json','x-api-key':anon},body:JSON.stringify({email:'james.a@salescloser.ai',password:'DialerJazz2026!'})});
const lj=await login.json();
const jwt = lj?.data?.accessToken||lj?.accessToken;
const tok = await fetch(BASE+'/api/twilio/token',{method:'POST',headers:{Authorization:'Bearer '+jwt}});
const tj=await tok.json();
console.log('token ok:', !!tj?.data?.token);
const device = new Device(tj.data.token, {});
device.on('error',(e)=>console.log('EV error:', e?.message||e));
try { await device.register(); console.log('register() ok'); } catch(e){ console.log('register FAIL:', e.message||e); }
try {
  const call = await Promise.race([
    device.connect({params:{To:'+12506862959',From:'+12173102729',Rep:'a4d41720-59e1-4850-8b15-e8841872e702'}}),
    new Promise((_,rej)=>setTimeout(()=>rej(new Error('CONNECT TIMEOUT 30s')),30000))
  ]);
  console.log('CONNECTED sid:', call.parameters?.CallSid);
  await device.destroy();
} catch(e){ console.log('CONNECT FAIL:', e.message||e); }
process.exit(0);
