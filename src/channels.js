// Outbound notification providers. Each factory returns null unless it is configured, so the app never
// claims to have sent something it cannot send. Tests inject fakes through createApp({ mailer, sms }).
const nodemailer = require('nodemailer');

// Email over SMTP. Env: SMTP_HOST, SMTP_FROM (required); SMTP_PORT (587), SMTP_SECURE=1 (for port 465), SMTP_USER, SMTP_PASS.
function makeMailer(env, override) {
  if (override !== undefined) return override;
  if (!env.SMTP_HOST || !env.SMTP_FROM) return null;
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587), secure: env.SMTP_SECURE === '1',
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return { send: (to, subject, text) => transport.sendMail({ from: env.SMTP_FROM, to, subject, text }) };
}

// SMS through Twilio's REST API (no SDK). Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM.
function makeSms(env, override, fetchImpl = fetch) {
  if (override !== undefined) return override;
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from } = env;
  if (!sid || !token || !from) return null;
  return {
    send: async (to, body) => {
      const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST',
        headers: { authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: from, Body: body }),
      });
      if (!res.ok) throw new Error(`SMS provider returned HTTP ${res.status}`); // never include credentials in errors
    },
  };
}

module.exports = { makeMailer, makeSms };
