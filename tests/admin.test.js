const { test, after, before } = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { boot } = require('./helpers');
const { migrate } = require('../src/db');
const { hash } = require('../src/util');

let t, admin, citizen, deptId;
before(async () => {
  t = await boot();
  admin = await t.loginAs('admin', 1);
  citizen = await t.loginAs('citizen', 1);
});
after(() => t.close());

test('analytics on an empty database return zeros/nulls, not misleading numbers', async () => {
  const a = (await admin.get('/api/admin/analytics')).data;
  assert.equal(a.total, 0);
  assert.equal(a.avg_resolution_hours, null);
  assert.equal(a.resolution_rate, null);
  assert.deepEqual(a.by_area, []);
});

test('Journey C: departments, categories, officers, assignments, analytics, audit, export', async () => {
  // departments
  const d = await admin.post('/api/admin/departments', { name: 'Roads' });
  assert.equal(d.status, 201);
  deptId = d.data.id;
  assert.equal((await admin.post('/api/admin/departments', { name: 'Roads' })).status, 409);
  // categories
  const cat = await admin.post('/api/admin/categories', { name: 'Bridge damage', department_id: deptId, sla_hours: 24 });
  assert.equal(cat.status, 201);
  assert.equal((await admin.post('/api/admin/categories', { name: 'Bad sla', sla_hours: 0 })).status, 400);
  assert.equal((await admin.patch('/api/admin/categories/1', { department_id: deptId })).status, 200);
  assert.ok((await citizen.get('/api/meta')).data.categories.some((c) => c.name === 'Bridge damage'));
  // create officers (admin-set password; no public admin credentials exist)
  const o = await admin.post('/api/admin/users', { name: 'Olive Officer', email: 'olive@city.test', password: 'temp-password-1', role: 'officer', department_id: deptId, can_assign: true });
  assert.equal(o.status, 201);
  const o2 = await admin.post('/api/admin/users', { name: 'Pat Officer', email: 'pat@city.test', password: 'temp-password-1', role: 'officer', department_id: deptId });
  assert.equal((await admin.post('/api/admin/users', { name: 'X', email: 'bad@x.test', password: 'temp-password-1', role: 'superuser' })).status, 400);
  // a citizen files two reports; admin sees all and manages them
  const rep = await citizen.post('/api/reports', t.reportForm({ category_id: '1' }));
  await citizen.post('/api/reports', t.reportForm({ category_id: '1', title: 'Another pothole', lat: '12.9701', lng: '77.5901' }));
  const list = (await admin.get('/api/reports')).data;
  assert.equal(list.total, 2);
  const id = rep.data.id;
  assert.equal((await admin.post(`/api/reports/${id}/status`, { to: 'ACCEPTED' })).status, 200);
  const asg = await admin.post(`/api/reports/${id}/assign`, { assignee_id: o2.data.user.id });
  assert.equal(asg.status, 200);
  assert.equal(asg.data.assignee, 'Pat Officer');
  // reassign to the other officer
  assert.equal((await admin.post(`/api/reports/${id}/assign`, { assignee_id: o.data.user.id })).data.assignee, 'Olive Officer');
  const hist = (await admin.get(`/api/reports/${id}`)).data.events.filter((e) => e.type === 'assign');
  assert.deepEqual(hist.map((e) => [e.from_value, e.to_value]), [[null, 'Pat Officer'], ['Pat Officer', 'Olive Officer']]);
  // overdue monitoring
  t.db.prepare('UPDATE reports SET due_at = ? WHERE id = ?').run(Date.now() - 5000, id);
  // analytics reflect persisted data
  const a = (await admin.get('/api/admin/analytics')).data;
  assert.equal(a.total, 2);
  assert.equal(a.open, 2);
  assert.equal(a.overdue, 1);
  assert.equal(a.awaiting_review, 1);
  assert.equal(a.in_progress, 1);
  assert.equal(a.by_category[0].n, 2);
  assert.equal(a.repeated_locations[0].n, 2); // same category, same ~110 m cell
  assert.equal(a.workload.find((w) => w.name === 'Olive Officer').open, 1);
  assert.equal(a.workload.find((w) => w.name === 'Olive Officer').overdue, 1);
  // resolve -> average resolution time and rate
  const officer = t.client();
  await officer.login('olive@city.test', 'temp-password-1');
  await officer.post(`/api/reports/${id}/status`, { to: 'IN_PROGRESS' });
  await officer.post(`/api/reports/${id}/status`, { to: 'RESOLVED', note: 'Fixed' });
  t.db.prepare('UPDATE reports SET created_at = ?, resolved_at = ? WHERE id = ?').run(1_000_000, 1_000_000 + 5 * 3600e3, id);
  const b = (await admin.get('/api/admin/analytics')).data;
  assert.equal(b.resolved, 1);
  assert.equal(b.avg_resolution_hours, 5);
  assert.equal(b.resolution_rate, 0.5);
  // officer dashboard is scoped
  const dash = (await officer.get('/api/dashboard')).data;
  assert.equal(dash.total, 2);
  assert.equal(dash.assigned_to_me, 0); // the only assigned report is resolved
  assert.ok(Array.isArray(dash.workload));
  // audit log records privileged actions
  const au = (await admin.get('/api/admin/audit')).data;
  const actions = au.items.map((x) => x.action);
  for (const want of ['department.create', 'category.create', 'user.create', 'report.assign', 'report.status'])
    assert.ok(actions.includes(want), want);
  // export neutralises spreadsheet formulas
  t.db.prepare("UPDATE reports SET title = '=HYPERLINK(\"http://evil\")' WHERE id = ?").run(id);
  const csv = await admin.get('/api/admin/export.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.ok(csv.data.includes("'=HYPERLINK"));
  assert.ok(!/^=/m.test(csv.data));
  assert.ok((await admin.get('/api/admin/audit')).data.items.some((x) => x.action === 'report.export'));
  assert.equal((await officer.get('/api/admin/export.csv')).status, 403);
});

test('user management: roles, deactivation ends sessions, self-lockout prevented', async () => {
  const u = await admin.post('/api/admin/users', { name: 'Temp Worker', email: 'temp@city.test', password: 'temp-password-1', role: 'officer' });
  const c = t.client();
  await c.login('temp@city.test', 'temp-password-1');
  assert.equal((await c.get('/api/auth/me')).status, 200);
  assert.equal((await admin.patch(`/api/admin/users/${u.data.user.id}`, { active: false })).status, 200);
  assert.equal((await c.get('/api/auth/me')).status, 401); // session killed immediately
  assert.equal((await c.login('temp@city.test', 'temp-password-1')).status, 401);
  const me = (await admin.get('/api/auth/me')).data.user.id;
  assert.equal((await admin.patch(`/api/admin/users/${me}`, { role: 'citizen' })).status, 409);
  assert.equal((await admin.patch(`/api/admin/users/${me}`, { active: false })).status, 409);
  // privilege escalation via profile endpoint is impossible
  await citizen.patch('/api/auth/me', { role: 'admin', name: 'Still Citizen' });
  assert.equal((await citizen.get('/api/auth/me')).data.user.role, 'citizen');
  // deactivating an officer releases their open reports
  const off = (await admin.get('/api/admin/users?role=officer&q=olive')).data.items[0];
  const rep = await citizen.post('/api/reports', t.reportForm({ category_id: '1', title: 'Light is out' }));
  await admin.post(`/api/reports/${rep.data.id}/status`, { to: 'ACCEPTED' });
  await admin.post(`/api/reports/${rep.data.id}/assign`, { assignee_id: off.id });
  await admin.patch(`/api/admin/users/${off.id}`, { active: false });
  const row = t.db.prepare('SELECT status, assigned_to_id FROM reports WHERE id=?').get(rep.data.id);
  assert.deepEqual({ ...row }, { status: 'ACCEPTED', assigned_to_id: null });
});

test('an un-routed report is routed into the assignee department by an admin', async () => {
  const fresh = await boot();
  try {
    const a = await fresh.loginAs('admin', 1), c = await fresh.loginAs('citizen', 1);
    const dep = Number(fresh.db.prepare("INSERT INTO departments(name) VALUES('Lights')").run().lastInsertRowid);
    const off = fresh.mkUser('officer', 1, { department_id: dep });
    const o = await fresh.loginAs('officer', 1);
    const r = await c.post('/api/reports', fresh.reportForm({ category_id: '2' })); // category has no department
    assert.equal((await o.get(`/api/reports/${r.data.id}`)).status, 404); // invisible to officers
    await a.post(`/api/reports/${r.data.id}/status`, { to: 'ACCEPTED' });
    assert.equal((await a.post(`/api/reports/${r.data.id}/assign`, { assignee_id: off.id })).status, 200);
    assert.equal((await o.get(`/api/reports/${r.data.id}`)).status, 200);
  } finally { fresh.close(); }
});

test('departments and categories: delete rules', async () => {
  assert.equal((await admin.del(`/api/admin/departments/${deptId}`)).status, 409); // in use
  const d = await admin.post('/api/admin/departments', { name: 'Unused' });
  assert.equal((await admin.del(`/api/admin/departments/${d.data.id}`)).status, 200);
  assert.equal((await admin.del('/api/admin/departments/99999')).status, 404);
  assert.equal((await admin.patch('/api/admin/categories/1', { active: false })).status, 200);
  assert.equal((await citizen.post('/api/reports', t.reportForm({ category_id: '1' }))).status, 400); // inactive category
});

test('legacy database is migrated without losing data', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, email TEXT UNIQUE, hash TEXT, role TEXT DEFAULT 'citizen');
    CREATE TABLE issues(id INTEGER PRIMARY KEY, user_id INTEGER, category TEXT, description TEXT, lat REAL, lng REAL, address TEXT,
      image TEXT, status TEXT DEFAULT 'Reported', assigned_to TEXT, rating INTEGER, created_at INTEGER, resolved_at INTEGER);`);
  const u = db.prepare('INSERT INTO users(name,email,hash,role) VALUES(?,?,?,?)');
  u.run('City Authority', 'admin@city.gov', hash('admin123'), 'authority'); // the old seeded login
  u.run('Real Authority', 'real@city.gov', hash('a-strong-pass-1'), 'authority');
  u.run('Cit', 'cit@x.com', hash('secret-pass'), 'citizen');
  const i = db.prepare('INSERT INTO issues(user_id,category,description,lat,lng,address,image,status,assigned_to,rating,created_at,resolved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  i.run(3, 'Pothole', 'Huge pothole on 5th', 12.9, 77.5, '5th Ave', 'abc.png', 'Resolved', 'Bob', 4, 1_700_000_000_000, 1_700_003_600_000);
  i.run(3, 'Water Leak', 'Pipe burst', 12.8, 77.4, '', 'def.jpg', 'In Progress', null, null, 1_700_000_100_000, null);
  i.run(3, 'Alien Category', 'Odd', 1, 1, '', null, 'Reported', null, null, 1_700_000_200_000, null);

  migrate(db);
  migrate(db); // idempotent
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reports').get().n, 3);
  const r = db.prepare('SELECT r.*, c.name AS cat FROM reports r JOIN categories c ON c.id = r.category_id WHERE r.id = 1').get();
  assert.equal(r.cat, 'Road Damage / Pothole');
  assert.equal(r.status, 'RESOLVED');
  assert.equal(r.resolved_at, 1_700_003_600_000);
  assert.match(r.tracking_no, /^IDR-2023-L00001$/);
  assert.equal(db.prepare('SELECT status FROM reports WHERE id=2').get().status, 'IN_PROGRESS');
  assert.equal(db.prepare('SELECT cat.name n FROM reports r JOIN categories cat ON cat.id=r.category_id WHERE r.id=3').get().n, 'Other');
  assert.equal(db.prepare('SELECT rating FROM feedback WHERE report_id=1').get().rating, 4);
  assert.equal(db.prepare('SELECT mime FROM report_images WHERE report_id=1').get().mime, 'image/png');
  assert.equal(db.prepare('SELECT mime FROM report_images WHERE report_id=2').get().mime, 'image/jpeg');
  assert.ok(db.prepare("SELECT 1 FROM report_events WHERE report_id=1 AND note LIKE '%Bob%'").get());
  // default-credential admin is disabled; other authority becomes admin; citizens untouched
  assert.equal(db.prepare("SELECT active, role FROM users WHERE email='admin@city.gov'").get().active, 0);
  assert.equal(db.prepare("SELECT role, active FROM users WHERE email='real@city.gov'").get().role, 'admin');
  assert.equal(db.prepare("SELECT role FROM users WHERE email='cit@x.com'").get().role, 'citizen');
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='issues'").get(), undefined);
});
