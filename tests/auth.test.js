const { test, after } = require('node:test');
const assert = require('node:assert');
const { boot } = require('./helpers');

let t;
test('setup', async () => { t = await boot(); });
after(() => t.close());

test('register logs in, sets HttpOnly SameSite cookie, role is forced to citizen', async () => {
  const c = t.client();
  const r = await c.post('/api/auth/register', { name: 'Ann Citizen', email: 'Ann@Example.com', password: 'longenough1', role: 'admin' });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.role, 'citizen');
  assert.equal(r.data.user.email, 'ann@example.com');
  const cookie = r.headers.getSetCookie()[0];
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.equal((await c.get('/api/auth/me')).data.user.email, 'ann@example.com');
});

test('passwords are hashed, never stored plain', () => {
  const row = t.db.prepare('SELECT hash FROM users WHERE email = ?').get('ann@example.com');
  assert.ok(!row.hash.includes('longenough1'));
  assert.match(row.hash, /^[0-9a-f]{32}:[0-9a-f]{64}$/);
});

test('registration validation and duplicates', async () => {
  const c = t.client();
  assert.equal((await c.post('/api/auth/register', { name: 'x', email: 'bad', password: 'short' })).status, 400);
  assert.equal((await c.post('/api/auth/register', { name: 'Ann Two', email: 'ann@example.com', password: 'longenough1' })).status, 409);
});

test('invalid logins give one generic error', async () => {
  const c = t.client();
  const a = await c.login('ann@example.com', 'wrongpassword');
  const b = await c.login('nobody@example.com', 'wrongpassword');
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.deepEqual(a.data, b.data);
});

test('logout invalidates the session server-side', async () => {
  const c = t.client();
  await c.login('ann@example.com', 'longenough1');
  assert.equal((await c.get('/api/auth/me')).status, 200);
  await c.post('/api/auth/logout');
  assert.equal((await c.get('/api/auth/me')).status, 401);
});

test('protected endpoints reject anonymous callers', async () => {
  const c = t.client();
  for (const u of ['/api/auth/me', '/api/reports', '/api/dashboard', '/api/admin/users', '/api/admin/analytics', '/api/notifications', '/api/images/1'])
    assert.equal((await c.get(u)).status, 401, u);
  assert.equal((await c.post('/api/reports/1/status', { to: 'ACCEPTED' })).status, 401);
});

test('cross-origin state-changing requests are blocked', async () => {
  const r = await t.client().post('/api/auth/login', { email: 'a@b.co', password: 'x' }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('password change requires current password and ends other sessions', async () => {
  const c1 = t.client(), c2 = t.client();
  await c1.login('ann@example.com', 'longenough1');
  await c2.login('ann@example.com', 'longenough1');
  assert.equal((await c1.patch('/api/auth/me', { current_password: 'nope', new_password: 'brandnew123' })).status, 403);
  assert.equal((await c1.patch('/api/auth/me', { current_password: 'longenough1', new_password: 'brandnew123' })).status, 200);
  assert.equal((await c2.get('/api/auth/me')).status, 401);
  assert.equal((await c1.get('/api/auth/me')).status, 200);
});

test('login is rate limited', async () => {
  const lt = await boot({ rateLimit: true });
  try {
    const c = lt.client();
    let last;
    for (let i = 0; i < 12; i++) last = await c.login('x@y.co', 'whatever123');
    assert.equal(last.status, 429);
  } finally { lt.close(); }
});

test('malformed JSON and unknown routes return clean errors', async () => {
  const res = await fetch(t.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Invalid request body' });
  assert.equal((await t.client().get('/api/nope')).status, 404);
});
