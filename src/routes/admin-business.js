const { ApiError, str, parseId } = require('../util');

const REVIEW = ['APPROVED', 'REJECTED', 'SUSPENDED'];
const COMPLAINT = ['OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED'];
const KINDS = ['guide', 'marketing', 'learning'];
const dupe = (e, msg) => { if (/UNIQUE/.test(e.message)) throw new ApiError(409, msg); throw e; };

module.exports = (app, { db, authn, need, audit, notify }) => {
  const admin = [authn, need('admin')];
  const paging = (q, def) => ({ limit: Math.min(Math.max(parseInt(q.limit) || def, 1), 100), page: Math.max(parseInt(q.page) || 1, 1) });

  // ---- delivery outcomes of email/SMS notifications ----
  app.get('/api/admin/deliveries', ...admin, (req, res) => {
    const { limit, page } = paging(req.query, 50);
    const where = ["n.channel != 'in_app'"], p = [];
    if (['pending', 'sent', 'failed'].includes(req.query.status)) { where.push('n.status = ?'); p.push(req.query.status); }
    const w = where.join(' AND ');
    res.json({
      page, limit, total: db.prepare(`SELECT COUNT(*) n FROM notifications n WHERE ${w}`).get(...p).n,
      summary: db.prepare("SELECT channel, status, COUNT(*) AS n FROM notifications WHERE channel != 'in_app' GROUP BY channel, status").all(),
      items: db.prepare(`SELECT n.id, n.channel, n.status, n.error, n.type, n.created_at, u.name AS recipient FROM notifications n
        JOIN users u ON u.id = n.user_id WHERE ${w} ORDER BY n.id DESC LIMIT ? OFFSET ?`).all(...p, limit, (page - 1) * limit),
    });
  });

  // ---- business profile review ----
  app.get('/api/admin/businesses', ...admin, (req, res) => {
    const { limit, page } = paging(req.query, 25);
    const where = [], p = [];
    if (['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'].includes(req.query.status)) { where.push('b.status = ?'); p.push(req.query.status); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    res.json({
      page, limit, total: db.prepare(`SELECT COUNT(*) n FROM businesses b ${w}`).get(...p).n,
      items: db.prepare(`SELECT b.id, b.name, b.city, b.status, b.review_note, b.created_at, b.updated_at, c.name AS category,
          u.name AS owner_name, u.email AS owner_email FROM businesses b JOIN business_categories c ON c.id=b.category_id
        JOIN users u ON u.id=b.owner_id ${w} ORDER BY (b.status='PENDING') DESC, b.updated_at DESC LIMIT ? OFFSET ?`).all(...p, limit, (page - 1) * limit),
    });
  });

  app.post('/api/admin/businesses/:id/review', ...admin, (req, res) => {
    const id = parseId(req.params.id), decision = req.body?.decision;
    if (!REVIEW.includes(decision)) throw new ApiError(400, 'Decision must be APPROVED, REJECTED or SUSPENDED');
    const note = str(req.body?.note, 'Note', decision === 'APPROVED' ? 0 : 3, 1000);
    const b = db.prepare('SELECT * FROM businesses WHERE id=?').get(id);
    if (!b) throw new ApiError(404, 'Business not found');
    if (b.status === decision) throw new ApiError(409, `Already ${decision.toLowerCase()}`);
    db.prepare('UPDATE businesses SET status=?, review_note=?, reviewed_by=?, reviewed_at=?, updated_at=? WHERE id=?')
      .run(decision, note || null, req.user.id, Date.now(), Date.now(), id);
    audit(req.user, 'business.review', 'business', id, { from: b.status, to: decision });
    notify(b.owner_id, null, 'business_review',
      decision === 'APPROVED' ? `Your business "${b.name}" was approved and is now visible to customers.`
        : `Your business "${b.name}" was ${decision.toLowerCase()}. Reason: ${note}`, '#/my-business');
    res.json({ ok: true });
  });

  // ---- remove an abusive review ----
  app.delete('/api/admin/reviews/:id', ...admin, (req, res) => {
    const id = parseId(req.params.id);
    if (!db.prepare('DELETE FROM business_reviews WHERE id=?').run(id).changes) throw new ApiError(404, 'Not found');
    audit(req.user, 'review.delete', 'review', id);
    res.json({ ok: true });
  });

  // ---- business categories (deactivate, never delete) ----
  app.get('/api/admin/business-categories', ...admin, (_req, res) => res.json({
    items: db.prepare(`SELECT c.id, c.name, c.active, (SELECT COUNT(*) FROM businesses b WHERE b.category_id=c.id) AS businesses
      FROM business_categories c ORDER BY c.name`).all().map((c) => ({ ...c, active: !!c.active })) }));
  app.post('/api/admin/business-categories', ...admin, (req, res) => {
    try {
      const id = Number(db.prepare('INSERT INTO business_categories(name) VALUES(?)').run(str(req.body?.name, 'Name', 2, 100)).lastInsertRowid);
      audit(req.user, 'business_category.create', 'business_category', id);
      res.status(201).json({ id });
    } catch (e) { dupe(e, 'Category already exists'); }
  });
  app.patch('/api/admin/business-categories/:id', ...admin, (req, res) => {
    const id = parseId(req.params.id), b = req.body || {};
    const c = db.prepare('SELECT * FROM business_categories WHERE id=?').get(id);
    if (!c) throw new ApiError(404, 'Not found');
    try {
      db.prepare('UPDATE business_categories SET name=?, active=? WHERE id=?')
        .run(b.name === undefined ? c.name : str(b.name, 'Name', 2, 100), b.active === undefined ? c.active : (b.active ? 1 : 0), id);
    } catch (e) { dupe(e, 'Category already exists'); }
    audit(req.user, 'business_category.update', 'business_category', id);
    res.json({ ok: true });
  });

  // ---- complaints ----
  app.get('/api/admin/complaints', ...admin, (req, res) => {
    const { limit, page } = paging(req.query, 25);
    const where = [], p = [];
    if (COMPLAINT.includes(req.query.status)) { where.push('c.status = ?'); p.push(req.query.status); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    res.json({
      page, limit, total: db.prepare(`SELECT COUNT(*) n FROM complaints c ${w}`).get(...p).n,
      items: db.prepare(`SELECT c.id, c.subject, c.body, c.status, c.admin_note, c.created_at, c.updated_at, c.business_id,
          b.name AS business_name, u.name AS complainant, u.role AS complainant_role FROM complaints c
        JOIN users u ON u.id=c.user_id LEFT JOIN businesses b ON b.id=c.business_id ${w}
        ORDER BY (c.status IN ('OPEN','IN_REVIEW')) DESC, c.id DESC LIMIT ? OFFSET ?`).all(...p, limit, (page - 1) * limit),
    });
  });
  app.patch('/api/admin/complaints/:id', ...admin, (req, res) => {
    const id = parseId(req.params.id), to = req.body?.status;
    if (!COMPLAINT.includes(to)) throw new ApiError(400, 'Unknown status');
    const note = str(req.body?.admin_note, 'Note', ['RESOLVED', 'DISMISSED'].includes(to) ? 3 : 0, 1000);
    const c = db.prepare('SELECT * FROM complaints WHERE id=?').get(id);
    if (!c) throw new ApiError(404, 'Not found');
    db.prepare('UPDATE complaints SET status=?, admin_note=COALESCE(?, admin_note), handled_by=?, updated_at=? WHERE id=?')
      .run(to, note || null, req.user.id, Date.now(), id);
    audit(req.user, 'complaint.update', 'complaint', id, { to });
    notify(c.user_id, null, 'complaint_update', `Your complaint "${c.subject.slice(0, 50)}" is now ${to.toLowerCase().replace('_', ' ')}.`, '#/complaints');
    res.json({ ok: true });
  });

  // ---- learning / guidance content ----
  const content = (b, cur = {}) => {
    const kind = b.kind ?? cur.kind;
    if (!KINDS.includes(kind)) throw new ApiError(400, 'Kind must be guide, marketing or learning');
    const order = b.sort_order ?? cur.sort_order ?? 0;
    if (!Number.isInteger(Number(order)) || Math.abs(Number(order)) > 10000) throw new ApiError(400, 'Invalid order');
    return { kind, title: str(b.title ?? cur.title, 'Title', 3, 150), body: str(b.body ?? cur.body, 'Body', 10, 20000),
      order: Number(order), published: (b.published ?? cur.published ?? 1) ? 1 : 0 };
  };
  app.post('/api/admin/content', ...admin, (req, res) => {
    const c = content(req.body || {}), t = Date.now();
    const id = Number(db.prepare('INSERT INTO content(kind,title,body,sort_order,published,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(c.kind, c.title, c.body, c.order, c.published, req.user.id, t, t).lastInsertRowid);
    audit(req.user, 'content.create', 'content', id);
    res.status(201).json({ id });
  });
  app.patch('/api/admin/content/:id', ...admin, (req, res) => {
    const id = parseId(req.params.id);
    const cur = db.prepare('SELECT * FROM content WHERE id=?').get(id);
    if (!cur) throw new ApiError(404, 'Not found');
    const c = content(req.body || {}, cur);
    db.prepare('UPDATE content SET kind=?, title=?, body=?, sort_order=?, published=?, updated_at=? WHERE id=?').run(c.kind, c.title, c.body, c.order, c.published, Date.now(), id);
    audit(req.user, 'content.update', 'content', id);
    res.json({ ok: true });
  });
  app.delete('/api/admin/content/:id', ...admin, (req, res) => {
    const id = parseId(req.params.id);
    if (!db.prepare('DELETE FROM content WHERE id=?').run(id).changes) throw new ApiError(404, 'Not found');
    audit(req.user, 'content.delete', 'content', id);
    res.json({ ok: true });
  });
};
