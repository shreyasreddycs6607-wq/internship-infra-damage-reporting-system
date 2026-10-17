const { test, after, before } = require('node:test');
const assert = require('node:assert');
const { boot } = require('./helpers');
const { createApp } = require('../src/app');

const mails = [];
const mailer = { send: async (to, subject, text) => { mails.push({ to, subject, text }); } };
const lastMail = (to, re) => [...mails].reverse().find((m) => m.to === to && re.test(m.subject));
const tokenIn = (mail) => /token=([\w-]+)/.exec(mail.text)[1];

let t, admin, anon;
before(async () => {
  t = await boot({ mailer, appUrl: 'http://app.test' });
  admin = await t.loginAs('admin', 1);
  anon = t.client();
});
after(() => t.close());

const register = async (email, name = 'Asha Citizen', role) => {
  const c = t.client();
  const r = await c.post('/api/auth/register', { name, email, password: 'first-password-1', role });
  assert.equal(r.status, 201);
  await t.flush();
  return c;
};

test('registration emails a verification link; unverified accounts cannot report, contact or list', async () => {
  const c = await register('asha@x.test');
  const mail = lastMail('asha@x.test', /Verify/);
  assert.ok(mail, 'verification email sent');
  assert.match(mail.text, /^[\s\S]*http:\/\/app\.test\/#\/verify\?token=[\w-]{20,}/);
  assert.equal((await c.get('/api/auth/me')).data.user.email_verified, false);
  // gated actions
  const blocked = await c.post('/api/reports', t.reportForm());
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error, /verify your email/i);
  assert.equal((await c.post('/api/complaints', { subject: 'Anything', body: 'Some long enough text' })).status, 403);
  assert.equal((await c.post('/api/businesses/1/inquiries', { message: 'Hello there' })).status, 403);
  const ent = await register('ent@x.test', 'Ent Maker', 'entrepreneur');
  assert.equal((await ent.put('/api/my/business', { name: 'X Biz', category_id: 1 })).status, 403);
  // reading and browsing still work
  assert.equal((await c.get('/api/reports')).status, 200);
  assert.equal((await anon.get('/api/businesses')).status, 200);
});

test('the token is stored only as a hash', () => {
  const raw = tokenIn(lastMail('asha@x.test', /Verify/));
  const rows = t.db.prepare('SELECT token_hash FROM user_tokens').all();
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.token_hash !== raw && /^[0-9a-f]{64}$/.test(r.token_hash)));
});

test('verifying with the emailed token unlocks the account; tokens are single-use', async () => {
  const c = t.client();
  await c.login('asha@x.test', 'first-password-1');
  const token = tokenIn(lastMail('asha@x.test', /Verify/));
  assert.equal((await anon.post('/api/auth/verify', { token: 'x'.repeat(30) })).status, 400);
  assert.equal((await anon.post('/api/auth/verify', { token: 'short' })).status, 400);
  assert.equal((await anon.post('/api/auth/verify', {})).status, 400);
  assert.equal((await anon.post('/api/auth/verify', { token })).status, 200); // works without being logged in
  assert.equal((await c.get('/api/auth/me')).data.user.email_verified, true);
  assert.equal((await anon.post('/api/auth/verify', { token })).status, 400); // already spent
  assert.equal((await c.post('/api/reports', t.reportForm())).status, 201);
  assert.equal((await c.post('/api/auth/verify/request')).status, 409); // already verified
});

test('expired verification links are refused; resending issues a fresh one and voids the old', async () => {
  const c = await register('late@x.test', 'Late Person');
  const old = tokenIn(lastMail('late@x.test', /Verify/));
  assert.equal((await c.post('/api/auth/verify/request')).status, 200);
  await t.flush();
  const fresh = tokenIn(lastMail('late@x.test', /Verify/));
  assert.notEqual(fresh, old);
  assert.equal((await anon.post('/api/auth/verify', { token: old })).status, 400); // replaced
  t.db.prepare('UPDATE user_tokens SET expires_at = ?').run(Date.now() - 1000);
  assert.equal((await anon.post('/api/auth/verify', { token: fresh })).status, 400); // expired
  assert.equal((await anon.post('/api/auth/verify/request')).status, 401);
});

test('email alerts go only to verified addresses', async () => {
  const c = await t.loginAs('citizen', 7); // helper creates verified accounts
  const r = await c.post('/api/reports', t.reportForm());
  await t.flush();
  t.db.prepare("UPDATE users SET email_verified = 0 WHERE email = 'citizen7@t.test'").run();
  let n0 = mails.length;
  assert.equal((await admin.post(`/api/reports/${r.data.id}/status`, { to: 'UNDER_REVIEW' })).status, 200);
  await t.flush();
  assert.equal(mails.slice(n0).filter((m) => m.to === 'citizen7@t.test').length, 0); // unverified: no alert email
  assert.ok((await c.get('/api/notifications')).data.items.some((n) => /under review/.test(n.message))); // in-app still works
  t.db.prepare("UPDATE users SET email_verified = 1 WHERE email = 'citizen7@t.test'").run();
  n0 = mails.length;
  await admin.post(`/api/reports/${r.data.id}/status`, { to: 'ACCEPTED' });
  await t.flush();
  assert.ok(mails.slice(n0).some((m) => m.to === 'citizen7@t.test' && /accepted/.test(m.subject)));
});

test('forgot password: same answer for known and unknown emails; only known ones get mail', async () => {
  const n0 = mails.length;
  const known = await anon.post('/api/auth/forgot', { email: 'ASHA@x.test ' });
  const unknown = await anon.post('/api/auth/forgot', { email: 'nobody@x.test' });
  await t.flush();
  assert.equal(known.status, 200);
  assert.deepEqual(known.data, unknown.data);
  assert.equal(mails.slice(n0).filter((m) => /Reset/.test(m.subject)).length, 1);
  assert.equal(mails.slice(n0).find((m) => /Reset/.test(m.subject)).to, 'asha@x.test');
  assert.equal((await anon.post('/api/auth/forgot', { email: 123 })).status, 200); // junk input does not leak or crash
  assert.equal((await anon.post('/api/auth/forgot', {})).status, 200);
});

test('reset: sets the password, signs out every session, verifies the mailbox, single-use', async () => {
  const s1 = t.client(), s2 = t.client();
  await s1.login('asha@x.test', 'first-password-1');
  await s2.login('asha@x.test', 'first-password-1');
  await anon.post('/api/auth/forgot', { email: 'asha@x.test' });
  await t.flush();
  const token = tokenIn(lastMail('asha@x.test', /Reset/));
  assert.equal((await anon.post('/api/auth/reset', { token, password: 'short' })).status, 400); // weak password does not burn the token
  assert.equal((await anon.post('/api/auth/reset', { token: 'z'.repeat(40), password: 'second-password-2' })).status, 400);
  assert.equal((await anon.post('/api/auth/reset', { token, password: 'second-password-2' })).status, 200);
  assert.equal((await s1.get('/api/auth/me')).status, 401);
  assert.equal((await s2.get('/api/auth/me')).status, 401);
  assert.equal((await t.client().login('asha@x.test', 'first-password-1')).status, 401); // old password dead
  assert.equal((await t.client().login('asha@x.test', 'second-password-2')).status, 200);
  assert.equal((await anon.post('/api/auth/reset', { token, password: 'third-password-3' })).status, 400); // single use
  // a user who never verified becomes verified by proving mailbox access
  await register('reset-only@x.test', 'Reset Only');
  await anon.post('/api/auth/forgot', { email: 'reset-only@x.test' });
  await t.flush();
  await anon.post('/api/auth/reset', { token: tokenIn(lastMail('reset-only@x.test', /Reset/)), password: 'new-password-9' });
  assert.equal(t.db.prepare("SELECT email_verified v FROM users WHERE email='reset-only@x.test'").get().v, 1);
});

test('reset links expire after an hour and a newer link voids the older one', async () => {
  await anon.post('/api/auth/forgot', { email: 'late@x.test' });
  await t.flush();
  const first = tokenIn(lastMail('late@x.test', /Reset/));
  await anon.post('/api/auth/forgot', { email: 'late@x.test' });
  await t.flush();
  const second = tokenIn(lastMail('late@x.test', /Reset/));
  assert.equal((await anon.post('/api/auth/reset', { token: first, password: 'brand-new-pass1' })).status, 400);
  t.db.prepare('UPDATE user_tokens SET expires_at = ? WHERE purpose = ?').run(Date.now() - 1, 'reset');
  assert.equal((await anon.post('/api/auth/reset', { token: second, password: 'brand-new-pass1' })).status, 400);
  // a verification token cannot be used as a reset token
  const c = await register('purpose@x.test', 'Purpose Check');
  void c;
  const v = tokenIn(lastMail('purpose@x.test', /Verify/));
  assert.equal((await anon.post('/api/auth/reset', { token: v, password: 'brand-new-pass1' })).status, 400);
});

test('deactivated accounts cannot get reset links', async () => {
  await register('deact@x.test', 'Deactivated Person');
  const u = t.db.prepare("SELECT id FROM users WHERE email='deact@x.test'").get();
  t.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(u.id);
  const n0 = mails.length;
  assert.equal((await anon.post('/api/auth/forgot', { email: 'deact@x.test' })).status, 200);
  await t.flush();
  assert.equal(mails.slice(n0).length, 0);
});

test('admin-created accounts start verified; self-registration without email configured is never blocked', async () => {
  const r = await admin.post('/api/admin/users', { name: 'New Officer', email: 'newoff@x.test', password: 'temp-password-1', role: 'officer' });
  assert.equal(r.data.user.email_verified, true);
  const plain = await boot(); // no email provider
  try {
    const c = plain.client();
    await c.post('/api/auth/register', { name: 'Dev User', email: 'dev@x.test', password: 'password123' });
    assert.equal((await c.post('/api/reports', plain.reportForm())).status, 201); // nothing to verify against, so not blocked
    assert.equal((await c.post('/api/auth/verify/request')).status, 409);
    const f = await c.post('/api/auth/forgot', { email: 'dev@x.test' });
    assert.equal(f.status, 503); // honest about being unavailable
    assert.match(f.data.error, /administrator/);
  } finally { plain.close(); }
});

test('forgot/reset are rate limited', async () => {
  const lt = await boot({ mailer, appUrl: 'http://app.test', rateLimit: true });
  try {
    const c = lt.client();
    let last;
    for (let i = 0; i < 7; i++) last = await c.post('/api/auth/forgot', { email: 'x@y.test' });
    assert.equal(last.status, 429);
  } finally { lt.close(); }
});

test('startup refuses email without an APP_URL (links would be unusable)', () => {
  assert.throws(() => createApp({ dbFile: ':memory:', uploadDir: require('os').tmpdir(), mailer, appUrl: '' }), /APP_URL/);
});
