const { ApiError, hash, str } = require('./util');

const ROLES = ['citizen', 'entrepreneur', 'officer', 'admin'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role,
  department_id: u.department_id ?? null, can_assign: !!u.can_assign, active: !!u.active,
  phone: u.phone ?? null, notify_email: !!u.notify_email, notify_sms: !!u.notify_sms, email_verified: !!u.email_verified,
});

const checkPassword = (p) => {
  if (typeof p !== 'string' || p.length < 8 || p.length > 200) throw new ApiError(400, 'Password must be 8-200 characters');
  return p;
};

// Single place that validates and inserts accounts (registration, admin creation, create-admin script).
function createUser(db, { name, email, password, role = 'citizen', department_id = null, can_assign = 0, email_verified = 0 }) {
  name = str(name, 'Name', 2, 100);
  email = str(email, 'Email', 3, 254).toLowerCase();
  if (!EMAIL.test(email)) throw new ApiError(400, 'A valid email is required');
  checkPassword(password);
  if (!ROLES.includes(role)) throw new ApiError(400, 'Invalid role');
  if (department_id != null && !db.prepare('SELECT 1 FROM departments WHERE id=?').get(department_id))
    throw new ApiError(400, 'Unknown department');
  try {
    const r = db.prepare('INSERT INTO users(name,email,hash,role,department_id,can_assign,created_at,email_verified) VALUES(?,?,?,?,?,?,?,?)')
      .run(name, email, hash(password), role, department_id, can_assign ? 1 : 0, Date.now(), email_verified ? 1 : 0);
    return db.prepare('SELECT * FROM users WHERE id=?').get(Number(r.lastInsertRowid));
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw new ApiError(409, 'Email already registered');
    throw e;
  }
}

module.exports = { ROLES, publicUser, checkPassword, createUser };
