const { test, after, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { boot, PNG } = require('./helpers');

let t, citizen, citizen2, lead, officer, otherOfficer, admin, deptId, otherDeptId;

before(async () => {
  t = await boot();
  deptId = Number(t.db.prepare("INSERT INTO departments(name) VALUES('Roads')").run().lastInsertRowid);
  otherDeptId = Number(t.db.prepare("INSERT INTO departments(name) VALUES('Water')").run().lastInsertRowid);
  t.db.prepare('UPDATE categories SET department_id=? WHERE id=1').run(deptId); // category 1 -> Roads
  citizen = await t.loginAs('citizen', 1);
  citizen2 = await t.loginAs('citizen', 2);
  lead = await t.loginAs('officer', 1, { department_id: deptId, can_assign: true });
  officer = await t.loginAs('officer', 2, { department_id: deptId });
  otherOfficer = await t.loginAs('officer', 3, { department_id: otherDeptId, can_assign: true });
  admin = await t.loginAs('admin', 1);
});
after(() => t.close());

const ids = (n) => t.db.prepare('SELECT id FROM users WHERE email = ?').get(n).id;
const mk = async (c = citizen, over = {}) => {
  const r = await c.post('/api/reports', t.reportForm(over));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
};

test('Journey A: citizen creates a report, gets a tracking number, sees it in history', async () => {
  const r = await mk();
  assert.match(r.tracking_no, /^IDR-\d{4}-[0-9A-F]{8}$/);
  const list = await citizen.get('/api/reports');
  assert.equal(list.data.total, 1);
  assert.equal(list.data.items[0].tracking_no, r.tracking_no);
  const d = (await citizen.get(`/api/reports/${r.id}`)).data;
  assert.equal(d.status, 'SUBMITTED');
  assert.equal(d.images.length, 1);
  assert.equal(d.events[0].to_value, 'SUBMITTED');
  assert.ok(d.created_at > 0 && d.due_at > d.created_at); // trusted server timestamps
  assert.equal(d.assignee, undefined); // citizens never see staff identity
  assert.equal((await citizen.get('/api/notifications')).data.unread, 1);
});

test('report validation: fields, category, coordinates, location, photo', async () => {
  const bad = async (over, msg) => assert.equal((await citizen.post('/api/reports', t.reportForm(over))).status, 400, msg);
  await bad({ title: 'abc' }, 'short title');
  await bad({ description: 'short' }, 'short description');
  await bad({ category_id: '999' }, 'unknown category');
  await bad({ lat: '95', lng: '10' }, 'lat range');
  await bad({ lat: '10', lng: '181' }, 'lng range');
  await bad({ lat: 'abc', lng: '10' }, 'lat nan');
  await bad({ lat: '10', lng: null }, 'one coordinate only');
  await bad({ lat: null, lng: null, address: '' }, 'no location at all');
  await bad({ noImage: true }, 'no photo');
  // coordinates optional when an address is given; source is forced to manual
  const r = await citizen.post('/api/reports', t.reportForm({ lat: null, lng: null, location_source: 'device' }));
  assert.equal(r.status, 201);
  const d = (await citizen.get(`/api/reports/${r.data.id}`)).data;
  assert.equal(d.lat, null);
  assert.equal(d.location_source, 'manual');
});

test('upload validation: magic bytes, size, storage name', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal((await citizen.post('/api/reports', t.reportForm({ imageBytes: svg, imageName: 'evil.png' }))).status, 400);
  assert.equal((await citizen.post('/api/reports', t.reportForm({ imageBytes: Buffer.from('MZ\x90\x00 not an image at all'), imageName: 'a.exe' }))).status, 400);
  const big = Buffer.concat([PNG, Buffer.alloc(6 * 1048576)]);
  assert.equal((await citizen.post('/api/reports', t.reportForm({ imageBytes: big }))).status, 413);
  const r = await mk(citizen, { imageName: '../../evil.php' });
  const img = t.db.prepare('SELECT * FROM report_images WHERE report_id = ?').get(r.id);
  assert.match(img.filename, /^[0-9a-f-]{36}\.png$/); // client name discarded, extension from detected type
  assert.ok(fs.existsSync(`${t.uploadDir}/${img.filename}`));
  assert.ok(!fs.readdirSync(t.uploadDir).some((f) => f.endsWith('.php')));
});

test('Journey D: IDOR and role boundaries', async () => {
  const r = await mk(citizen);
  // another citizen cannot read, edit, rate, reopen, or fetch images of this report
  assert.equal((await citizen2.get(`/api/reports/${r.id}`)).status, 404);
  assert.equal((await citizen2.patch(`/api/reports/${r.id}`, { title: 'hijacked title' })).status, 404);
  assert.equal((await citizen2.post(`/api/reports/${r.id}/status`, { to: 'REOPENED', note: 'x' })).status, 404);
  const imgId = t.db.prepare('SELECT id FROM report_images WHERE report_id=?').get(r.id).id;
  assert.equal((await citizen2.get(`/api/images/${imgId}`)).status, 404);
  assert.equal((await citizen.get(`/api/images/${imgId}`)).status, 200);
  assert.equal((await citizen2.get('/api/reports')).data.items.length, 0);
  // citizens cannot touch staff/admin endpoints
  assert.equal((await citizen.post(`/api/reports/${r.id}/status`, { to: 'ACCEPTED' })).status, 403);
  assert.equal((await citizen.post(`/api/reports/${r.id}/assign`, { assignee_id: ids('officer2@t.test') })).status, 403);
  assert.equal((await citizen.post(`/api/reports/${r.id}/remarks`, { body: 'hi' })).status, 403);
  assert.equal((await citizen.patch(`/api/reports/${r.id}/priority`, { priority: 'LOW' })).status, 403);
  assert.equal((await citizen.get('/api/admin/users')).status, 403);
  assert.equal((await citizen.get('/api/dashboard')).status, 403);
  // an officer in another department can neither see nor act on it
  assert.equal((await otherOfficer.get(`/api/reports/${r.id}`)).status, 404);
  assert.equal((await otherOfficer.post(`/api/reports/${r.id}/status`, { to: 'ACCEPTED' })).status, 404);
  assert.equal((await otherOfficer.get(`/api/images/${imgId}`)).status, 404);
  assert.equal((await officer.get('/api/admin/analytics')).status, 403);
  assert.equal((await officer.patch('/api/admin/users/1', { role: 'admin' })).status, 403);
  // citizens cannot create reports as staff or mass-assign fields
  const sneaky = t.reportForm();
  sneaky.append('status', 'RESOLVED'); sneaky.append('priority', 'CRITICAL'); sneaky.append('user_id', '999');
  const s = await citizen.post('/api/reports', sneaky);
  const d = (await citizen.get(`/api/reports/${s.data.id}`)).data;
  assert.equal(d.status, 'SUBMITTED');
  assert.equal(d.priority, 'MEDIUM');
});

test('Journey B: review, assign, progress, resolve with evidence; citizen sees public updates only', async () => {
  const r = await mk();
  const post = (c, p, b) => c.post(`/api/reports/${r.id}/${p}`, b);
  // officer sees the report through the department scope
  assert.equal((await officer.get(`/api/reports/${r.id}`)).status, 200);
  assert.equal((await post(officer, 'status', { to: 'UNDER_REVIEW' })).status, 200);
  assert.equal((await post(officer, 'status', { to: 'ACCEPTED' })).status, 200);
  // plain officer cannot assign someone else; lead can
  const off2 = ids('officer2@t.test');
  assert.equal((await post(officer, 'assign', { assignee_id: ids('officer1@t.test') })).status, 403);
  // assignee must be in the same department
  assert.equal((await post(lead, 'assign', { assignee_id: ids('officer3@t.test') })).status, 400);
  const a = await post(lead, 'assign', { assignee_id: off2, note: 'Please inspect' });
  assert.equal(a.status, 200);
  assert.equal(a.data.status, 'ASSIGNED');
  assert.equal(a.data.assignee, 'officer 2');
  assert.equal((await post(lead, 'assign', { assignee_id: off2 })).status, 400); // same assignee
  // work: only valid transitions, remarks and resolution evidence
  assert.equal((await post(officer, 'status', { to: 'RESOLVED', note: 'done' })).status, 409); // skips IN_PROGRESS
  assert.equal((await post(officer, 'status', { to: 'IN_PROGRESS' })).status, 200);
  assert.equal((await post(officer, 'remarks', { body: 'Contractor is on the way', visibility: 'public' })).status, 201);
  assert.equal((await post(officer, 'remarks', { body: 'budget code 42-B', visibility: 'internal' })).status, 201);
  assert.equal((await post(officer, 'status', { to: 'RESOLVED' })).status, 400); // resolution note required
  const form = new FormData();
  form.append('images', new Blob([PNG], { type: 'image/png' }), 'fixed.png');
  assert.equal((await officer.post(`/api/reports/${r.id}/images`, form)).status, 201);
  const done = await post(officer, 'status', { to: 'RESOLVED', note: 'Filled and compacted' });
  assert.equal(done.status, 200);
  assert.equal(done.data.resolution_note, 'Filled and compacted');
  assert.ok(done.data.resolved_at > 0);
  // citizen view: public events only, resolution photo visible, no internal data
  const cv = (await citizen.get(`/api/reports/${r.id}`)).data;
  assert.equal(cv.status, 'RESOLVED');
  assert.ok(cv.events.some((e) => e.note === 'Contractor is on the way'));
  assert.ok(!JSON.stringify(cv).includes('budget code'));
  assert.ok(!JSON.stringify(cv).includes('Please inspect'));
  assert.ok(!JSON.stringify(cv).includes('officer 2'));
  assert.equal(cv.images.filter((i) => i.kind === 'resolution').length, 1);
  assert.equal(cv.actions.feedback, true);
  // staff view has full history incl. status history with actor and assignment history
  const sv = (await officer.get(`/api/reports/${r.id}`)).data;
  assert.ok(sv.events.some((e) => e.type === 'assign' && e.to_value === 'officer 2'));
  const statuses = sv.events.filter((e) => e.type === 'status').map((e) => `${e.from_value}>${e.to_value}`);
  assert.deepEqual(statuses, ['null>SUBMITTED', 'SUBMITTED>UNDER_REVIEW', 'UNDER_REVIEW>ACCEPTED', 'ACCEPTED>ASSIGNED', 'ASSIGNED>IN_PROGRESS', 'IN_PROGRESS>RESOLVED']);
  assert.ok(sv.events.every((e) => e.type !== 'status' || e.actor));
  // feedback: once, owner only
  assert.equal((await citizen2.post(`/api/reports/${r.id}/feedback`, { rating: 5 })).status, 404);
  assert.equal((await citizen.post(`/api/reports/${r.id}/feedback`, { rating: 9 })).status, 400);
  assert.equal((await citizen.post(`/api/reports/${r.id}/feedback`, { rating: 4, comment: 'Thanks' })).status, 201);
  assert.equal((await citizen.post(`/api/reports/${r.id}/feedback`, { rating: 4 })).status, 409);
  // citizen was notified along the way
  const n = (await citizen.get('/api/notifications')).data.items;
  assert.ok(n.some((x) => /resolved/.test(x.message)));
  // reopen by citizen, then it returns to work
  assert.equal((await citizen.post(`/api/reports/${r.id}/status`, { to: 'REOPENED' })).status, 400); // reason required
  const re = await citizen.post(`/api/reports/${r.id}/status`, { to: 'REOPENED', note: 'Hole is back' });
  assert.equal(re.status, 200);
  assert.equal(re.data.resolved_at, null);
  assert.equal((await post(officer, 'status', { to: 'IN_PROGRESS' })).status, 200);
});

test('invalid transitions, required reject reason, stale updates, terminal states', async () => {
  const r = await mk();
  const st = (c, to, note, extra = {}) => c.post(`/api/reports/${r.id}/status`, { to, note, ...extra });
  assert.equal((await st(officer, 'RESOLVED', 'x')).status, 409);
  assert.equal((await st(officer, 'ASSIGNED')).status, 409); // only via assign endpoint
  assert.equal((await st(officer, 'IN_PROGRESS')).status, 409);
  assert.equal((await st(officer, 'NOPE')).status, 400);
  assert.equal((await st(officer, 'REJECTED')).status, 400); // reason required
  assert.equal((await st(officer, 'ACCEPTED', '', { expected_status: 'UNDER_REVIEW' })).status, 409); // stale client
  assert.equal((await st(officer, 'REJECTED', 'Not a public asset')).status, 200);
  assert.equal((await st(admin, 'ACCEPTED')).status, 409); // rejected is terminal, even for admin
  const cv = (await citizen.get(`/api/reports/${r.id}`)).data;
  assert.ok(cv.events.some((e) => e.note === 'Not a public asset')); // reason reaches the citizen
  assert.equal((await officer.post(`/api/reports/${r.id}/assign`, { assignee_id: ids('officer2@t.test') })).status, 409);
});

test('officer self-claim of unassigned work, and non-assignee cannot act on assigned work', async () => {
  const r = await mk();
  const url = (p) => `/api/reports/${r.id}/${p}`;
  await lead.post(url('status'), { to: 'ACCEPTED' });
  assert.equal((await officer.post(url('assign'), { assignee_id: ids('officer1@t.test') })).status, 403); // not for others
  assert.equal((await officer.post(url('assign'), { assignee_id: ids('officer2@t.test') })).status, 200); // claim own
  await t.mkUser('officer', 4, { department_id: deptId });
  const peer = await t.loginAs('officer', 4);
  assert.equal((await peer.post(url('status'), { to: 'IN_PROGRESS' })).status, 403); // assigned to someone else
  assert.equal((await peer.post(url('remarks'), { body: 'meddling' })).status, 403);
  assert.equal((await lead.post(url('status'), { to: 'IN_PROGRESS' })).status, 200); // lead may act
});

test('priority: authorised only, validated, recorded', async () => {
  const r = await mk();
  assert.equal((await officer.patch(`/api/reports/${r.id}/priority`, { priority: 'HIGH' })).status, 200);
  assert.equal((await officer.patch(`/api/reports/${r.id}/priority`, { priority: 'URGENT' })).status, 400);
  assert.equal((await otherOfficer.patch(`/api/reports/${r.id}/priority`, { priority: 'LOW' })).status, 404);
  const d = (await officer.get(`/api/reports/${r.id}`)).data;
  assert.equal(d.priority, 'HIGH');
  assert.ok(d.events.some((e) => e.type === 'priority' && e.to_value === 'HIGH'));
});

test('citizen can edit only before review', async () => {
  const r = await mk();
  assert.equal((await citizen.patch(`/api/reports/${r.id}`, { title: 'Updated title here' })).status, 200);
  await officer.post(`/api/reports/${r.id}/status`, { to: 'UNDER_REVIEW' });
  assert.equal((await citizen.patch(`/api/reports/${r.id}`, { title: 'Too late to edit' })).status, 409);
});

test('list: filters, search (with LIKE escaping), sorting, pagination, scoping', async () => {
  const fresh = await boot();
  try {
    const c = await fresh.loginAs('citizen', 1);
    for (let i = 0; i < 5; i++) await c.post('/api/reports', fresh.reportForm({ title: `Report number ${i}`, category_id: String(1 + (i % 2)) }));
    await c.post('/api/reports', fresh.reportForm({ title: '100% sure leak', category_id: '3' }));
    const a = await fresh.loginAs('admin', 1);
    assert.equal((await a.get('/api/reports?limit=2&page=2')).data.items.length, 2);
    assert.equal((await a.get('/api/reports?limit=2')).data.total, 6);
    assert.equal((await a.get('/api/reports?category_id=3')).data.total, 1);
    assert.equal((await a.get('/api/reports?q=100%25')).data.total, 1);
    assert.equal((await a.get('/api/reports?q=%25')).data.total, 1); // literal %, not a wildcard
    assert.equal((await a.get('/api/reports?status=SUBMITTED&sort=priority&order=asc')).status, 200);
    assert.equal((await a.get('/api/reports?status=BOGUS')).status, 400);
    assert.equal((await a.get("/api/reports?sort=id;DROP TABLE reports")).status, 200); // unknown sort ignored
    assert.equal((await a.get('/api/reports?limit=9999')).data.limit, 50);
    assert.equal((await a.get('/api/reports/markers')).data.items.length, 6);
    assert.equal(fresh.db.prepare('SELECT COUNT(*) n FROM reports').get().n, 6);
  } finally { fresh.close(); }
});

test('overdue detection uses category SLA', async () => {
  const r = await mk();
  assert.equal((await admin.get('/api/reports?overdue=1')).data.items.some((x) => x.id === r.id), false);
  t.db.prepare('UPDATE reports SET due_at = ? WHERE id = ?').run(Date.now() - 1000, r.id);
  const o = (await admin.get('/api/reports?overdue=1')).data.items;
  assert.ok(o.some((x) => x.id === r.id && x.overdue === true));
  t.db.prepare("UPDATE reports SET status='REJECTED' WHERE id = ?").run(r.id);
  assert.equal((await admin.get('/api/reports?overdue=1')).data.items.some((x) => x.id === r.id), false);
});

test('a failing notification never undoes the report update', async () => {
  const r = await mk();
  t.db.exec('ALTER TABLE notifications RENAME TO notifications_x');
  try {
    assert.equal((await officer.post(`/api/reports/${r.id}/status`, { to: 'ACCEPTED' })).status, 200);
  } finally { t.db.exec('ALTER TABLE notifications_x RENAME TO notifications'); }
  assert.equal(t.db.prepare('SELECT status FROM reports WHERE id=?').get(r.id).status, 'ACCEPTED');
});
