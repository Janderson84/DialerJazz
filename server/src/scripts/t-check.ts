import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
import { getMasterTwilioSettings } from '../lib/masterSettings.js';
const s = await getMasterTwilioSettings();
console.log('keys:', s ? Object.keys(s) : null);
console.log('caller:', s?.twilio_caller_number);
