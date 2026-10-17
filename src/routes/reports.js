const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const { ApiError, str, parseId, sniffImage } = require('../util');
const W = require('../workflow');
const { summary } = require('../analytics');

const OVERDUE = `(r.due_at < @now AND r.status NOT IN ('RESOLVED','CLOSED','REJECTED'))`;
const COLS = `r.id, r.tracking_no, r.title, r.status, r.priority, r.lat, r.lng, r.address, r.category_id, r.department_id,
  r.assigned_to_id, r.created_at, r.updated_at, r.due_at, r.resolved_at, c.name AS category, d.name AS department,
  a.name AS assignee, ${OVERDUE} AS overdue`;
const FROM = `FROM reports r JOIN categories c ON c.id = r.category_id
  LEFT JOIN departments d ON d.id = r.department_id LEFT JOIN users a ON a.id = r.assigned_to_id`;
const SORTS = {
  created_at: 'r.created_at', updated_at: 'r.updated_at', due_at: 'r.due_at', status: 'r.status', tracking_no: 'r.tracking_no',
  priority: `CASE r.priority WHEN 'CRITICAL' THEN 4 WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 ELSE 1 END`,
};
const nz = (v) => v !== undefined && v !== null && String(v).trim() !== '';

module.exports = (app, { db, tx, authn, need, needVerified, audit, notify, limits, uploadDir, maxUploadBytes, images }) => {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxUploadBytes, files: 3, fields: 20, fieldSize: 20000, parts: 30 },
  });

  const noEntrepreneur = need('citizen', 'officer', 'admin');

  // ---- helpers ----
  const now = () => Date.now();
  const load = (id) => db.prepare(`SELECT r.*, c.name AS category, d.name AS department, a.name AS assignee ${FROM} WHERE r.id = ?`).get(id);
  // Unauthorised and non-existent look identical (404) so report ids can't be probed.
  const loadFor = (user, id) => {
    const r = load(parseId(id));
    if (!r || !W.canView(user, r)) throw new ApiError(404, 'Report not found');
    return r;
  };
  const addEvent = (reportId, type, user, { from = null, to = null, note = null, visibility = 'internal' } = {}) =>
    db.prepare(`INSERT INTO report_events(report_id,type,from_value,to_value,note,visibility,user_id,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(reportId, type, from, to, note, visibility, user?.id ?? null, now());
  const touch = (id) => db.prepare('UPDATE reports SET updated_at=? WHERE id=?').run(now(), id);

  const { prepare: prepareImages, write: writeImages, unlinkAll } = images;
  const trackingNo = () => {
    for (;;) {
      const n = `IDR-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      if (!db.prepare('SELECT 1 FROM reports WHERE tracking_no=?').get(n)) return n;
    }
  };

  const present = (user, r) => {
    const staff = user.role !== 'citizen';
    const events = db.prepare(`SELECT e.id, e.type, e.from_value, e.to_value, e.note, e.visibility, e.created_at,
        u.name AS actor, u.role AS actor_role FROM report_events e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.report_id = ? ${staff ? '' : "AND e.visibility = 'public'"} ORDER BY e.id`).all(r.id)
      .map((e) => staff ? e : { ...e, actor: e.actor_role === 'citizen' ? 'You' : 'Municipal staff', actor_role: undefined });
    const feedback = db.prepare('SELECT rating, comment, created_at FROM feedback WHERE report_id=?').get(r.id) || null;
    const actions = { transitions: [], assign: false, priority: false, remark: false, resolution_image: false, feedback: false, edit: false, reopen: false };
    if (user.role === 'citizen') {
      actions.reopen = r.status === 'RESOLVED';
      actions.feedback = ['RESOLVED', 'CLOSED'].includes(r.status) && !feedback;
      actions.edit = r.status === 'SUBMITTED';
    } else if (W.canManage(user, r)) {
      actions.transitions = (W.TRANSITIONS[r.status] || []);
      actions.priority = W.isOpen(r.status);
      actions.remark = true;
      actions.resolution_image = ['IN_PROGRESS', 'RESOLVED'].includes(r.status);
    }
    actions.assign = staff && W.ASSIGNABLE.includes(r.status) && W.canAssign(user, r, user.role === 'officer' && !r.assigned_to_id ? user.id : -1);
    return {
      id: r.id, tracking_no: r.tracking_no, title: r.title, description: r.description, status: r.status, priority: r.priority,
      category: r.category, category_id: r.category_id, department: r.department, department_id: staff ? r.department_id : undefined,
      lat: r.lat, lng: r.lng, address: r.address, location_source: r.location_source,
      created_at: r.created_at, updated_at: r.updated_at, due_at: r.due_at, resolved_at: r.resolved_at, resolution_note: r.resolution_note,
      overdue: W.isOpen(r.status) && r.due_at < now(),
      assignee: staff ? r.assignee : undefined, assigned_to_id: staff ? r.assigned_to_id : undefined,
      reporter: staff ? db.prepare('SELECT name FROM users WHERE id=?').get(r.user_id)?.name : undefined,
      images: db.prepare('SELECT id, kind FROM report_images WHERE report_id=? ORDER BY id').all(r.id)
        .map((i) => ({ ...i, url: `/api/images/${i.id}` })),
      events, feedback, actions,
    };
  };

  // ---- create ----
  app.post('/api/reports', authn, need('citizen'), needVerified, limits.create, upload.array('images', 3), (req, res) => {
    const b = req.body || {};
    const title = str(b.title, 'Title', 5, 120);
    const description = str(b.description, 'Description', 10, 2000);
    const address = str(b.address, 'Address', 0, 300);
    const cat = db.prepare('SELECT * FROM categories WHERE id=? AND active=1').get(Number(b.category_id));
    if (!cat) throw new ApiError(400, 'Choose a valid category');
    if (nz(b.lat) !== nz(b.lng)) throw new ApiError(400, 'Latitude and longitude must be given together');
    let lat = null, lng = null, source = 'manual';
    if (nz(b.lat)) {
      lat = Number(b.lat); lng = Number(b.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
        throw new ApiError(400, 'Coordinates are out of range');
      source = ['device', 'map', 'manual'].includes(b.location_source) ? b.location_source : 'map';
    } else if (address.length < 3) throw new ApiError(400, 'Pick a point on the map or describe the location');
    const imgs = prepareImages(req.files);
    if (!imgs.length) throw new ApiError(400, 'At least one photo is required');

    const files = writeImages(imgs);
    let rep;
    try {
      rep = tx(() => {
        const t = now();
        const tn = trackingNo();
        const id = Number(db.prepare(`INSERT INTO reports(tracking_no,user_id,category_id,department_id,title,description,lat,lng,
          address,location_source,created_at,updated_at,due_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(tn, req.user.id, cat.id, cat.department_id, title, description, lat, lng, address, source, t, t, t + cat.sla_hours * 36e5).lastInsertRowid);
        const ins = db.prepare('INSERT INTO report_images(report_id,kind,filename,mime,uploaded_by,created_at) VALUES(?,?,?,?,?,?)');
        files.forEach((f) => ins.run(id, 'report', f.filename, f.mime, req.user.id, t));
        addEvent(id, 'status', req.user, { to: 'SUBMITTED', note: 'Report submitted', visibility: 'public' });
        return { id, tracking_no: tn, department_id: cat.department_id };
      });
    } catch (e) { unlinkAll(files); throw e; }

    notify(req.user.id, rep.id, 'submitted', `Your report ${rep.tracking_no} was submitted.`);
    if (rep.department_id)
      for (const o of db.prepare('SELECT id FROM users WHERE role=\'officer\' AND active=1 AND can_assign=1 AND department_id=?').all(rep.department_id))
        notify(o.id, rep.id, 'new_report', `New report ${rep.tracking_no} awaiting review.`);
    res.status(201).json({ id: rep.id, tracking_no: rep.tracking_no });
  });

  // ---- list / markers / dashboard ----
  const filters = (user, q) => {
    const sc = W.scopeSql(user);
    const where = [sc.sql], p = { now: now() }, params = [...sc.params];
    const add = (sql, ...vals) => { where.push(sql); params.push(...vals); };
    if (nz(q.status)) {
      const list = String(q.status).split(',').filter((s) => W.STATUSES.includes(s));
      if (!list.length) throw new ApiError(400, 'Unknown status');
      add(`r.status IN (${list.map(() => '?').join(',')})`, ...list);
    }
    if (nz(q.priority)) { if (!W.PRIORITIES.includes(q.priority)) throw new ApiError(400, 'Unknown priority'); add('r.priority = ?', q.priority); }
    if (nz(q.category_id)) add('r.category_id = ?', Number(q.category_id));
    if (user.role === 'admin' && nz(q.department_id)) add('r.department_id = ?', Number(q.department_id));
    if (q.assigned_to === 'me') add('r.assigned_to_id = ?', user.id);
    else if (q.assigned_to === 'unassigned') add('r.assigned_to_id IS NULL');
    else if (nz(q.assigned_to) && user.role !== 'citizen') add('r.assigned_to_id = ?', Number(q.assigned_to));
    if (q.overdue === '1') add(OVERDUE);
    if (nz(q.q)) {
      const like = '%' + String(q.q).trim().slice(0, 100).replace(/[\\%_]/g, '\\$&') + '%';
      add(`(r.tracking_no LIKE ? ESCAPE '\\' OR r.title LIKE ? ESCAPE '\\' OR r.address LIKE ? ESCAPE '\\')`, like, like, like);
    }
    return { where: where.join(' AND '), params, p };
  };
  // node:sqlite mixes named and positional params poorly, so inline the single named value.
  const bindNow = (sql) => sql.replaceAll('@now', String(now()));

  app.get('/api/reports', authn, noEntrepreneur, (req, res) => {
    const { where, params } = filters(req.user, req.query);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const sort = SORTS[req.query.sort] || SORTS.created_at;
    const dir = req.query.order === 'asc' ? 'ASC' : 'DESC';
    const total = db.prepare(bindNow(`SELECT COUNT(*) n ${FROM} WHERE ${where}`)).get(...params).n;
    const items = db.prepare(bindNow(`SELECT ${COLS} ${FROM} WHERE ${where} ORDER BY ${sort} ${dir}, r.id DESC LIMIT ? OFFSET ?`))
      .all(...params, limit, (page - 1) * limit).map((r) => {
        if (req.user.role === 'citizen') { delete r.assigned_to_id; delete r.assignee; delete r.department_id; }
        return { ...r, overdue: !!r.overdue };
      });
    res.json({ items, page, limit, total });
  });

  app.get('/api/reports/markers', authn, noEntrepreneur, (req, res) => {
    const { where, params } = filters(req.user, req.query);
    res.json({ items: db.prepare(bindNow(`SELECT r.id, r.tracking_no, r.title, r.lat, r.lng, r.status, c.name AS category ${FROM}
      WHERE ${where} AND r.lat IS NOT NULL ORDER BY r.created_at DESC LIMIT 500`)).all(...params) });
  });

  app.get('/api/dashboard', authn, need('officer', 'admin'), (req, res) => {
    const u = req.user, sc = W.scopeSql(u), t = now();
    const mine = db.prepare(`SELECT COUNT(*) n FROM reports r WHERE r.assigned_to_id = ? AND r.status NOT IN ('RESOLVED','CLOSED','REJECTED')`).get(u.id).n;
    const recent = db.prepare(bindNow(`SELECT ${COLS} ${FROM} WHERE ${sc.sql} ORDER BY r.updated_at DESC LIMIT 8`)).all(...sc.params)
      .map((r) => ({ ...r, overdue: !!r.overdue }));
    const lead = u.role === 'admin' || u.can_assign;
    const workload = db.prepare(`SELECT u.id, u.name, COUNT(r.id) AS open,
        SUM(CASE WHEN r.due_at < ? THEN 1 ELSE 0 END) AS overdue
      FROM users u LEFT JOIN reports r ON r.assigned_to_id = u.id AND r.status NOT IN ('RESOLVED','CLOSED','REJECTED')
      WHERE u.role = 'officer' AND u.active = 1 AND (? OR u.id = ?) AND (? = 1 OR u.department_id = ?)
      GROUP BY u.id ORDER BY open DESC`).all(t, lead ? 1 : 0, u.id, u.role === 'admin' ? 1 : 0, u.department_id ?? -1);
    res.json({ ...summary(db, sc, t), assigned_to_me: mine, recent, workload });
  });

  // Officers who can be assigned work: own department for officers, any (optionally filtered) for admins.
  app.get('/api/officers', authn, need('officer', 'admin'), (req, res) => {
    const d = req.user.role === 'admin' ? (nz(req.query.department_id) ? Number(req.query.department_id) : null) : (req.user.department_id ?? -1);
    res.json({ items: db.prepare(`SELECT u.id, u.name, u.department_id, d.name AS department FROM users u
      LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.role = 'officer' AND u.active = 1 AND (? IS NULL OR u.department_id = ?) ORDER BY u.name`).all(d, d) });
  });

  // ---- detail / edit ----
  app.get('/api/reports/:id', authn, noEntrepreneur, (req, res) => res.json(present(req.user, loadFor(req.user, req.params.id))));

  app.patch('/api/reports/:id', authn, need('citizen'), (req, res) => {
    const r = loadFor(req.user, req.params.id);
    if (r.status !== 'SUBMITTED') throw new ApiError(409, 'A report can only be edited before review starts');
    const b = req.body || {};
    const title = b.title === undefined ? r.title : str(b.title, 'Title', 5, 120);
    const description = b.description === undefined ? r.description : str(b.description, 'Description', 10, 2000);
    const address = b.address === undefined ? r.address : str(b.address, 'Address', 0, 300);
    if (r.lat == null && address.length < 3) throw new ApiError(400, 'Describe the location');
    tx(() => {
      db.prepare('UPDATE reports SET title=?, description=?, address=?, updated_at=? WHERE id=?').run(title, description, address, now(), r.id);
      addEvent(r.id, 'edit', req.user, { note: 'Citizen edited report details' });
    });
    res.json(present(req.user, load(r.id)));
  });

  // ---- workflow ----
  function changeStatus(user, r, to, note, expected) {
    if (expected && expected !== r.status) throw new ApiError(409, 'This report was updated by someone else. Reload and try again.');
    if (!W.canTransition(r.status, to)) throw new ApiError(409, `Cannot change status from ${r.status} to ${to}`);
    if (W.NOTE_REQUIRED.includes(to) && !note) throw new ApiError(400, `A note is required when setting ${to}`);
    const t = now();
    tx(() => {
      const res = db.prepare(`UPDATE reports SET status=?, updated_at=?,
        resolved_at = CASE WHEN ? = 'RESOLVED' THEN ? WHEN ? = 'REOPENED' THEN NULL ELSE resolved_at END,
        resolution_note = CASE WHEN ? = 'RESOLVED' THEN ? ELSE resolution_note END
        WHERE id=? AND status=?`).run(to, t, to, t, to, to, note || null, r.id, r.status);
      if (!res.changes) throw new ApiError(409, 'This report was updated by someone else. Reload and try again.');
      addEvent(r.id, 'status', user, { from: r.status, to, note: note || null, visibility: 'public' });
    });
  }
  const STATUS_MSG = {
    UNDER_REVIEW: 'is now under review', ACCEPTED: 'was accepted', REJECTED: 'was rejected', IN_PROGRESS: 'work has started',
    RESOLVED: 'was marked resolved', REOPENED: 'was reopened', CLOSED: 'was closed',
  };

  app.post('/api/reports/:id/status', authn, (req, res) => {
    const r = loadFor(req.user, req.params.id);
    const { to, expected_status } = req.body || {};
    const note = str(req.body?.note, 'Note', 0, 1000);
    if (!W.STATUSES.includes(to)) throw new ApiError(400, 'Unknown status');
    if (req.user.role === 'citizen') {
      if (to !== 'REOPENED' || r.status !== 'RESOLVED') throw new ApiError(403, 'Forbidden');
    } else if (!W.canManage(req.user, r)) throw new ApiError(403, 'Forbidden');
    changeStatus(req.user, r, to, note, expected_status);
    audit(req.user, 'report.status', 'report', r.id, { from: r.status, to });
    if (req.user.role !== 'citizen') notify(r.user_id, r.id, 'status', `Report ${r.tracking_no} ${STATUS_MSG[to]}.${to === 'REJECTED' ? ' Reason: ' + note : ''}`);
    else if (r.assigned_to_id) notify(r.assigned_to_id, r.id, 'status', `Report ${r.tracking_no} was reopened by the citizen.`);
    res.json(present(req.user, load(r.id)));
  });

  app.post('/api/reports/:id/assign', authn, need('officer', 'admin'), (req, res) => {
    const r = loadFor(req.user, req.params.id);
    const assigneeId = Number(req.body?.assignee_id);
    const note = str(req.body?.note, 'Note', 0, 1000);
    if (!W.ASSIGNABLE.includes(r.status)) throw new ApiError(409, `Cannot assign a report that is ${r.status}`);
    if (!W.canAssign(req.user, r, assigneeId)) throw new ApiError(403, 'Forbidden');
    const target = db.prepare("SELECT * FROM users WHERE id=? AND role='officer' AND active=1").get(assigneeId);
    if (!target) throw new ApiError(400, 'Assignee must be an active officer');
    if (r.department_id == null ? req.user.role !== 'admin' : target.department_id !== r.department_id)
      throw new ApiError(400, "Assignee must belong to the report's department");
    if (r.assigned_to_id === target.id) throw new ApiError(400, 'Report is already assigned to this officer');
    tx(() => {
      const advance = ['ACCEPTED', 'REOPENED'].includes(r.status);
      // An un-routed report (category had no department when filed) joins the assignee's department.
      const res2 = db.prepare(`UPDATE reports SET assigned_to_id=?, status=?, updated_at=?, department_id=COALESCE(department_id, ?)
        WHERE id=? AND status=?`).run(target.id, advance ? 'ASSIGNED' : r.status, now(), target.department_id ?? null, r.id, r.status);
      if (!res2.changes) throw new ApiError(409, 'This report was updated by someone else. Reload and try again.');
      addEvent(r.id, 'assign', req.user, { from: r.assignee || null, to: target.name, note: note || null });
      if (advance) addEvent(r.id, 'status', req.user, { from: r.status, to: 'ASSIGNED', visibility: 'public' });
    });
    audit(req.user, 'report.assign', 'report', r.id, { from: r.assigned_to_id, to: target.id });
    notify(target.id, r.id, 'assigned', `Report ${r.tracking_no} was assigned to you.`);
    if (['ACCEPTED', 'REOPENED'].includes(r.status)) notify(r.user_id, r.id, 'status', `Report ${r.tracking_no} was assigned to a team.`);
    res.json(present(req.user, load(r.id)));
  });

  app.post('/api/reports/:id/remarks', authn, need('officer', 'admin'), (req, res) => {
    const r = loadFor(req.user, req.params.id);
    if (!W.canManage(req.user, r)) throw new ApiError(403, 'Forbidden');
    const body = str(req.body?.body, 'Remark', 1, 1000);
    const visibility = req.body?.visibility === 'public' ? 'public' : 'internal';
    tx(() => { addEvent(r.id, 'remark', req.user, { note: body, visibility }); touch(r.id); });
    if (visibility === 'public') notify(r.user_id, r.id, 'update', `New progress update on ${r.tracking_no}.`);
    res.status(201).json(present(req.user, load(r.id)));
  });

  app.patch('/api/reports/:id/priority', authn, need('officer', 'admin'), (req, res) => {
    const r = loadFor(req.user, req.params.id);
    if (!W.canManage(req.user, r)) throw new ApiError(403, 'Forbidden');
    const p = req.body?.priority;
    if (!W.PRIORITIES.includes(p)) throw new ApiError(400, 'Unknown priority');
    if (!W.isOpen(r.status)) throw new ApiError(409, 'Priority cannot change on a finished report');
    if (p !== r.priority) tx(() => {
      db.prepare('UPDATE reports SET priority=?, updated_at=? WHERE id=?').run(p, now(), r.id);
      addEvent(r.id, 'priority', req.user, { from: r.priority, to: p });
    });
    audit(req.user, 'report.priority', 'report', r.id, { from: r.priority, to: p });
    res.json(present(req.user, load(r.id)));
  });

  // resolution evidence (staff only)
  app.post('/api/reports/:id/images', authn, need('officer', 'admin'), upload.array('images', 3), (req, res) => {
    const r = loadFor(req.user, req.params.id);
    if (!W.canManage(req.user, r)) throw new ApiError(403, 'Forbidden');
    if (!['IN_PROGRESS', 'RESOLVED'].includes(r.status)) throw new ApiError(409, 'Resolution photos can be added while in progress or resolved');
    const imgs = prepareImages(req.files);
    if (!imgs.length) throw new ApiError(400, 'No image supplied');
    if (db.prepare("SELECT COUNT(*) n FROM report_images WHERE report_id=? AND kind='resolution'").get(r.id).n + imgs.length > 6)
      throw new ApiError(400, 'At most 6 resolution photos per report');
    const files = writeImages(imgs);
    try {
      tx(() => {
        const ins = db.prepare('INSERT INTO report_images(report_id,kind,filename,mime,uploaded_by,created_at) VALUES(?,?,?,?,?,?)');
        files.forEach((f) => ins.run(r.id, 'resolution', f.filename, f.mime, req.user.id, now()));
        touch(r.id);
      });
    } catch (e) { unlinkAll(files); throw e; }
    audit(req.user, 'report.resolution_image', 'report', r.id, { count: files.length });
    res.status(201).json(present(req.user, load(r.id)));
  });

  app.post('/api/reports/:id/feedback', authn, need('citizen'), (req, res) => {
    const r = loadFor(req.user, req.params.id);
    if (!['RESOLVED', 'CLOSED'].includes(r.status)) throw new ApiError(409, 'Feedback is available once the report is resolved');
    const rating = Number(req.body?.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new ApiError(400, 'Rating must be 1-5');
    const comment = str(req.body?.comment, 'Comment', 0, 1000);
    try {
      db.prepare('INSERT INTO feedback(report_id,user_id,rating,comment,created_at) VALUES(?,?,?,?,?)').run(r.id, req.user.id, rating, comment || null, now());
    } catch (e) {
      if (/UNIQUE|PRIMARY/.test(e.message)) throw new ApiError(409, 'Feedback already submitted');
      throw e;
    }
    res.status(201).json(present(req.user, load(r.id)));
  });

  // Authorised image delivery (files are never served statically).
  app.get('/api/images/:id', authn, noEntrepreneur, (req, res) => {
    const img = db.prepare('SELECT * FROM report_images WHERE id=?').get(parseId(req.params.id));
    const r = img && load(img.report_id);
    if (!r || !W.canView(req.user, r)) throw new ApiError(404, 'Not found');
    const safe = ['image/jpeg', 'image/png', 'image/webp'].includes(img.mime);
    res.set({
      'Content-Type': safe ? img.mime : 'application/octet-stream',
      'Content-Disposition': safe ? 'inline' : 'attachment',
      'Cache-Control': 'private, max-age=3600',
    });
    res.sendFile(path.join(uploadDir, path.basename(img.filename)), (err) => { if (err && !res.headersSent) res.status(404).json({ error: 'Not found' }); });
  });
};
