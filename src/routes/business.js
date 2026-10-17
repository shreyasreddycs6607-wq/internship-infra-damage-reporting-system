const multer = require('multer');
const { ApiError, str, parseId } = require('../util');

const nz = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const MAX_BUSINESS_IMAGES = 6;

// Inquiry/order lifecycle. Who may trigger each move: 'owner' = the business owner, 'customer' = the requester.
const MOVES = {
  NEW: { ACCEPTED: 'owner', DECLINED: 'owner', CANCELLED: 'customer' },
  REPLIED: { ACCEPTED: 'owner', DECLINED: 'owner', CANCELLED: 'customer' },
  ACCEPTED: { COMPLETED: 'owner', CANCELLED: 'customer' },
  DECLINED: {}, COMPLETED: {}, CANCELLED: {},
};
const finished = (s) => !Object.keys(MOVES[s] || {}).length;

module.exports = (app, { db, tx, authn, optAuthn, need, needVerified, notify, audit, limits, maxUploadBytes, images }) => {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxUploadBytes, files: 3, fields: 10, fieldSize: 20000 } });
  const now = () => Date.now();
  const flag = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

  const loadBusiness = (id) => db.prepare(`SELECT b.*, c.name AS category, u.name AS owner_name
    FROM businesses b JOIN business_categories c ON c.id=b.category_id JOIN users u ON u.id=b.owner_id WHERE b.id=?`).get(id);
  // Public sees APPROVED only; the owner and admins see their own/any in every state. Else 404.
  const visibleBusiness = (user, id) => {
    const b = loadBusiness(parseId(id));
    if (!b || (b.status !== 'APPROVED' && !(user && (user.role === 'admin' || user.id === b.owner_id)))) throw new ApiError(404, 'Business not found');
    return b;
  };
  const ratingOf = (id) => {
    const r = db.prepare('SELECT COUNT(*) AS n, AVG(rating) AS avg FROM business_reviews WHERE business_id=?').get(id);
    return { rating_avg: r.avg == null ? null : Math.round(r.avg * 10) / 10, rating_count: r.n };
  };
  const reviewer = (name) => { const [f, ...rest] = String(name).split(' '); return rest.length ? `${f} ${rest[rest.length - 1][0]}.` : f; };
  const present = (b, user) => {
    const own = user && (user.role === 'admin' || user.id === b.owner_id);
    return {
      ...ratingOf(b.id), lat: b.lat, lng: b.lng,
      reviews: db.prepare(`SELECT r.id, r.rating, r.comment, r.created_at, u.name AS reviewer FROM business_reviews r
        JOIN users u ON u.id=r.customer_id WHERE r.business_id=? ORDER BY r.id DESC LIMIT 20`).all(b.id).map((r) => ({ ...r, reviewer: reviewer(r.reviewer) })),
      id: b.id, name: b.name, category: b.category, category_id: b.category_id, description: b.description, city: b.city,
      address: b.address, contact_phone: b.contact_phone, pricing_info: b.pricing_info, availability_text: b.availability_text,
      accepting_orders: !!b.accepting_orders, owner_name: b.owner_name, verified: b.status === 'APPROVED',
      status: own ? b.status : undefined, review_note: own ? b.review_note : undefined,
      services: db.prepare('SELECT id,title,description,price,price_unit,available FROM business_services WHERE business_id=? ORDER BY id').all(b.id)
        .map((s) => ({ ...s, available: !!s.available })),
      images: db.prepare('SELECT id FROM business_images WHERE business_id=? ORDER BY id').all(b.id).map((i) => ({ id: i.id, url: `/api/business-images/${i.id}` })),
    };
  };

  // ---------------- public browsing ----------------
  app.get('/api/business-categories', (_req, res) =>
    res.json({ items: db.prepare('SELECT id, name FROM business_categories WHERE active=1 ORDER BY name').all() }));

  app.get('/api/businesses/cities', (_req, res) =>
    res.json({ items: db.prepare("SELECT DISTINCT city FROM businesses WHERE status='APPROVED' ORDER BY city COLLATE NOCASE").all().map((r) => r.city) }));

  const toRad = (d) => (d * Math.PI) / 180;
  const haversineKm = (la1, ln1, la2, ln2) => {
    const a = Math.sin(toRad(la2 - la1) / 2) ** 2 + Math.cos(toRad(la1)) * Math.cos(toRad(la2)) * Math.sin(toRad(ln2 - ln1) / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
  };
  const parseGeo = (la, ln) => {
    if (!nz(la) || !nz(ln)) return null;
    const lat = Number(la), lng = Number(ln);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new ApiError(400, 'Coordinates are out of range');
    return { lat, lng };
  };
  // Business locations are stored rounded to 3 decimals (~110 m): precise enough for "near me", too coarse to
  // pinpoint a home, and repeated distance queries cannot recover anything finer than what is stored.
  const roundGeo = (g) => (g ? { lat: Math.round(g.lat * 1000) / 1000, lng: Math.round(g.lng * 1000) / 1000 } : null);

  app.get('/api/businesses', (req, res) => {
    const q = req.query, where = ["b.status = 'APPROVED'"], p = [];
    if (nz(q.category_id)) { where.push('b.category_id = ?'); p.push(Number(q.category_id)); }
    if (nz(q.city)) { where.push('lower(b.city) = lower(?)'); p.push(String(q.city).trim().slice(0, 100)); }
    if (q.available === '1') where.push('b.accepting_orders = 1');
    if (nz(q.q)) {
      const l = '%' + String(q.q).trim().slice(0, 100).replace(/[\\%_]/g, '\\$&') + '%';
      where.push(`(b.name LIKE ? ESCAPE '\\' OR b.description LIKE ? ESCAPE '\\' OR EXISTS
        (SELECT 1 FROM business_services s WHERE s.business_id=b.id AND s.title LIKE ? ESCAPE '\\'))`);
      p.push(l, l, l);
    }
    let near = null;
    if (nz(q.near_lat) || nz(q.near_lng)) {
      near = parseGeo(q.near_lat, q.near_lng);
      if (!near) throw new ApiError(400, 'Provide both near_lat and near_lng');
      near.radius = Math.min(Math.max(Number(q.radius_km) || 10, 1), 200);
      // Bounding box in SQL (uses the lat/lng index); exact distance is checked below.
      // ponytail: ignores longitude wrap at the antimeridian; fine for city-scale search.
      const dLat = near.radius / 110.574, dLng = near.radius / (111.32 * Math.max(Math.cos(toRad(near.lat)), 0.01));
      where.push('b.lat BETWEEN ? AND ? AND b.lng BETWEEN ? AND ?');
      p.push(near.lat - dLat, near.lat + dLat, near.lng - dLng, near.lng + dLng);
    }
    const sort = q.sort === 'rating' ? 'rating' : q.sort === 'newest' ? 'newest' : near ? 'distance' : 'newest';
    const limit = Math.min(Math.max(parseInt(q.limit) || 12, 1), 50), page = Math.max(parseInt(q.page) || 1, 1);
    const w = where.join(' AND ');
    const order = sort === 'rating' ? 'rating_avg IS NULL, rating_avg DESC, rating_count DESC, b.updated_at DESC' : 'b.updated_at DESC';
    const select = `SELECT b.id, b.name, b.city, b.description, b.accepting_orders, b.category_id, b.lat, b.lng, c.name AS category,
        (SELECT MIN(price) FROM business_services s WHERE s.business_id=b.id AND s.available=1) AS from_price,
        (SELECT id FROM business_images i WHERE i.business_id=b.id ORDER BY id LIMIT 1) AS cover_image_id,
        (SELECT AVG(rating) FROM business_reviews r WHERE r.business_id=b.id) AS rating_avg,
        (SELECT COUNT(*) FROM business_reviews r WHERE r.business_id=b.id) AS rating_count
      FROM businesses b JOIN business_categories c ON c.id=b.category_id WHERE ${w} ORDER BY ${order}`;
    const shape = (b, dist) => {
      const { lat, lng, ...rest } = b;
      return { ...rest, description: b.description.slice(0, 160), accepting_orders: !!b.accepting_orders, verified: true,
        rating_avg: b.rating_avg == null ? null : Math.round(b.rating_avg * 10) / 10, ...(dist == null ? {} : { distance_km: Math.round(dist * 10) / 10 }) };
    };
    if (!near) {
      return res.json({ page, limit,
        total: db.prepare(`SELECT COUNT(*) n FROM businesses b WHERE ${w}`).get(...p).n,
        items: db.prepare(select + ' LIMIT ? OFFSET ?').all(...p, limit, (page - 1) * limit).map((b) => shape(b)) });
    }
    const rows = db.prepare(select + ' LIMIT 2000').all(...p)
      .map((b) => ({ b, d: haversineKm(near.lat, near.lng, b.lat, b.lng) })).filter((x) => x.d <= near.radius);
    if (sort === 'distance') rows.sort((x, y) => x.d - y.d);
    res.json({ page, limit, total: rows.length, items: rows.slice((page - 1) * limit, page * limit).map((x) => shape(x.b, x.d)) });
  });

  app.get('/api/businesses/:id', optAuthn, (req, res) => res.json(present(visibleBusiness(req.user, req.params.id), req.user)));

  app.get('/api/business-images/:id', optAuthn, (req, res) => {
    const img = db.prepare('SELECT * FROM business_images WHERE id=?').get(parseId(req.params.id));
    if (!img) throw new ApiError(404, 'Not found');
    visibleBusiness(req.user, img.business_id);
    res.set('Cache-Control', 'public, max-age=3600');
    images.send(res, img);
  });

  // ---------------- entrepreneur: own business ----------------
  const mine = (user) => db.prepare('SELECT id FROM businesses WHERE owner_id=?').get(user.id);
  const owner = [authn, need('entrepreneur')];

  app.get('/api/my/business', ...owner, (req, res) => {
    const m = mine(req.user);
    res.json({ business: m ? present(loadBusiness(m.id), req.user) : null });
  });

  app.put('/api/my/business', ...owner, needVerified, (req, res) => {
    const b = req.body || {};
    const cat = db.prepare('SELECT id FROM business_categories WHERE id=? AND active=1').get(Number(b.category_id));
    if (!cat) throw new ApiError(400, 'Choose a valid business category');
    const v = {
      name: str(b.name, 'Business name', 2, 100), description: str(b.description, 'Description', 20, 2000),
      city: str(b.city, 'City', 2, 100), address: str(b.address, 'Address', 0, 300),
      phone: str(b.contact_phone, 'Phone', 0, 30), pricing: str(b.pricing_info, 'Pricing information', 0, 1000),
      avail: str(b.availability_text, 'Availability', 0, 300), accepting: b.accepting_orders === undefined ? 1 : flag(b.accepting_orders),
    };
    const m0 = mine(req.user);
    const cur0 = m0 ? loadBusiness(m0.id) : null;
    const geo = b.lat === undefined && b.lng === undefined ? (cur0 && cur0.lat != null ? { lat: cur0.lat, lng: cur0.lng } : null) : roundGeo(parseGeo(b.lat, b.lng));
    if (v.phone && !/^[0-9+()\-\s]{6,30}$/.test(v.phone)) throw new ApiError(400, 'Phone may contain digits, spaces, + ( ) and -');
    const m = mine(req.user), t = now();
    if (!m) {
      const id = Number(db.prepare(`INSERT INTO businesses(owner_id,name,category_id,description,city,address,contact_phone,pricing_info,
        availability_text,accepting_orders,status,created_at,updated_at,lat,lng) VALUES(?,?,?,?,?,?,?,?,?,?,'PENDING',?,?,?,?)`)
        .run(req.user.id, v.name, cat.id, v.description, v.city, v.address, v.phone, v.pricing, v.avail, v.accepting, t, t, geo?.lat ?? null, geo?.lng ?? null).lastInsertRowid);
      audit(req.user, 'business.create', 'business', id);
      return res.status(201).json({ business: present(loadBusiness(id), req.user) });
    }
    const cur = loadBusiness(m.id);
    // Edits to an approved profile stay live; a rejected profile goes back to the review queue when resubmitted.
    const status = cur.status === 'REJECTED' ? 'PENDING' : cur.status;
    db.prepare(`UPDATE businesses SET name=?,category_id=?,description=?,city=?,address=?,contact_phone=?,pricing_info=?,
      availability_text=?,accepting_orders=?,status=?,updated_at=?,lat=?,lng=? WHERE id=?`)
      .run(v.name, cat.id, v.description, v.city, v.address, v.phone, v.pricing, v.avail, v.accepting, status, t, geo?.lat ?? null, geo?.lng ?? null, m.id);
    audit(req.user, 'business.update', 'business', m.id);
    res.json({ business: present(loadBusiness(m.id), req.user) });
  });

  const requireMine = (req) => {
    const m = mine(req.user);
    if (!m) throw new ApiError(409, 'Create your business profile first');
    return m.id;
  };
  const serviceBody = (b) => {
    const price = Number(b.price);
    if (!nz(b.price) || !Number.isFinite(price) || price < 0 || price > 10_000_000) throw new ApiError(400, 'Price must be a number, 0 or more');
    return { title: str(b.title, 'Service title', 2, 100), description: str(b.description, 'Description', 0, 1000), price,
      unit: str(b.price_unit, 'Price unit', 0, 40), available: b.available === undefined ? 1 : flag(b.available) };
  };

  app.post('/api/my/business/services', ...owner, (req, res) => {
    const bid = requireMine(req), s = serviceBody(req.body || {});
    const count = db.prepare('SELECT COUNT(*) n FROM business_services WHERE business_id=?').get(bid).n;
    if (count >= 30) throw new ApiError(400, 'At most 30 services per business');
    const id = Number(db.prepare('INSERT INTO business_services(business_id,title,description,price,price_unit,available,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(bid, s.title, s.description, s.price, s.unit, s.available, now()).lastInsertRowid);
    res.status(201).json({ id });
  });
  app.patch('/api/my/business/services/:id', ...owner, (req, res) => {
    const bid = requireMine(req), id = parseId(req.params.id);
    const cur = db.prepare('SELECT * FROM business_services WHERE id=? AND business_id=?').get(id, bid);
    if (!cur) throw new ApiError(404, 'Service not found');
    const s = serviceBody({ ...cur, ...(req.body || {}) });
    db.prepare('UPDATE business_services SET title=?,description=?,price=?,price_unit=?,available=? WHERE id=?').run(s.title, s.description, s.price, s.unit, s.available, id);
    res.json({ ok: true });
  });
  app.delete('/api/my/business/services/:id', ...owner, (req, res) => {
    const bid = requireMine(req);
    if (!db.prepare('DELETE FROM business_services WHERE id=? AND business_id=?').run(parseId(req.params.id), bid).changes) throw new ApiError(404, 'Service not found');
    res.json({ ok: true });
  });

  app.post('/api/my/business/images', ...owner, upload.array('images', 3), (req, res) => {
    const bid = requireMine(req);
    const imgs = images.prepare(req.files);
    if (!imgs.length) throw new ApiError(400, 'No image supplied');
    if (db.prepare('SELECT COUNT(*) n FROM business_images WHERE business_id=?').get(bid).n + imgs.length > MAX_BUSINESS_IMAGES)
      throw new ApiError(400, `At most ${MAX_BUSINESS_IMAGES} photos per business`);
    const files = images.write(imgs);
    try {
      tx(() => files.forEach((f) => db.prepare('INSERT INTO business_images(business_id,filename,mime,created_at) VALUES(?,?,?,?)').run(bid, f.filename, f.mime, now())));
    } catch (e) { images.unlinkAll(files); throw e; }
    res.status(201).json({ business: present(loadBusiness(bid), req.user) });
  });
  app.delete('/api/my/business/images/:id', ...owner, (req, res) => {
    const bid = requireMine(req);
    const img = db.prepare('SELECT * FROM business_images WHERE id=? AND business_id=?').get(parseId(req.params.id), bid);
    if (!img) throw new ApiError(404, 'Photo not found');
    db.prepare('DELETE FROM business_images WHERE id=?').run(img.id);
    images.unlinkAll([img]);
    res.json({ ok: true });
  });

  // ---------------- inquiries / service requests ----------------
  const loadInquiry = (user, id) => {
    const i = db.prepare(`SELECT q.*, b.name AS business_name, b.owner_id, u.name AS customer_name, s.title AS service_title
      FROM inquiries q JOIN businesses b ON b.id=q.business_id JOIN users u ON u.id=q.customer_id
      LEFT JOIN business_services s ON s.id=q.service_id WHERE q.id=?`).get(parseId(id));
    if (!i || (i.customer_id !== user.id && i.owner_id !== user.id)) throw new ApiError(404, 'Inquiry not found');
    return i;
  };
  const sideOf = (i, user) => (i.owner_id === user.id ? 'owner' : 'customer');
  const presentInquiry = (i, user) => ({
    id: i.id, business_id: i.business_id, business_name: i.business_name, customer_name: i.customer_name, type: i.type,
    status: i.status, service_title: i.service_title, created_at: i.created_at, updated_at: i.updated_at, you_are: sideOf(i, user),
    review: db.prepare('SELECT rating, comment, created_at FROM business_reviews WHERE inquiry_id=?').get(i.id) || null,
    can_review: i.status === 'COMPLETED' && i.customer_id === user.id && !db.prepare('SELECT 1 FROM business_reviews WHERE inquiry_id=?').get(i.id),
    allowed: Object.entries(MOVES[i.status] || {}).filter(([, who]) => who === sideOf(i, user)).map(([to]) => to),
    messages: db.prepare(`SELECT m.id, m.body, m.created_at, m.sender_id = ? AS mine, u.name AS sender FROM inquiry_messages m
      JOIN users u ON u.id=m.sender_id WHERE m.inquiry_id=? ORDER BY m.id`).all(user.id, i.id).map((m) => ({ ...m, mine: !!m.mine })),
  });

  app.post('/api/businesses/:id/inquiries', authn, need('citizen'), needVerified, limits.create, (req, res) => {
    const b = visibleBusiness(req.user, req.params.id);
    if (b.status !== 'APPROVED') throw new ApiError(404, 'Business not found');
    const type = req.body?.type === 'order' ? 'order' : 'inquiry';
    const message = str(req.body?.message, 'Message', 5, 2000);
    if (type === 'order' && !b.accepting_orders) throw new ApiError(409, 'This business is not accepting requests right now. You can still send an inquiry.');
    let serviceId = null;
    if (nz(req.body?.service_id)) {
      const s = db.prepare('SELECT id, available FROM business_services WHERE id=? AND business_id=?').get(Number(req.body.service_id), b.id);
      if (!s) throw new ApiError(400, 'Unknown service');
      if (type === 'order' && !s.available) throw new ApiError(409, 'That service is currently unavailable');
      serviceId = s.id;
    } else if (type === 'order') throw new ApiError(400, 'Choose a service to request');
    const id = tx(() => {
      const t = now();
      const iid = Number(db.prepare('INSERT INTO inquiries(business_id,customer_id,service_id,type,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run(b.id, req.user.id, serviceId, type, t, t).lastInsertRowid);
      db.prepare('INSERT INTO inquiry_messages(inquiry_id,sender_id,body,created_at) VALUES(?,?,?,?)').run(iid, req.user.id, message, t);
      return iid;
    });
    notify(b.owner_id, null, 'inquiry', `New ${type === 'order' ? 'service request' : 'inquiry'} from ${req.user.name} for ${b.name}.`, `#/inquiries/${id}`);
    res.status(201).json({ id });
  });

  app.get('/api/inquiries', authn, need('citizen', 'entrepreneur'), (req, res) => {
    const isOwner = req.user.role === 'entrepreneur';
    const where = [isOwner ? 'b.owner_id = ?' : 'q.customer_id = ?'], p = [req.user.id];
    if (typeof req.query.status === 'string' && MOVES[req.query.status]) { where.push('q.status = ?'); p.push(req.query.status); }
    res.json({ items: db.prepare(`SELECT q.id, q.type, q.status, q.created_at, q.updated_at, b.name AS business_name, u.name AS customer_name, s.title AS service_title,
        (SELECT body FROM inquiry_messages m WHERE m.inquiry_id=q.id ORDER BY m.id DESC LIMIT 1) AS last_message
      FROM inquiries q JOIN businesses b ON b.id=q.business_id JOIN users u ON u.id=q.customer_id
      LEFT JOIN business_services s ON s.id=q.service_id WHERE ${where.join(' AND ')} ORDER BY q.updated_at DESC LIMIT 100`).all(...p) });
  });

  app.get('/api/inquiries/:id', authn, (req, res) => res.json(presentInquiry(loadInquiry(req.user, req.params.id), req.user)));

  app.post('/api/inquiries/:id/messages', authn, (req, res) => {
    const i = loadInquiry(req.user, req.params.id);
    if (finished(i.status)) throw new ApiError(409, 'This conversation is closed');
    const body = str(req.body?.body, 'Message', 1, 2000), t = now(), side = sideOf(i, req.user);
    tx(() => {
      db.prepare('INSERT INTO inquiry_messages(inquiry_id,sender_id,body,created_at) VALUES(?,?,?,?)').run(i.id, req.user.id, body, t);
      db.prepare("UPDATE inquiries SET updated_at=?, status=CASE WHEN status='NEW' AND ?='owner' THEN 'REPLIED' ELSE status END WHERE id=?").run(t, side, i.id);
    });
    notify(side === 'owner' ? i.customer_id : i.owner_id, null, 'message', `New message about ${i.business_name}.`, `#/inquiries/${i.id}`);
    res.status(201).json(presentInquiry(loadInquiry(req.user, i.id), req.user));
  });

  app.post('/api/inquiries/:id/status', authn, (req, res) => {
    const i = loadInquiry(req.user, req.params.id), to = req.body?.to, side = sideOf(i, req.user);
    if (MOVES[i.status]?.[to] !== side) throw new ApiError(409, `Cannot change from ${i.status} to ${String(to).slice(0, 20)}`);
    const r = db.prepare('UPDATE inquiries SET status=?, updated_at=? WHERE id=? AND status=?').run(to, now(), i.id, i.status);
    if (!r.changes) throw new ApiError(409, 'This request was just updated. Reload and try again.');
    notify(side === 'owner' ? i.customer_id : i.owner_id, null, 'inquiry_status', `${i.business_name}: request ${to.toLowerCase()}.`, `#/inquiries/${i.id}`);
    res.json(presentInquiry(loadInquiry(req.user, i.id), req.user));
  });

  // One review per completed request, by the customer who made it.
  app.post('/api/inquiries/:id/review', authn, need('citizen'), (req, res) => {
    const i = loadInquiry(req.user, req.params.id);
    if (i.customer_id !== req.user.id) throw new ApiError(404, 'Inquiry not found');
    if (i.status !== 'COMPLETED') throw new ApiError(409, 'You can rate a business once the request is completed');
    const rating = Number(req.body?.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new ApiError(400, 'Rating must be 1-5');
    const comment = str(req.body?.comment, 'Comment', 0, 1000);
    try {
      db.prepare('INSERT INTO business_reviews(business_id,customer_id,inquiry_id,rating,comment,created_at) VALUES(?,?,?,?,?,?)')
        .run(i.business_id, req.user.id, i.id, rating, comment || null, now());
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new ApiError(409, 'You already rated this request');
      throw e;
    }
    notify(i.owner_id, null, 'review', `${req.user.name} rated ${i.business_name} ${rating}/5.`, '#/my-business');
    res.status(201).json(presentInquiry(loadInquiry(req.user, i.id), req.user));
  });

  // ---------------- complaints ----------------
  app.post('/api/complaints', authn, need('citizen', 'entrepreneur'), needVerified, limits.create, (req, res) => {
    const b = req.body || {};
    let businessId = null;
    if (nz(b.business_id)) {
      const biz = db.prepare('SELECT id FROM businesses WHERE id=?').get(Number(b.business_id));
      if (!biz) throw new ApiError(400, 'Unknown business');
      businessId = biz.id;
    }
    const t = now();
    const id = Number(db.prepare('INSERT INTO complaints(user_id,business_id,subject,body,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(req.user.id, businessId, str(b.subject, 'Subject', 3, 120), str(b.body, 'Details', 10, 2000), t, t).lastInsertRowid);
    for (const a of db.prepare("SELECT id FROM users WHERE role='admin' AND active=1").all())
      notify(a.id, null, 'complaint', `New complaint: ${String(b.subject).slice(0, 60)}`, '#/admin/complaints');
    res.status(201).json({ id });
  });
  app.get('/api/complaints/mine', authn, need('citizen', 'entrepreneur'), (req, res) =>
    res.json({ items: db.prepare(`SELECT c.id, c.subject, c.status, c.admin_note, c.created_at, c.updated_at, b.name AS business_name
      FROM complaints c LEFT JOIN businesses b ON b.id=c.business_id WHERE c.user_id=? ORDER BY c.id DESC LIMIT 100`).all(req.user.id) }));

  // ---------------- guidance / learning content (entrepreneurs and admins) ----------------
  app.get('/api/content', authn, need('entrepreneur', 'admin'), (req, res) => {
    const where = [], p = [];
    if (!(req.user.role === 'admin' && req.query.all === '1')) where.push('published = 1');
    if (['guide', 'marketing', 'learning'].includes(req.query.kind)) { where.push('kind = ?'); p.push(req.query.kind); }
    res.json({ items: db.prepare(`SELECT id, kind, title, body, sort_order, published, updated_at FROM content
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY kind, sort_order, id`).all(...p).map((c) => ({ ...c, published: !!c.published })) });
  });
};
