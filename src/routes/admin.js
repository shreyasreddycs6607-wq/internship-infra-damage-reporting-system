const { ApiError, hash, str, parseId, csvCell } = require('../util');
const { createUser, publicUser, checkPassword, ROLES } = require('../users');
const { adminAnalytics } = require('../analytics');
const { STATUSES } = require('../workflow');

const bool = (v) => (v ? 1 : 0);
const optId = (v, name) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new ApiError(400, `Invalid ${name}`);
  return n;
};
const dupe = (e, msg) => { if (/UNIQUE/.test(e.message)) throw new ApiError(409, msg); throw e; };
const likeOf = (s) => '%' + String(s).slice(0, 100).replace(/[\\%_]/g, '\\$&') + '%';

module.exports = (app, { db, tx, authn, need, audit }) => {
  const admin = [authn, need('admin')];
  const dept = (id) => {
    if (id != null && !db.prepare('SELECT 1 FROM departments WHERE id=?').get(id)) throw new ApiError(400, 'Unknown department');
    return id;
  };
  const paging = (q, def) => ({
    limit: Math.min(Math.max(parseInt(q.limit) || def, 1), 100), page: Math.max(parseInt(q.page) || 1, 1),
  });

  // ---- users ----
  app.get('/api/admin/users', ...admin, (req, res) => {
    const { limit, page } = paging(req.query, 25);
    const where = [], p = [];
    if (ROLES.includes(req.query.role)) { where.push('u.role = ?'); p.push(req.query.role); }
    if (req.query.q) { const l = likeOf(req.query.q); where.push("(u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')"); p.push(l, l); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    res.json({
      page, limit, total: db.prepare(`SELECT COUNT(*) n FROM users u ${w}`).get(...p).n,
      items: db.prepare(`SELECT u.id,u.name,u.email,u.role,u.active,u.can_assign,u.department_id,u.created_at, d.name AS department
        FROM users u LEFT JOIN departments d ON d.id=u.department_id ${w} ORDER BY u.id LIMIT ? OFFSET ?`).all(...p, limit, (page - 1) * limit)
        .map((u) => ({ ...u, active: !!u.active, can_assign: !!u.can_assign })),
    });
  });

  app.post('/api/admin/users', ...admin, (req, res) => {
    const b = req.body || {};
    const u = createUser(db, { ...b, department_id: dept(optId(b.department_id, 'department')), email_verified: 1 }); // an admin vouches for the address
    audit(req.user, 'user.create', 'user', u.id, { role: u.role });
    res.status(201).json({ user: publicUser(u) });
  });

  app.patch('/api/admin/users/:id', ...admin, (req, res) => {
    const id = parseId(req.params.id), b = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!u) throw new ApiError(404, 'User not found');
    const next = {
      name: b.name === undefined ? u.name : str(b.name, 'Name', 2, 100),
      role: b.role === undefined ? u.role : b.role,
      active: b.active === undefined ? u.active : bool(b.active),
      can_assign: b.can_assign === undefined ? u.can_assign : bool(b.can_assign),
      department_id: b.department_id === undefined ? u.department_id : dept(optId(b.department_id, 'department')),
    };
    if (!ROLES.includes(next.role)) throw new ApiError(400, 'Invalid role');
    if (id === req.user.id && (next.role !== 'admin' || !next.active)) throw new ApiError(409, 'You cannot demote or deactivate your own account');
    const newHash = b.password === undefined ? null : hash(checkPassword(b.password));
    tx(() => {
      db.prepare('UPDATE users SET name=?, role=?, active=?, can_assign=?, department_id=? WHERE id=?')
        .run(next.name, next.role, next.active, next.can_assign, next.department_id, id);
      if (newHash) db.prepare('UPDATE users SET hash=? WHERE id=?').run(newHash, id);
      // Role, status or password changes end the user's sessions immediately.
      if (next.role !== u.role || !next.active || newHash) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
      // An officer who is deactivated or loses the role must not keep reports assigned to them.
      if (u.role === 'officer' && (next.role !== 'officer' || !next.active))
        db.prepare(`UPDATE reports SET assigned_to_id=NULL,
          status=CASE WHEN status IN ('ASSIGNED','IN_PROGRESS','REOPENED') THEN 'ACCEPTED' ELSE status END WHERE assigned_to_id=?`).run(id);
    });
    audit(req.user, 'user.update', 'user', id, {
      role: next.role, active: !!next.active, department_id: next.department_id, can_assign: !!next.can_assign, password_reset: !!newHash });
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)) });
  });

  // ---- departments ----
  app.get('/api/admin/departments', ...admin, (_req, res) => res.json({
    items: db.prepare(`SELECT d.id, d.name, (SELECT COUNT(*) FROM users u WHERE u.department_id=d.id) AS users,
      (SELECT COUNT(*) FROM categories c WHERE c.department_id=d.id) AS categories FROM departments d ORDER BY d.name`).all() }));
  app.post('/api/admin/departments', ...admin, (req, res) => {
    try {
      const id = Number(db.prepare('INSERT INTO departments(name) VALUES(?)').run(str(req.body?.name, 'Name', 2, 100)).lastInsertRowid);
      audit(req.user, 'department.create', 'department', id);
      res.status(201).json({ id });
    } catch (e) { dupe(e, 'Department already exists'); }
  });
  app.patch('/api/admin/departments/:id', ...admin, (req, res) => {
    const id = parseId(req.params.id);
    let changes;
    try { changes = db.prepare('UPDATE departments SET name=? WHERE id=?').run(str(req.body?.name, 'Name', 2, 100), id).changes; }
    catch (e) { dupe(e, 'Department already exists'); }
    if (!changes) throw new ApiError(404, 'Not found');
    audit(req.user, 'department.update', 'department', id);
    res.json({ ok: true });
  });
  app.delete('/api/admin/departments/:id', ...admin, (req, res) => {
    const id = parseId(req.params.id);
    const used = db.prepare(`SELECT (SELECT COUNT(*) FROM users WHERE department_id=?) + (SELECT COUNT(*) FROM categories WHERE department_id=?)
      + (SELECT COUNT(*) FROM reports WHERE department_id=?) AS n`).get(id, id, id).n;
    if (used) throw new ApiError(409, 'Department is in use by users, categories or reports');
    if (!db.prepare('DELETE FROM departments WHERE id=?').run(id).changes) throw new ApiError(404, 'Not found');
    audit(req.user, 'department.delete', 'department', id);
    res.json({ ok: true });
  });

  // ---- categories (deactivate rather than delete: reports reference them) ----
  app.get('/api/admin/categories', ...admin, (_req, res) => res.json({
    items: db.prepare(`SELECT c.id, c.name, c.department_id, d.name AS department, c.sla_hours, c.active
      FROM categories c LEFT JOIN departments d ON d.id=c.department_id ORDER BY c.name`).all().map((c) => ({ ...c, active: !!c.active })) }));
  const sla = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 8760) throw new ApiError(400, 'SLA hours must be 1-8760');
    return n;
  };
  app.post('/api/admin/categories', ...admin, (req, res) => {
    const b = req.body || {};
    try {
      const id = Number(db.prepare('INSERT INTO categories(name,department_id,sla_hours) VALUES(?,?,?)')
        .run(str(b.name, 'Name', 2, 100), dept(optId(b.department_id, 'department')), sla(b.sla_hours ?? 72)).lastInsertRowid);
      audit(req.user, 'category.create', 'category', id);
      res.status(201).json({ id });
    } catch (e) { dupe(e, 'Category already exists'); }
  });
  app.patch('/api/admin/categories/:id', ...admin, (req, res) => {
    const id = parseId(req.params.id), b = req.body || {};
    const c = db.prepare('SELECT * FROM categories WHERE id=?').get(id);
    if (!c) throw new ApiError(404, 'Not found');
    try {
      db.prepare('UPDATE categories SET name=?, department_id=?, sla_hours=?, active=? WHERE id=?').run(
        b.name === undefined ? c.name : str(b.name, 'Name', 2, 100),
        b.department_id === undefined ? c.department_id : dept(optId(b.department_id, 'department')),
        b.sla_hours === undefined ? c.sla_hours : sla(b.sla_hours),
        b.active === undefined ? c.active : bool(b.active), id);
    } catch (e) { dupe(e, 'Category already exists'); }
    audit(req.user, 'category.update', 'category', id);
    res.json({ ok: true });
  });

  // ---- oversight ----
  app.get('/api/admin/analytics', ...admin, (_req, res) => res.json(adminAnalytics(db, Date.now())));

  app.get('/api/admin/audit', ...admin, (req, res) => {
    const { limit, page } = paging(req.query, 50);
    res.json({
      page, limit, total: db.prepare('SELECT COUNT(*) n FROM audit_log').get().n,
      items: db.prepare(`SELECT a.id, a.action, a.entity, a.entity_id, a.detail, a.created_at, u.name AS actor
        FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(limit, (page - 1) * limit),
    });
  });

  const DATES = ['created_at', 'updated_at', 'due_at', 'resolved_at'];
  const HEAD = ['tracking_no', 'title', 'category', 'department', 'status', 'priority', 'address', 'lat', 'lng',
    'location_source', 'reporter', 'assignee', ...DATES];
  app.get('/api/admin/export.csv', ...admin, (req, res) => {
    const where = [], p = [];
    if (STATUSES.includes(req.query.status)) { where.push('r.status = ?'); p.push(req.query.status); }
    if (req.query.from && Number.isFinite(Number(req.query.from))) { where.push('r.created_at >= ?'); p.push(Number(req.query.from)); }
    if (req.query.to && Number.isFinite(Number(req.query.to))) { where.push('r.created_at <= ?'); p.push(Number(req.query.to)); }
    const rows = db.prepare(`SELECT r.tracking_no, r.title, c.name AS category, d.name AS department, r.status, r.priority, r.address,
        r.lat, r.lng, r.location_source, u.name AS reporter, a.name AS assignee, r.created_at, r.updated_at, r.due_at, r.resolved_at
      FROM reports r JOIN categories c ON c.id=r.category_id JOIN users u ON u.id=r.user_id
      LEFT JOIN departments d ON d.id=r.department_id LEFT JOIN users a ON a.id=r.assigned_to_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.id LIMIT 50000`).all(...p);
    const cell = (r, h) => csvCell(DATES.includes(h) ? (r[h] ? new Date(r[h]).toISOString() : '') : r[h]);
    const lines = [HEAD.join(','), ...rows.map((r) => HEAD.map((h) => cell(r, h)).join(','))];
    audit(req.user, 'report.export', 'report', null, { rows: rows.length, status: req.query.status || null });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="reports.csv"' }).send(lines.join('\r\n'));
  });
};
