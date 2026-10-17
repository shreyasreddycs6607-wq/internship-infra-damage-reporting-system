// KPI definitions (all computed from persisted reports):
//  open                = status not in RESOLVED, CLOSED, REJECTED
//  awaiting_review     = SUBMITTED or UNDER_REVIEW
//  awaiting_assignment = ACCEPTED (accepted, no officer yet)
//  overdue             = open and due_at (created_at + category SLA) is in the past
//  resolved            = RESOLVED or CLOSED
//  avg_resolution_hours= mean(resolved_at - created_at) over resolved reports that have resolved_at; null if none
//  resolution_rate     = resolved / (total - rejected); null if that denominator is 0
function summary(db, scope, now) {
  const q = (sql, ...extra) => db.prepare(sql.replaceAll('{S}', scope.sql)).all(...extra, ...scope.params);
  const c = q(`SELECT
      COUNT(*) total,
      SUM(r.status NOT IN ('RESOLVED','CLOSED','REJECTED')) open,
      SUM(r.status IN ('SUBMITTED','UNDER_REVIEW')) awaiting_review,
      SUM(r.status = 'ACCEPTED') awaiting_assignment,
      SUM(r.status IN ('ASSIGNED','IN_PROGRESS')) in_progress,
      SUM(r.status IN ('RESOLVED','CLOSED')) resolved,
      SUM(r.status = 'REJECTED') rejected,
      SUM(r.status NOT IN ('RESOLVED','CLOSED','REJECTED') AND r.due_at < ?) overdue,
      AVG(CASE WHEN r.status IN ('RESOLVED','CLOSED') AND r.resolved_at IS NOT NULL THEN (r.resolved_at - r.created_at) / 3600000.0 END) avg_h
    FROM reports r WHERE {S}`, now)[0];
  const n = (v) => v ?? 0;
  const denom = n(c.total) - n(c.rejected);
  return {
    total: n(c.total), open: n(c.open), awaiting_review: n(c.awaiting_review), awaiting_assignment: n(c.awaiting_assignment),
    in_progress: n(c.in_progress), resolved: n(c.resolved), rejected: n(c.rejected), overdue: n(c.overdue),
    avg_resolution_hours: c.avg_h ?? null,
    resolution_rate: denom > 0 ? n(c.resolved) / denom : null,
    by_category: q(`SELECT cat.name AS category, COUNT(*) AS n FROM reports r JOIN categories cat ON cat.id = r.category_id
      WHERE {S} GROUP BY cat.id ORDER BY n DESC`),
    by_priority: q(`SELECT r.priority, COUNT(*) AS n FROM reports r
      WHERE {S} AND r.status NOT IN ('RESOLVED','CLOSED','REJECTED') GROUP BY r.priority`),
  };
}

function adminAnalytics(db, now) {
  const scope = { sql: '1=1', params: [] };
  return {
    ...summary(db, scope, now),
    // ~1.1 km grid cells (0.01 degree). Reports without coordinates are excluded.
    by_area: db.prepare(`SELECT ROUND(lat, 2) AS lat, ROUND(lng, 2) AS lng, COUNT(*) AS n FROM reports
      WHERE lat IS NOT NULL GROUP BY 1, 2 ORDER BY n DESC LIMIT 20`).all(),
    // Repeat = 2+ reports of the same category in the same ~110 m cell (0.001 degree). Approximate: pairs
    // straddling a cell edge are missed. Rejected reports are ignored.
    repeated_locations: db.prepare(`SELECT cat.name AS category, ROUND(r.lat, 3) AS lat, ROUND(r.lng, 3) AS lng, COUNT(*) AS n
      FROM reports r JOIN categories cat ON cat.id = r.category_id
      WHERE r.lat IS NOT NULL AND r.status != 'REJECTED' GROUP BY r.category_id, 2, 3 HAVING n > 1 ORDER BY n DESC LIMIT 20`).all(),
    workload: db.prepare(`SELECT u.id, u.name, d.name AS department, COUNT(r.id) AS open,
        COALESCE(SUM(r.due_at < ?), 0) AS overdue
      FROM users u LEFT JOIN departments d ON d.id = u.department_id
      LEFT JOIN reports r ON r.assigned_to_id = u.id AND r.status NOT IN ('RESOLVED','CLOSED','REJECTED')
      WHERE u.role = 'officer' AND u.active = 1 GROUP BY u.id ORDER BY open DESC`).all(now),
    feedback: db.prepare('SELECT COUNT(*) AS n, AVG(rating) AS avg FROM feedback').get(),
    platform: platformStats(db),
  };
}

// Marketplace / platform activity, straight counts from the tables.
function platformStats(db) {
  const by = (table, col) => Object.fromEntries(db.prepare(`SELECT ${col} AS k, COUNT(*) AS n FROM ${table} GROUP BY ${col}`).all().map((r) => [r.k, r.n]));
  return {
    users_by_role: by('users', 'role'),
    businesses_by_status: by('businesses', 'status'),
    businesses_by_category: db.prepare(`SELECT c.name AS category, COUNT(b.id) AS n FROM business_categories c
      LEFT JOIN businesses b ON b.category_id=c.id AND b.status='APPROVED' GROUP BY c.id ORDER BY n DESC, c.name`).all(),
    inquiries_by_status: by('inquiries', 'status'),
    complaints_by_status: by('complaints', 'status'),
  };
}

module.exports = { summary, adminAnalytics };
