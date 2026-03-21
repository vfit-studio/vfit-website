/*
 * VFIT Studio - SMS Notifications via Twilio
 *
 * Environment variables (all optional):
 *   TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM, OWNER_PHONE
 */

async function sendSMS(to, message) {
  if (!process.env.TWILIO_SID || !process.env.TWILIO_TOKEN || !process.env.TWILIO_FROM) return;
  const accountSid = process.env.TWILIO_SID;
  const authToken = process.env.TWILIO_TOKEN;
  const from = process.env.TWILIO_FROM;

  // Use fetch instead of twilio SDK to avoid extra dependency
  const auth = Buffer.from(accountSid + ':' + authToken).toString('base64');
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, From: from, Body: message }).toString()
  }).catch(err => console.error('SMS error:', err));
}

async function sendOwnerSMS(message) {
  if (!process.env.OWNER_PHONE) return;
  await sendSMS(process.env.OWNER_PHONE, message);
}

module.exports = { sendSMS, sendOwnerSMS };
