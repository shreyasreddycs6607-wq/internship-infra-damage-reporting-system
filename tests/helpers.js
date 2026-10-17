const os = require('os');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../src/app');
const { createUser } = require('../src/users');

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function boot(opts = {}) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idr-'));
  const app = createApp({ dbFile: ':memory:', uploadDir, rateLimit: false, ...opts });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const db = app.locals.db;
  const client = () => {
    let cookie = '';
    const call = async (method, url, body, extraHeaders = {}) => {
      const headers = { ...extraHeaders };
      if (cookie) headers.cookie = cookie;
      let payload = body;
      if (body && !(body instanceof FormData)) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
      const res = await fetch(base + url, { method, headers, body: payload });
      for (const c of res.headers.getSetCookie?.() || []) {
        const [kv] = c.split(';');
        cookie = /^sid=;/.test(c) || /Expires=Thu, 01 Jan 1970/i.test(c) ? '' : kv;
      }
      const type = res.headers.get('content-type') || '';
      const data = type.includes('json') ? await res.json() : type.startsWith('image/') ? Buffer.from(await res.arrayBuffer()) : await res.text();
      return { status: res.status, data, headers: res.headers };
    };
    return {
      get: (u, h) => call('GET', u, undefined, h), post: (u, b, h) => call('POST', u, b, h),
      patch: (u, b) => call('PATCH', u, b), put: (u, b) => call('PUT', u, b), del: (u) => call('DELETE', u),
      login: (email, password) => call('POST', '/api/auth/login', { email, password }),
    };
  };
  const mkUser = (role, n, extra = {}) =>
    createUser(db, { name: `${role} ${n}`, email: `${role}${n}@t.test`, password: 'password123', role, email_verified: 1, ...extra });
  const loginAs = async (role, n = 1, extra = {}) => {
    const email = `${role}${n}@t.test`;
    if (!db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) mkUser(role, n, extra);
    const c = client();
    const r = await c.login(email, 'password123');
    if (r.status !== 200) throw new Error('login failed ' + JSON.stringify(r.data));
    return c;
  };
  const reportForm = (over = {}) => {
    const f = new FormData();
    const v = { category_id: '1', title: 'Big pothole', description: 'Deep pothole near the school gate', address: 'Main St',
      lat: '12.97', lng: '77.59', location_source: 'map', ...over };
    for (const [k, val] of Object.entries(v)) if (val !== null && !['noImage', 'imageBytes', 'imageName'].includes(k)) f.append(k, val);
    if (!over.noImage) f.append('images', new Blob([over.imageBytes || PNG], { type: 'image/png' }), over.imageName || 'x.png');
    return f;
  };
  return { base, db, server, client, flush: () => app.locals.flushNotifications(), mkUser, loginAs, reportForm, uploadDir, close: () => server.close() };
}
module.exports = { boot, PNG };
