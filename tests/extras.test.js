const { test, after, before } = require('node:test');
const assert = require('node:assert');
const { boot, PNG } = require('./helpers');
const { makeMailer, makeSms } = require('../src/channels');

// ---------- helpers shared by the three groups ----------
const sentMail = [], sentSms = [];
let mailFails = false;
const mailer = { send: async (to, subject, text) => { if (mailFails) throw new Error('SMTP down'); sentMail.push({ to, subject, text }); } };
const sms = { send: async (to, body) => { sentSms.push({ to, body }); } };

let t, admin, ent, ent2, ent3, cust, cust2, anon, tiffin, tailor;
const profile = (over = {}) => ({
  name: 'Meena Tiffins', category_id: tiffin, description: 'Fresh home-cooked vegetarian tiffins delivered daily in the area.',
  city: 'Bengaluru', availability_text: 'Mon-Sat', lat: 12.97164, lng: 77.59456, ...over,
});
const approve = async (c, over = {}) => {
  const b = (await c.put('/api/my/business', profile(over))).data.business;
  await c.post('/api/my/business/services', { title: 'Lunch box', price: 80, price_unit: 'per box' });
  assert.equal((await admin.post(`/api/admin/businesses/${b.id}/review`, { decision: 'APPROVED' })).status, 200);
  return b.id;
};
const complete = async (customer, owner, bizId, message = 'Need ten lunch boxes') => {
  const svc = (await anon.get(`/api/businesses/${bizId}`)).data.services[0].id;
  const q = await customer.post(`/api/businesses/${bizId}/inquiries`, { message, service_id: svc, type: 'order' });
  assert.equal((await owner.post(`/api/inquiries/${q.data.id}/status`, { to: 'ACCEPTED' })).status, 200);
  assert.equal((await owner.post(`/api/inquiries/${q.data.id}/status`, { to: 'COMPLETED' })).status, 200);
  return q.data.id;
};

before(async () => {
  t = await boot({ mailer, sms, appUrl: 'http://app.test/' });
  admin = await t.loginAs('admin', 1);
  ent = await t.loginAs('entrepreneur', 1);
  ent2 = await t.loginAs('entrepreneur', 2);
  ent3 = await t.loginAs('entrepreneur', 3);
  cust = await t.loginAs('citizen', 1);
  cust2 = await t.loginAs('citizen', 2);
  anon = t.client();
  const cats = (await anon.get('/api/business-categories')).data.items;
  tiffin = cats.find((c) => /Tiffin/.test(c.name)).id;
  tailor = cats.find((c) => /Tailoring/.test(c.name)).id;
});
after(() => t.close());

// ================= email / SMS =================
test('channels are off unless configured; factories never fake a provider', async () => {
  assert.equal(makeMailer({}), null);
  assert.equal(makeMailer({ SMTP_HOST: 'smtp.x' }), null); // needs SMTP_FROM too
  assert.ok(makeMailer({ SMTP_HOST: 'smtp.x', SMTP_FROM: 'a@x.test' }));
  assert.equal(makeSms({}), null);
  assert.equal(makeSms({ TWILIO_ACCOUNT_SID: 'AC1' }), null);
  const plain = await boot();
  try { assert.deepEqual((await plain.client().get('/api/meta')).data.channels, { email: false, sms: false }); } finally { plain.close(); }
  assert.deepEqual((await anon.get('/api/meta')).data.channels, { email: true, sms: true });
});

test('real SMTP transport delivers through nodemailer to an SMTP server', async () => {
  const net = require('node:net');
  let received = '';
  const server = net.createServer((sock) => {
    let inData = false;
    sock.write('220 test ESMTP\r\n');
    sock.on('data', (chunk) => {
      for (const line of chunk.toString().split('\r\n').filter((l, i, arr) => l || i < arr.length - 1)) {
        if (inData) { if (line === '.') { inData = false; sock.write('250 queued\r\n'); } else received += line + '\n'; continue; }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 test\r\n');
        else if (cmd === 'DATA') { inData = true; sock.write('354 go\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const m = makeMailer({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.address().port), SMTP_FROM: 'noreply@city.test' });
    await m.send('citizen@x.test', 'Civic Repair Desk: Test', 'Hello from the test\nsecond line');
    assert.match(received, /Subject: Civic Repair Desk: Test/);
    assert.match(received, /To: citizen@x.test/);
    assert.match(received, /From: noreply@city.test/);
    assert.match(received, /Hello from the test/);
    // an unreachable server surfaces as a rejected promise (which the notifier records as 'failed')
    server.close();
    await assert.rejects(() => makeMailer({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_FROM: 'a@b.test' }).send('x@y.test', 's', 't'));
  } finally { server.close(); }
});

test('Twilio sender builds the right request and never leaks credentials in errors', async () => {
  const calls = [];
  const ok = makeSms({ TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'secret-token', TWILIO_FROM: '+15550001111' }, undefined,
    async (url, init) => { calls.push({ url, init }); return { ok: true, status: 201 }; });
  await ok.send('+919876543210', 'Hello');
  assert.match(calls[0].url, /\/Accounts\/AC123\/Messages\.json$/);
  assert.equal(calls[0].init.headers.authorization, 'Basic ' + Buffer.from('AC123:secret-token').toString('base64'));
  assert.equal(calls[0].init.body.get('To'), '+919876543210');
  assert.equal(calls[0].init.body.get('From'), '+15550001111');
  const bad = makeSms({ TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'secret-token', TWILIO_FROM: '+1' }, undefined, async () => ({ ok: false, status: 401 }));
  await assert.rejects(() => bad.send('+1', 'x'), (e) => /401/.test(e.message) && !/secret-token/.test(e.message));
});

test('email: sent on report events with a link, respects opt-out, outcome recorded', async () => {
  sentMail.length = 0;
  const r = await cust.post('/api/reports', t.reportForm());
  await t.flush();
  const mail = sentMail.find((m) => m.to === 'citizen1@t.test');
  assert.ok(mail, 'citizen should get an email');
  assert.match(mail.subject, /^Civic Repair Desk: Your report IDR-/);
  assert.ok(mail.text.includes(`http://app.test/#/reports/${r.data.id}`));
  const rows = t.db.prepare("SELECT status FROM notifications WHERE channel='email' AND user_id=(SELECT id FROM users WHERE email='citizen1@t.test')").all();
  assert.ok(rows.length >= 1 && rows.every((x) => x.status === 'sent'));
  // opt out -> no more email, in-app still arrives
  assert.equal((await cust.patch('/api/auth/me', { notify_email: false })).data.user.notify_email, false);
  sentMail.length = 0;
  await cust.post('/api/reports', t.reportForm({ title: 'Another pothole here' }));
  await t.flush();
  assert.equal(sentMail.filter((m) => m.to === 'citizen1@t.test').length, 0);
  assert.ok((await cust.get('/api/notifications')).data.items.length >= 2);
  await cust.patch('/api/auth/me', { notify_email: true });
});

test('in-app list and unread count never include email/SMS delivery rows', async () => {
  const n = (await cust.get('/api/notifications')).data;
  const inApp = t.db.prepare("SELECT COUNT(*) n FROM notifications WHERE channel='in_app' AND read_at IS NULL AND user_id=(SELECT id FROM users WHERE email='citizen1@t.test')").get().n;
  assert.equal(n.unread, inApp);
  assert.ok(n.items.every((x) => !/^(email|sms)$/.test(x.channel ?? '')));
});

test('SMS is opt-in, needs a valid number, and uses the normalised number', async () => {
  const bad = (body) => cust2.patch('/api/auth/me', body);
  assert.equal((await bad({ notify_sms: true })).status, 400); // no number yet
  assert.equal((await bad({ phone: '12345' })).status, 400);
  assert.equal((await bad({ phone: '98765 43210' })).status, 400); // must be international format
  const ok = await bad({ phone: '+91 98765-43210', notify_sms: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.phone, '+919876543210');
  sentSms.length = 0;
  await cust2.post('/api/reports', t.reportForm());
  await t.flush();
  assert.equal(sentSms.length, 1);
  assert.equal(sentSms[0].to, '+919876543210');
  assert.match(sentSms[0].body, /submitted/);
  // a user who never opted in gets no SMS even with a number on file
  await ent.patch('/api/auth/me', { phone: '+919000000000' });
  sentSms.length = 0;
  await approve(ent); // approval notifies the owner, who has a number but never opted in to SMS
  await t.flush();
  assert.equal(sentSms.filter((s) => s.to === '+919000000000').length, 0);
});

test('provider failure is recorded, visible to admins, and never breaks the action', async () => {
  mailFails = true;
  const r = await cust.post('/api/reports', t.reportForm({ title: 'Report while SMTP is down' }));
  assert.equal(r.status, 201); // the citizen's request still succeeds
  await t.flush();
  mailFails = false;
  const failed = t.db.prepare("SELECT status, error FROM notifications WHERE channel='email' AND status='failed'").all();
  assert.ok(failed.length >= 1);
  assert.match(failed[0].error, /SMTP down/);
  assert.equal((await cust.get('/api/admin/deliveries')).status, 403);
  const d = (await admin.get('/api/admin/deliveries?status=failed')).data;
  assert.ok(d.items.length >= 1 && d.items.every((x) => x.status === 'failed'));
  assert.ok(d.summary.some((x) => x.channel === 'email' && x.status === 'sent'));
  assert.ok(d.summary.some((x) => x.channel === 'email' && x.status === 'failed'));
});

// ================= ratings =================
test('ratings: only after a completed request, once, by that customer; shown publicly', async () => {
  const biz = await approve(ent2, { name: 'Lata Stitching', category_id: tailor, city: 'Mysuru', lat: 12.2958, lng: 76.6394 });
  const svc = (await anon.get(`/api/businesses/${biz}`)).data.services[0].id;
  const q = await cust.post(`/api/businesses/${biz}/inquiries`, { message: 'Blouse stitching please', service_id: svc, type: 'order' });
  const id = q.data.id;
  assert.equal((await cust.post(`/api/inquiries/${id}/review`, { rating: 5 })).status, 409); // not completed yet
  await ent2.post(`/api/inquiries/${id}/status`, { to: 'ACCEPTED' });
  await ent2.post(`/api/inquiries/${id}/status`, { to: 'COMPLETED' });
  assert.equal((await cust.get(`/api/inquiries/${id}`)).data.can_review, true);
  assert.equal((await ent2.get(`/api/inquiries/${id}`)).data.can_review, false);
  assert.equal((await cust.post(`/api/inquiries/${id}/review`, { rating: 0 })).status, 400);
  assert.equal((await cust.post(`/api/inquiries/${id}/review`, { rating: 3.5 })).status, 400);
  assert.equal((await cust2.post(`/api/inquiries/${id}/review`, { rating: 5 })).status, 404); // not their request
  assert.equal((await anon.post(`/api/inquiries/${id}/review`, { rating: 5 })).status, 401);
  assert.equal((await ent2.post(`/api/inquiries/${id}/review`, { rating: 5 })).status, 403); // owners cannot rate themselves
  const ok = await cust.post(`/api/inquiries/${id}/review`, { rating: 4, comment: 'Neat stitching, on time' });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.review.rating, 4);
  assert.equal(ok.data.can_review, false);
  assert.equal((await cust.post(`/api/inquiries/${id}/review`, { rating: 5 })).status, 409); // once per request
  assert.ok((await ent2.get('/api/notifications')).data.items.some((n) => /rated Lata Stitching 4\/5/.test(n.message)));
  const d = (await anon.get(`/api/businesses/${biz}`)).data;
  assert.equal(d.rating_avg, 4);
  assert.equal(d.rating_count, 1);
  assert.match(d.reviews[0].reviewer, /^citizen /); // first name + last initial only, never email
  assert.ok(!JSON.stringify(d).includes('citizen1@t.test'));
});

test('ratings: averages, sorting by rating, and admin removal of abusive reviews', async () => {
  const biz2 = await approve(ent3, { name: 'Ruchi Beauty', category_id: tiffin, city: 'Bengaluru', lat: 12.98, lng: 77.6 });
  const biz1 = t.db.prepare("SELECT id FROM businesses WHERE name='Meena Tiffins'").get().id;
  const i1 = await complete(cust, ent, biz1);
  const i2 = await complete(cust, ent3, biz2);
  await cust.post(`/api/inquiries/${i1}/review`, { rating: 2 });
  await cust.post(`/api/inquiries/${i2}/review`, { rating: 5, comment: 'Wonderful' });
  const byRating = (await anon.get('/api/businesses?sort=rating')).data.items;
  assert.equal(byRating[0].name, 'Ruchi Beauty');
  assert.equal(byRating[0].rating_avg, 5);
  assert.equal(byRating.find((b) => b.name === 'Meena Tiffins').rating_avg, 2);
  const rid = (await anon.get(`/api/businesses/${biz2}`)).data.reviews[0].id;
  assert.equal((await cust.del(`/api/admin/reviews/${rid}`)).status, 403);
  assert.equal((await admin.del(`/api/admin/reviews/${rid}`)).status, 200);
  assert.equal((await admin.del(`/api/admin/reviews/${rid}`)).status, 404);
  assert.equal((await anon.get(`/api/businesses/${biz2}`)).data.rating_count, 0);
  assert.equal((await anon.get(`/api/businesses/${biz2}`)).data.rating_avg, null);
  assert.ok((await admin.get('/api/admin/audit?limit=100')).data.items.some((a) => a.action === 'review.delete'));
});

// ================= radius search =================
test('business location: validated and stored rounded to ~110 m', async () => {
  const bad = async (lat, lng) => assert.equal((await ent.put('/api/my/business', profile({ lat, lng }))).status, 400, `${lat},${lng}`);
  await bad(95, 10); await bad(10, 200); await bad('abc', 10);
  const meena = t.db.prepare("SELECT lat, lng FROM businesses WHERE name='Meena Tiffins'").get();
  assert.equal(meena.lat, 12.972); // 12.97164 rounded
  assert.equal(meena.lng, 77.595);
  // updating without coordinates keeps the stored location
  await ent.put('/api/my/business', (({ lat, lng, ...rest }) => rest)(profile()));
  assert.equal(t.db.prepare("SELECT lat FROM businesses WHERE name='Meena Tiffins'").get().lat, 12.972);
  // owner and public both see only the rounded value
  assert.equal((await anon.get(`/api/businesses/${t.db.prepare("SELECT id FROM businesses WHERE name='Meena Tiffins'").get().id}`)).data.lat, 12.972);
});

test('near me: radius filter, distance, ordering, exclusions, limits', async () => {
  const bad = async (qs) => assert.equal((await anon.get('/api/businesses?' + qs)).status, 400, qs);
  await bad('near_lat=12.97'); await bad('near_lat=95&near_lng=77'); await bad('near_lat=x&near_lng=y');
  const here = 'near_lat=12.9716&near_lng=77.5946';
  const small = (await anon.get(`/api/businesses?${here}&radius_km=10`)).data;
  assert.deepEqual(small.items.map((b) => b.name).sort(), ['Meena Tiffins', 'Ruchi Beauty']); // Mysuru is ~125 km away
  assert.ok(small.items.every((b) => typeof b.distance_km === 'number' && b.distance_km <= 10));
  assert.ok(small.items[0].distance_km <= small.items[1].distance_km); // nearest first by default
  assert.equal(small.items[0].name, 'Meena Tiffins');
  assert.ok(small.items.every((b) => b.lat === undefined)); // list never exposes coordinates
  const big = (await anon.get(`/api/businesses?${here}&radius_km=200`)).data;
  assert.equal(big.total, 3);
  assert.equal(big.items.at(-1).name, 'Lata Stitching');
  assert.ok(big.items.at(-1).distance_km > 100 && big.items.at(-1).distance_km < 150);
  // filters combine with distance
  assert.equal((await anon.get(`/api/businesses?${here}&radius_km=200&category_id=${tailor}`)).data.total, 1);
  // radius is clamped and defaults sensibly
  assert.equal((await anon.get(`/api/businesses?${here}&radius_km=99999`)).data.total, 3);
  assert.equal((await anon.get(`/api/businesses?${here}&radius_km=0.2`)).data.total, 1); // clamped to 1 km: only the one ~0.1 km away
  // a business without coordinates never matches a distance search but still appears in normal browsing
  const noGeo = await t.loginAs('entrepreneur', 4);
  const nb = await approve(noGeo, { name: 'No Location Crafts', lat: undefined, lng: undefined, category_id: tiffin });
  assert.ok(!(await anon.get(`/api/businesses?${here}&radius_km=200`)).data.items.some((b) => b.id === nb));
  assert.ok((await anon.get('/api/businesses?limit=50')).data.items.some((b) => b.id === nb));
  // pagination applies after the distance filter
  const p2 = (await anon.get(`/api/businesses?${here}&radius_km=200&limit=2&page=2`)).data;
  assert.equal(p2.total, 3);
  assert.equal(p2.items.length, 1);
  // sorting by rating still works together with a radius
  // Lata 4 stars, Meena 2 stars, Ruchi unrated (its only review was removed above) sorts last
  assert.deepEqual((await anon.get(`/api/businesses?${here}&radius_km=200&sort=rating`)).data.items.map((b) => b.name), ['Lata Stitching', 'Meena Tiffins', 'Ruchi Beauty']);
});
