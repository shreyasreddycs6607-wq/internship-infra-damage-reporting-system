const { DatabaseSync } = require('node:sqlite');
const { check } = require('./util');

const CATEGORIES = [
  ['Road Damage / Pothole', 72], ['Broken Streetlight', 72], ['Water Leak', 48],
  ['Damaged Footpath', 120], ['Open Drain', 72], ['Drainage Damage', 96], ['Other', 120],
];

// Ordered, append-only. PRAGMA user_version records how many have run. Never edit an applied migration.
const migrations = [
  // 1: legacy baseline (what the original server.js created). IF NOT EXISTS keeps existing data untouched.
  (db) => db.exec(`
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT, email TEXT UNIQUE, hash TEXT, role TEXT DEFAULT 'citizen');
    CREATE TABLE IF NOT EXISTS issues(
      id INTEGER PRIMARY KEY, user_id INTEGER, category TEXT, description TEXT,
      lat REAL, lng REAL, address TEXT, image TEXT, status TEXT DEFAULT 'Reported',
      assigned_to TEXT, rating INTEGER, created_at INTEGER, resolved_at INTEGER);`),

  // 2: full domain schema. Legacy `issues` rows are copied into `reports`, then the old table is dropped.
  (db) => {
    db.exec(`
    CREATE TABLE departments(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE categories(
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      department_id INTEGER REFERENCES departments(id),
      sla_hours INTEGER NOT NULL DEFAULT 72 CHECK(sla_hours > 0), active INTEGER NOT NULL DEFAULT 1);
    ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE users ADD COLUMN department_id INTEGER REFERENCES departments(id);
    ALTER TABLE users ADD COLUMN can_assign INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN created_at INTEGER;
    UPDATE users SET created_at = ${Date.now()};
    CREATE TABLE sessions(
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL);
    CREATE INDEX idx_sessions_user ON sessions(user_id);
    CREATE TABLE reports(
      id INTEGER PRIMARY KEY, tracking_no TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      category_id INTEGER NOT NULL REFERENCES categories(id),
      department_id INTEGER REFERENCES departments(id),
      title TEXT NOT NULL, description TEXT NOT NULL,
      lat REAL CHECK(lat BETWEEN -90 AND 90), lng REAL CHECK(lng BETWEEN -180 AND 180),
      address TEXT NOT NULL DEFAULT '',
      location_source TEXT NOT NULL DEFAULT 'manual' CHECK(location_source IN ('device','map','manual')),
      status TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK(status IN ('SUBMITTED','UNDER_REVIEW','ACCEPTED','REJECTED','ASSIGNED','IN_PROGRESS','RESOLVED','REOPENED','CLOSED')),
      priority TEXT NOT NULL DEFAULT 'MEDIUM' CHECK(priority IN ('LOW','MEDIUM','HIGH','CRITICAL')),
      assigned_to_id INTEGER REFERENCES users(id),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, due_at INTEGER NOT NULL,
      resolved_at INTEGER, resolution_note TEXT);
    CREATE INDEX idx_reports_user ON reports(user_id);
    CREATE INDEX idx_reports_status ON reports(status);
    CREATE INDEX idx_reports_assignee ON reports(assigned_to_id);
    CREATE INDEX idx_reports_dept ON reports(department_id);
    CREATE INDEX idx_reports_category ON reports(category_id);
    CREATE INDEX idx_reports_created ON reports(created_at);
    CREATE INDEX idx_reports_due ON reports(due_at);
    CREATE TABLE report_images(
      id INTEGER PRIMARY KEY, report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('report','resolution')),
      filename TEXT NOT NULL, mime TEXT NOT NULL, uploaded_by INTEGER REFERENCES users(id), created_at INTEGER NOT NULL);
    CREATE INDEX idx_images_report ON report_images(report_id);
    -- One timeline table: status changes, assignments, remarks, priority changes, edits.
    CREATE TABLE report_events(
      id INTEGER PRIMARY KEY, report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('status','assign','remark','priority','edit')),
      from_value TEXT, to_value TEXT, note TEXT,
      visibility TEXT NOT NULL DEFAULT 'internal' CHECK(visibility IN ('internal','public')),
      user_id INTEGER REFERENCES users(id), created_at INTEGER NOT NULL);
    CREATE INDEX idx_events_report ON report_events(report_id);
    CREATE TABLE feedback(
      report_id INTEGER PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5), comment TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE notifications(
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      report_id INTEGER REFERENCES reports(id) ON DELETE CASCADE,
      type TEXT NOT NULL, message TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'in_app', status TEXT NOT NULL DEFAULT 'delivered', error TEXT,
      read_at INTEGER, created_at INTEGER NOT NULL);
    CREATE INDEX idx_notif_user ON notifications(user_id, read_at);
    CREATE TABLE audit_log(
      id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), action TEXT NOT NULL,
      entity TEXT, entity_id INTEGER, detail TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX idx_audit_created ON audit_log(created_at);`);

    const addCat = db.prepare('INSERT INTO categories(name, sla_hours) VALUES(?, ?)');
    for (const [n, h] of CATEGORIES) addCat.run(n, h);

    // Copy legacy data (no-op on a fresh database).
    db.exec(`
    INSERT INTO reports(id,tracking_no,user_id,category_id,title,description,lat,lng,address,location_source,
        status,priority,created_at,updated_at,due_at,resolved_at)
      SELECT i.id, 'IDR-'||strftime('%Y', COALESCE(i.created_at,0)/1000, 'unixepoch')||'-L'||printf('%05d', i.id), i.user_id,
        COALESCE((SELECT id FROM categories WHERE name = CASE i.category WHEN 'Pothole' THEN 'Road Damage / Pothole' ELSE i.category END),
                 (SELECT id FROM categories WHERE name='Other')),
        substr(COALESCE(i.description,'(no description)'),1,80), COALESCE(i.description,'(no description)'),
        i.lat, i.lng, COALESCE(i.address,''), 'manual',
        CASE i.status WHEN 'Assigned' THEN 'ACCEPTED' WHEN 'In Progress' THEN 'IN_PROGRESS' WHEN 'Resolved' THEN 'RESOLVED' ELSE 'SUBMITTED' END,
        'MEDIUM', COALESCE(i.created_at,0), COALESCE(i.resolved_at, i.created_at, 0), COALESCE(i.created_at,0)+72*3600000, i.resolved_at
      FROM issues i WHERE i.user_id IN (SELECT id FROM users);
    INSERT INTO report_events(report_id,type,to_value,note,visibility,created_at)
      SELECT id,'status',status,'Migrated from the legacy system','public',created_at FROM reports;
    INSERT INTO report_events(report_id,type,note,visibility,created_at)
      SELECT id,'remark','Legacy assignee (free text): '||assigned_to,'internal',created_at FROM issues
      WHERE assigned_to IS NOT NULL AND assigned_to != '' AND id IN (SELECT id FROM reports);
    INSERT INTO report_images(report_id,kind,filename,mime,created_at)
      SELECT id,'report',image,
        CASE lower(substr(image, -4)) WHEN '.png' THEN 'image/png' WHEN '.jpg' THEN 'image/jpeg' WHEN 'jpeg' THEN 'image/jpeg' WHEN 'webp' THEN 'image/webp' ELSE 'application/octet-stream' END,
        COALESCE(created_at,0)
      FROM issues WHERE image IS NOT NULL AND image != '' AND id IN (SELECT id FROM reports);
    INSERT INTO feedback(report_id,user_id,rating,created_at)
      SELECT id,user_id,rating,COALESCE(resolved_at,created_at,0) FROM issues
      WHERE rating BETWEEN 1 AND 5 AND id IN (SELECT id FROM reports);
    DROP TABLE issues;`);

    // The old code seeded authority/admin123 and printed it. Never leave that login usable.
    for (const u of db.prepare("SELECT id, hash FROM users WHERE role='authority'").all())
      if (check('admin123', u.hash)) db.prepare('UPDATE users SET active=0 WHERE id=?').run(u.id);
    db.exec("UPDATE users SET role='admin' WHERE role='authority'");
  },

  // 3: women-entrepreneur marketplace (profiles, services, inquiries, complaints, guidance content).
  (db) => {
    db.exec(`
    CREATE TABLE business_categories(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE businesses(
      id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
      name TEXT NOT NULL, category_id INTEGER NOT NULL REFERENCES business_categories(id),
      description TEXT NOT NULL, city TEXT NOT NULL, address TEXT NOT NULL DEFAULT '',
      contact_phone TEXT NOT NULL DEFAULT '', pricing_info TEXT NOT NULL DEFAULT '',
      availability_text TEXT NOT NULL DEFAULT '', accepting_orders INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED','SUSPENDED')),
      review_note TEXT, reviewed_by INTEGER REFERENCES users(id), reviewed_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX idx_biz_status ON businesses(status, category_id);
    CREATE INDEX idx_biz_city ON businesses(city);
    CREATE TABLE business_services(
      id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', price REAL NOT NULL CHECK(price >= 0),
      price_unit TEXT NOT NULL DEFAULT '', available INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
    CREATE INDEX idx_services_biz ON business_services(business_id);
    CREATE TABLE business_images(
      id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      filename TEXT NOT NULL, mime TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX idx_bimages_biz ON business_images(business_id);
    CREATE TABLE inquiries(
      id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      customer_id INTEGER NOT NULL REFERENCES users(id),
      service_id INTEGER REFERENCES business_services(id) ON DELETE SET NULL,
      type TEXT NOT NULL CHECK(type IN ('inquiry','order')),
      status TEXT NOT NULL DEFAULT 'NEW' CHECK(status IN ('NEW','REPLIED','ACCEPTED','DECLINED','COMPLETED','CANCELLED')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX idx_inq_biz ON inquiries(business_id);
    CREATE INDEX idx_inq_customer ON inquiries(customer_id);
    CREATE TABLE inquiry_messages(
      id INTEGER PRIMARY KEY, inquiry_id INTEGER NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
      sender_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX idx_inqmsg_inq ON inquiry_messages(inquiry_id);
    CREATE TABLE complaints(
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      business_id INTEGER REFERENCES businesses(id) ON DELETE SET NULL,
      subject TEXT NOT NULL, body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','IN_REVIEW','RESOLVED','DISMISSED')),
      admin_note TEXT, handled_by INTEGER REFERENCES users(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX idx_complaints_status ON complaints(status);
    CREATE TABLE content(
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('guide','marketing','learning')),
      title TEXT NOT NULL, body TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
      published INTEGER NOT NULL DEFAULT 1, created_by INTEGER REFERENCES users(id),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    ALTER TABLE notifications ADD COLUMN link TEXT;`);

    const cat = db.prepare('INSERT INTO business_categories(name) VALUES(?)');
    for (const n of ['Tiffin / Home Food Service', 'Tailoring & Stitching', 'Beauty & Personal Care Services', 'Handicrafts & Handmade Products']) cat.run(n);

    // Starter guidance. General, not legal advice; admins are expected to localise it (Admin → Content).
    const t = Date.now();
    const ins = db.prepare('INSERT INTO content(kind,title,body,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?)');
    for (const [i, [kind, title, body]] of SEED_CONTENT.entries()) ins.run(kind, title, body, i, t, t);
  },

  // 4: email/SMS preferences, approximate business location (radius search), business reviews.
  (db) => db.exec(`
    ALTER TABLE users ADD COLUMN phone TEXT;
    ALTER TABLE users ADD COLUMN notify_email INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE users ADD COLUMN notify_sms INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE businesses ADD COLUMN lat REAL CHECK(lat BETWEEN -90 AND 90);
    ALTER TABLE businesses ADD COLUMN lng REAL CHECK(lng BETWEEN -180 AND 180);
    CREATE INDEX idx_biz_geo ON businesses(lat, lng);
    -- One review per completed inquiry/request, so only real customers of that business can rate it.
    CREATE TABLE business_reviews(
      id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      customer_id INTEGER NOT NULL REFERENCES users(id),
      inquiry_id INTEGER NOT NULL UNIQUE REFERENCES inquiries(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5), comment TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX idx_reviews_biz ON business_reviews(business_id);`),

  // 5: email verification and one-time tokens (verify / password reset). Only a SHA-256 of each token is stored.
  (db) => db.exec(`
    ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
    UPDATE users SET email_verified = 1 WHERE role IN ('admin','officer'); -- staff were vetted by an administrator
    CREATE TABLE user_tokens(
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK(purpose IN ('verify','reset')), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX idx_tokens_user ON user_tokens(user_id, purpose);`),
];

const SEED_CONTENT = [
  ['guide', 'Step 1: Plan your home business', `Start with one clear offer. Decide what you will sell, who your first 10 customers are, and how far you can deliver or travel.
Write down your weekly capacity: how many orders or appointments you can handle without lowering quality.
- Choose one or two services to begin with.
- Ask 5 to 10 people what they would pay for it.
- Decide your working days and hours and publish them on your profile.`],
  ['guide', 'Step 2: Pricing strategies', `A price must cover your costs, pay you for your time, and leave a profit.
- Cost-plus: add up material, packaging, transport and your labour for one unit, then add a margin (many home businesses aim for 20 to 40 percent).
- Market check: compare with 3 similar sellers nearby. Do not copy them blindly; your costs differ.
- Bundles and tiers: offer a basic and a premium version, or a weekly tiffin plan at a small discount.
- Review prices every few months as ingredient and material costs change.
Use the Cost and profit calculator in this section to test a price before you publish it.`],
  ['guide', 'Step 3: Basic licensing and compliance (general information)', `Rules differ by country, state and city, and they change. This is a checklist of things to ask about, not legal advice. Confirm current requirements with your local municipal office or a local small-business support centre.
- Business registration: whether a home business needs a trade, shop or small-enterprise registration where you live.
- Food (tiffin, home food): food-safety registration or licence, hygiene standards, labelling and allergen information. In India this is usually handled through the food-safety authority's registration or licence for food businesses.
- Tax: whether your turnover requires tax registration, and how to keep simple sales records.
- Premises: whether running a business from your home is allowed by your housing society, lease or local zoning.
- Personal care and beauty: hygiene and sterilisation practices, product safety, and any local permit for providing services.
Keep copies of every registration and record your income and expenses from day one.`],
  ['guide', 'Step 4: Cost estimation and profit planning', `Separate your costs into two groups.
- Fixed costs per month: rent share, equipment, phone and internet, licences, marketing.
- Variable costs per unit: ingredients or materials, packaging, delivery, payment fees.
Break-even units = monthly fixed costs divided by (price minus variable cost per unit). Below that number you lose money; above it you profit.
Pay yourself: include a fair value for your own time, otherwise the business only looks profitable.
Plan for slow weeks by keeping a small cash reserve of one to two months of fixed costs.`],
  ['marketing', 'Marketing tip: build trust with good photos and clear details', `Customers choose people they trust.
- Upload clear, bright photos of your real work, not stock images.
- Write exact prices, serving sizes or timings, and what is included.
- Reply to inquiries within a few hours; fast answers win orders.
- Ask happy customers to recommend you to friends and neighbours.`],
  ['marketing', 'Marketing tip: use your local community', `Most home businesses grow through word of mouth.
- Tell neighbours, housing groups and local community messaging groups what you offer.
- Offer a small first-order discount or a sample.
- Keep a regular schedule, for example fresh tiffins every weekday, so people can plan around you.
- Share before-and-after photos of tailoring, beauty or handmade work (with the customer's permission).`],
  ['learning', 'Learning: keep simple records', `Write down every sale and every expense. A notebook or a basic spreadsheet is enough.
At the end of each month calculate: total income, total costs, profit, and your best-selling item.
These four numbers tell you what to make more of, and they are what banks and schemes ask for if you later want a loan or a grant.`],
  ['learning', 'Learning: growing without losing quality', `Grow in small steps.
- Raise prices slightly before you are overbooked.
- Add one new service at a time and test it with a few customers.
- Write down your recipes, measurements or patterns so a helper can follow them later.
- Protect your time: set order cut-off times and a limit per day.`],
];

function migrate(db) {
  let v = db.prepare('PRAGMA user_version').get().user_version;
  for (; v < migrations.length; v++) {
    db.exec('BEGIN');
    try {
      migrations[v](db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}

function open(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

const tx = (db, fn) => {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
};

module.exports = { open, migrate, tx };
