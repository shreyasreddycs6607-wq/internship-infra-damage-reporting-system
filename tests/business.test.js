const { test, after, before } = require('node:test');
const assert = require('node:assert');
const { boot, PNG } = require('./helpers');

let t, admin, ent, ent2, cust, cust2, anon, catId, bizId;
const profile = (over = {}) => ({
  name: 'Meena Tiffins', category_id: catId, description: 'Fresh home-cooked vegetarian tiffins delivered daily in the area.',
  city: 'Bengaluru', address: 'Indiranagar', contact_phone: '+91 98765 43210', pricing_info: 'Weekly plans available',
  availability_text: 'Mon-Sat 8am-6pm', ...over,
});
const imgForm = (bytes = PNG, name = 'x.png') => {
  const f = new FormData();
  f.append('images', new Blob([bytes], { type: 'image/png' }), name);
  return f;
};

before(async () => {
  t = await boot();
  admin = await t.loginAs('admin', 1);
  ent = await t.loginAs('entrepreneur', 1);
  ent2 = await t.loginAs('entrepreneur', 2);
  cust = await t.loginAs('citizen', 1);
  cust2 = await t.loginAs('citizen', 2);
  anon = t.client();
  catId = (await anon.get('/api/business-categories')).data.items.find((c) => /Tiffin/.test(c.name)).id;
});
after(() => t.close());

test('self-registration allows citizen or entrepreneur only', async () => {
  const reg = (name, email, role) => t.client().post('/api/auth/register', { name, email, password: 'password123', role });
  assert.equal((await reg('Eve Maker', 'eve@x.test', 'entrepreneur')).data.user.role, 'entrepreneur');
  assert.equal((await reg('Mal Actor', 'mal@x.test', 'admin')).data.user.role, 'citizen');
  assert.equal((await reg('Off Icer', 'off@x.test', 'officer')).data.user.role, 'citizen');
});

test('the four required categories and the guidance topics are seeded', async () => {
  const names = (await anon.get('/api/business-categories')).data.items.map((c) => c.name);
  for (const n of ['Tiffin / Home Food Service', 'Tailoring & Stitching', 'Beauty & Personal Care Services', 'Handicrafts & Handmade Products'])
    assert.ok(names.includes(n), n);
  const c = (await ent.get('/api/content')).data.items;
  for (const re of [/Pricing strategies/, /licensing and compliance/, /Cost estimation and profit planning/]) assert.ok(c.some((x) => re.test(x.title)), String(re));
  assert.ok(c.some((x) => x.kind === 'marketing'));
  assert.ok(c.some((x) => x.kind === 'learning'));
});

test('role separation', async () => {
  assert.equal((await ent.post('/api/reports', t.reportForm())).status, 403);
  assert.equal((await ent.get('/api/reports')).status, 403);
  assert.equal((await cust.get('/api/my/business')).status, 403);
  assert.equal((await cust.put('/api/my/business', profile())).status, 403);
  assert.equal((await cust.get('/api/content')).status, 403); // guidance is for entrepreneurs/admins
  assert.equal((await anon.get('/api/content')).status, 401);
});

test('profile: validation, created as PENDING, hidden from the public until approved', async () => {
  const bad = async (over) => assert.equal((await ent.put('/api/my/business', profile(over))).status, 400, JSON.stringify(over));
  await bad({ name: 'x' });
  await bad({ category_id: 9999 });
  await bad({ description: 'too short' });
  await bad({ city: '' });
  await bad({ contact_phone: '<script>' });
  assert.equal((await ent.get('/api/my/business')).data.business, null);
  assert.equal((await ent.post('/api/my/business/services', { title: 'Lunch', price: 80 })).status, 409); // needs a profile first
  const r = await ent.put('/api/my/business', profile());
  assert.equal(r.status, 201);
  assert.equal(r.data.business.status, 'PENDING');
  bizId = r.data.business.id;
  assert.equal((await ent.put('/api/my/business', profile({ name: 'Meena Home Tiffins' }))).status, 200); // update, not duplicate
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM businesses').get().n, 1);
  assert.equal((await anon.get('/api/businesses')).data.total, 0);
  assert.equal((await anon.get(`/api/businesses/${bizId}`)).status, 404);
  assert.equal((await cust.get(`/api/businesses/${bizId}`)).status, 404);
  assert.equal((await ent2.get(`/api/businesses/${bizId}`)).status, 404);
  assert.equal((await ent.get(`/api/businesses/${bizId}`)).status, 200); // owner sees it
  assert.equal((await admin.get(`/api/businesses/${bizId}`)).status, 200);
});

test('services: CRUD, validation, ownership', async () => {
  const s = await ent.post('/api/my/business/services', { title: 'Veg lunch box', description: '3 rotis, sabzi, rice', price: 80, price_unit: 'per box' });
  assert.equal(s.status, 201);
  assert.equal((await ent.post('/api/my/business/services', { title: 'Bad', price: -5 })).status, 400);
  assert.equal((await ent.post('/api/my/business/services', { title: 'Bad', price: 'abc' })).status, 400);
  assert.equal((await ent.post('/api/my/business/services', { title: 'Bad' })).status, 400);
  assert.equal((await ent.patch(`/api/my/business/services/${s.data.id}`, { price: 90 })).status, 200);
  await ent2.put('/api/my/business', profile({ name: 'Other Tailor' }));
  assert.equal((await ent2.patch(`/api/my/business/services/${s.data.id}`, { price: 1 })).status, 404);
  assert.equal((await ent2.del(`/api/my/business/services/${s.data.id}`)).status, 404);
  const svc = (await ent.get('/api/my/business')).data.business.services;
  assert.equal(svc.length, 1);
  assert.equal(svc[0].price, 90);
  const s2 = await ent.post('/api/my/business/services', { title: 'Dinner box', price: 70, available: false });
  assert.equal((await ent.del(`/api/my/business/services/${s2.data.id}`)).status, 200);
});

test('photos: validated by content, capped, served only when visible', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal((await ent.post('/api/my/business/images', imgForm(svg, 'a.png'))).status, 400);
  const ok = await ent.post('/api/my/business/images', imgForm());
  assert.equal(ok.status, 201);
  const url = ok.data.business.images[0].url;
  assert.equal((await anon.get(url)).status, 404); // still pending
  assert.equal((await ent.get(url)).status, 200);
  assert.equal((await ent2.get(url)).status, 404);
  for (let i = 0; i < 5; i++) assert.equal((await ent.post('/api/my/business/images', imgForm())).status, 201);
  assert.equal((await ent.post('/api/my/business/images', imgForm())).status, 400); // 7th photo refused
  const extra = (await ent.get('/api/my/business')).data.business.images[5];
  assert.equal((await ent.del(`/api/my/business/images/${extra.id}`)).status, 200);
  assert.equal((await ent2.del(`/api/my/business/images/${(await ent.get('/api/my/business')).data.business.images[0].id}`)).status, 404);
});

test('admin review: approve makes it public; reject/suspend need a reason; non-admin refused', async () => {
  assert.equal((await ent.post(`/api/admin/businesses/${bizId}/review`, { decision: 'APPROVED' })).status, 403);
  assert.equal((await cust.get('/api/admin/businesses')).status, 403);
  const q = (await admin.get('/api/admin/businesses?status=PENDING')).data;
  assert.ok(q.items.some((b) => b.id === bizId));
  assert.equal((await admin.post(`/api/admin/businesses/${bizId}/review`, { decision: 'REJECTED' })).status, 400);
  assert.equal((await admin.post(`/api/admin/businesses/${bizId}/review`, { decision: 'MAYBE' })).status, 400);
  assert.equal((await admin.post(`/api/admin/businesses/${bizId}/review`, { decision: 'REJECTED', note: 'Please add real photos of your kitchen' })).status, 200);
  assert.equal((await anon.get('/api/businesses')).data.total, 0);
  const owner = (await ent.get('/api/my/business')).data.business;
  assert.equal(owner.status, 'REJECTED');
  assert.match(owner.review_note, /kitchen/);
  // owner fixes and resubmits -> back to PENDING
  assert.equal((await ent.put('/api/my/business', profile({ name: 'Meena Home Tiffins' }))).data.business.status, 'PENDING');
  assert.equal((await admin.post(`/api/admin/businesses/${bizId}/review`, { decision: 'APPROVED' })).status, 200);
  assert.equal((await admin.post(`/api/admin/businesses/${bizId}/review`, { decision: 'APPROVED' })).status, 409);
  const notes = (await ent.get('/api/notifications')).data.items;
  assert.ok(notes.some((n) => /approved/.test(n.message) && n.link === '#/my-business'));
  assert.ok(notes.some((n) => /rejected/.test(n.message)));
});

test('customers can browse, search and filter verified businesses (no login needed)', async () => {
  // second approved business in another category/city
  const tailor = (await anon.get('/api/business-categories')).data.items.find((c) => /Tailoring/.test(c.name)).id;
  const b2 = (await ent2.put('/api/my/business', profile({ name: 'Lata Stitching', category_id: tailor, city: 'Mysuru', description: 'Blouse stitching and alterations by an experienced tailor.', accepting_orders: false }))).data.business;
  await ent2.post('/api/my/business/services', { title: 'Blouse stitching', price: 450, price_unit: 'per piece' });
  await admin.post(`/api/admin/businesses/${b2.id}/review`, { decision: 'APPROVED' });
  const all = (await anon.get('/api/businesses')).data;
  assert.equal(all.total, 2);
  assert.ok(all.items.every((b) => b.verified && b.phone === undefined));
  assert.equal(all.items.find((b) => b.id === bizId).from_price, 90);
  assert.equal((await anon.get(`/api/businesses?category_id=${tailor}`)).data.total, 1);
  assert.equal((await anon.get('/api/businesses?city=bengaluru')).data.total, 1); // case-insensitive location
  assert.equal((await anon.get('/api/businesses?available=1')).data.total, 1); // only the one accepting requests
  assert.equal((await anon.get('/api/businesses?q=blouse')).data.items[0].name, 'Lata Stitching'); // matches a service title
  assert.equal((await anon.get('/api/businesses?q=%25')).data.total, 0); // LIKE wildcard escaped
  assert.deepEqual((await anon.get('/api/businesses/cities')).data.items, ['Bengaluru', 'Mysuru']);
  const d = (await anon.get(`/api/businesses/${bizId}`)).data;
  assert.equal(d.verified, true);
  assert.equal(d.status, undefined); // internal state not exposed
  assert.equal(d.services.length, 1);
  assert.equal(d.images.length, 5);
  assert.equal((await anon.get(d.images[0].url)).status, 200); // approved photos are public
  // suspension hides it again
  await admin.post(`/api/admin/businesses/${b2.id}/review`, { decision: 'SUSPENDED', note: 'Under investigation' });
  assert.equal((await anon.get('/api/businesses')).data.total, 1);
  await admin.post(`/api/admin/businesses/${b2.id}/review`, { decision: 'APPROVED' });
});

test('inquiries: send, reply, status workflow, privacy', async () => {
  assert.equal((await anon.post(`/api/businesses/${bizId}/inquiries`, { message: 'Hello there' })).status, 401);
  assert.equal((await ent2.post(`/api/businesses/${bizId}/inquiries`, { message: 'Hello there' })).status, 403); // entrepreneurs are not customers
  assert.equal((await cust.post(`/api/businesses/${bizId}/inquiries`, { message: 'hi' })).status, 400);
  assert.equal((await cust.post('/api/businesses/9999/inquiries', { message: 'Hello there' })).status, 404);
  const svcId = (await ent.get('/api/my/business')).data.business.services[0].id;
  assert.equal((await cust.post(`/api/businesses/${bizId}/inquiries`, { message: 'Hello there', type: 'order' })).status, 400); // service required
  assert.equal((await cust.post(`/api/businesses/${bizId}/inquiries`, { message: 'Hello there', service_id: 99999 })).status, 400);
  const q = await cust.post(`/api/businesses/${bizId}/inquiries`, { message: 'Do you deliver to HSR Layout?', service_id: svcId });
  assert.equal(q.status, 201);
  const id = q.data.id;
  // owner is notified with a link; sees it in the inbox
  assert.ok((await ent.get('/api/notifications')).data.items.some((n) => n.link === `#/inquiries/${id}` && /inquiry/.test(n.message)));
  assert.equal((await ent.get('/api/inquiries')).data.items.length, 1);
  assert.equal((await cust.get('/api/inquiries')).data.items.length, 1);
  assert.equal((await cust2.get('/api/inquiries')).data.items.length, 0);
  // strangers cannot read or write
  assert.equal((await cust2.get(`/api/inquiries/${id}`)).status, 404);
  assert.equal((await ent2.get(`/api/inquiries/${id}`)).status, 404);
  assert.equal((await admin.get(`/api/inquiries/${id}`)).status, 404);
  assert.equal((await cust2.post(`/api/inquiries/${id}/messages`, { body: 'intrude' })).status, 404);
  assert.equal((await cust2.post(`/api/inquiries/${id}/status`, { to: 'CANCELLED' })).status, 404);
  // owner replies -> REPLIED; customer cannot accept their own request
  const rep = await ent.post(`/api/inquiries/${id}/messages`, { body: 'Yes, free delivery within 5 km.' });
  assert.equal(rep.data.status, 'REPLIED');
  assert.equal(rep.data.messages.length, 2);
  assert.equal(rep.data.you_are, 'owner');
  assert.equal((await cust.post(`/api/inquiries/${id}/status`, { to: 'ACCEPTED' })).status, 409);
  assert.equal((await ent.post(`/api/inquiries/${id}/status`, { to: 'COMPLETED' })).status, 409); // must accept first
  assert.equal((await ent.post(`/api/inquiries/${id}/status`, { to: 'ACCEPTED' })).data.status, 'ACCEPTED');
  assert.deepEqual((await cust.get(`/api/inquiries/${id}`)).data.allowed, ['CANCELLED']);
  assert.equal((await ent.post(`/api/inquiries/${id}/status`, { to: 'COMPLETED' })).data.status, 'COMPLETED');
  assert.equal((await ent.post(`/api/inquiries/${id}/messages`, { body: 'after close' })).status, 409);
  assert.equal((await cust.post(`/api/inquiries/${id}/status`, { to: 'CANCELLED' })).status, 409); // finished
  // customer cancel path, and order against an unavailable business
  const q2 = await cust.post(`/api/businesses/${bizId}/inquiries`, { message: 'Order for tomorrow please', service_id: svcId, type: 'order' });
  assert.equal((await cust.post(`/api/inquiries/${q2.data.id}/status`, { to: 'CANCELLED' })).data.status, 'CANCELLED');
  await ent.put('/api/my/business', profile({ name: 'Meena Home Tiffins', accepting_orders: false }));
  assert.equal((await cust.post(`/api/businesses/${bizId}/inquiries`, { message: 'Order for tomorrow please', service_id: svcId, type: 'order' })).status, 409);
  assert.equal((await cust.post(`/api/businesses/${bizId}/inquiries`, { message: 'Just a question here', type: 'inquiry' })).status, 201); // inquiries still allowed
  await ent.put('/api/my/business', profile({ name: 'Meena Home Tiffins', accepting_orders: true }));
});

test('complaints: filed by users, handled by admin, notifications both ways', async () => {
  assert.equal((await anon.post('/api/complaints', { subject: 'Bad', body: 'long enough text here' })).status, 401);
  assert.equal((await cust.post('/api/complaints', { subject: 'x', body: 'short' })).status, 400);
  assert.equal((await cust.post('/api/complaints', { subject: 'Wrong item', body: 'Received something different', business_id: 99999 })).status, 400);
  const c = await cust.post('/api/complaints', { subject: 'Wrong item delivered', body: 'I received a different meal than ordered.', business_id: bizId });
  assert.equal(c.status, 201);
  assert.ok((await admin.get('/api/notifications')).data.items.some((n) => /complaint/i.test(n.message) && n.link === '#/admin/complaints'));
  assert.equal((await cust.get('/api/admin/complaints')).status, 403);
  const list = (await admin.get('/api/admin/complaints?status=OPEN')).data.items;
  assert.equal(list[0].business_name, 'Meena Home Tiffins');
  assert.equal((await admin.patch(`/api/admin/complaints/${c.data.id}`, { status: 'RESOLVED' })).status, 400); // note required
  assert.equal((await admin.patch(`/api/admin/complaints/${c.data.id}`, { status: 'IN_REVIEW' })).status, 200);
  assert.equal((await admin.patch(`/api/admin/complaints/${c.data.id}`, { status: 'RESOLVED', admin_note: 'Refund arranged with the seller' })).status, 200);
  const mine = (await cust.get('/api/complaints/mine')).data.items;
  assert.equal(mine[0].status, 'RESOLVED');
  assert.match(mine[0].admin_note, /Refund/);
  assert.equal((await cust2.get('/api/complaints/mine')).data.items.length, 0);
  assert.ok((await cust.get('/api/notifications')).data.items.some((n) => /resolved/.test(n.message)));
});

test('content management: admin CRUD, unpublished hidden from entrepreneurs', async () => {
  assert.equal((await ent.post('/api/admin/content', { kind: 'guide', title: 'Hack', body: 'should not work at all' })).status, 403);
  assert.equal((await admin.post('/api/admin/content', { kind: 'nonsense', title: 'Bad kind', body: 'should not work at all' })).status, 400);
  const c = await admin.post('/api/admin/content', { kind: 'marketing', title: 'Festival season tips', body: 'Offer festival combo boxes early.', published: false });
  assert.equal(c.status, 201);
  assert.ok(!(await ent.get('/api/content')).data.items.some((x) => x.id === c.data.id));
  assert.ok((await admin.get('/api/content?all=1')).data.items.some((x) => x.id === c.data.id));
  assert.equal((await admin.patch(`/api/admin/content/${c.data.id}`, { published: true })).status, 200);
  assert.ok((await ent.get('/api/content?kind=marketing')).data.items.some((x) => x.id === c.data.id));
  assert.equal((await admin.del(`/api/admin/content/${c.data.id}`)).status, 200);
  assert.equal((await admin.del(`/api/admin/content/${c.data.id}`)).status, 404);
});

test('admin manages business categories; inactive ones cannot be chosen', async () => {
  const c = await admin.post('/api/admin/business-categories', { name: 'Pickles & Preserves' });
  assert.equal(c.status, 201);
  assert.equal((await admin.post('/api/admin/business-categories', { name: 'Pickles & Preserves' })).status, 409);
  assert.equal((await ent.post('/api/admin/business-categories', { name: 'Nope nope' })).status, 403);
  assert.equal((await admin.patch(`/api/admin/business-categories/${c.data.id}`, { active: false })).status, 200);
  assert.ok(!(await anon.get('/api/business-categories')).data.items.some((x) => x.id === c.data.id));
  assert.equal((await ent.put('/api/my/business', profile({ name: 'Meena Home Tiffins', category_id: c.data.id }))).status, 400);
});

test('platform activity statistics and audit entries', async () => {
  const a = (await admin.get('/api/admin/analytics')).data.platform;
  assert.equal(a.businesses_by_status.APPROVED, 2);
  assert.ok(a.users_by_role.entrepreneur >= 2);
  assert.ok(a.inquiries_by_status.COMPLETED >= 1);
  assert.equal(a.complaints_by_status.RESOLVED, 1);
  assert.ok(a.businesses_by_category.some((c) => c.category === 'Tailoring & Stitching' && c.n === 1));
  const actions = (await admin.get('/api/admin/audit?limit=100')).data.items.map((x) => x.action);
  for (const w of ['business.review', 'complaint.update', 'content.create', 'business_category.create']) assert.ok(actions.includes(w), w);
});
