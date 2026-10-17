const crypto = require('crypto');
const { ApiError, check, hash, str, parseId, sha256 } = require('../util');
const { createUser, publicUser, checkPassword } = require('../users');
const { STATUSES, PRIORITIES } = require('../workflow');

// Verified against when the email is unknown so response time doesn't reveal which accounts exist.
const DUMMY_HASH = hash('not-a-real-password');

const TTL = { verify: 24 * 3600e3, reset: 3600e3 };

module.exports = (app, { db, authn, limits, startSession, clearSession, config, channels, sendEmail, appUrl }) => {
  // ---- one-time tokens: random, only the hash is stored, single use, short life ----
  const issueToken = (userId, purpose) => {
    db.prepare('DELETE FROM user_tokens WHERE expires_at < ?').run(Date.now());
    db.prepare('DELETE FROM user_tokens WHERE user_id = ? AND purpose = ?').run(userId, purpose); // newest link wins
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO user_tokens(token_hash,user_id,purpose,expires_at,created_at) VALUES(?,?,?,?,?)')
      .run(sha256(token), userId, purpose, Date.now() + TTL[purpose], Date.now());
    return token;
  };
  const findToken = (token, purpose) => {
    const row = typeof token === 'string' && /^[\w-]{20,100}$/.test(token) && db.prepare('SELECT * FROM user_tokens WHERE token_hash=? AND purpose=?').get(sha256(token), purpose);
    if (!row || row.expires_at < Date.now()) throw new ApiError(400, 'This link is invalid or has expired. Please request a new one.');
    return row;
  };
  const sendVerification = (user) => sendEmail(user.email, 'Verify your email address',
    `Hello ${user.name},\n\nPlease confirm your email address:\n${appUrl}/#/verify?token=${issueToken(user.id, 'verify')}\n\nThis link works for 24 hours. If you did not create an account, you can ignore this message.`);

  app.get('/api/meta', (_req, res) => res.json({
    categories: db.prepare('SELECT id, name FROM categories WHERE active=1 ORDER BY name').all(),
    statuses: STATUSES, priorities: PRIORITIES, map: config, channels,
  }));

  app.post('/api/auth/register', limits.register, (req, res) => {
    const { name, email, password, role } = req.body || {};
    // Only these two self-service roles exist; anything else (e.g. admin) silently becomes citizen.
    const user = createUser(db, { name, email, password, role: role === 'entrepreneur' ? 'entrepreneur' : 'citizen' });
    startSession(res, user.id);
    if (channels.email) sendVerification(user);
    res.status(201).json({ user: publicUser(user) });
  });

  app.post('/api/auth/login', limits.login, (req, res) => {
    const { email, password } = req.body || {};
    const u = typeof email === 'string' ? db.prepare('SELECT * FROM users WHERE email=?').get(email.trim().toLowerCase()) : null;
    const ok = check(typeof password === 'string' ? password : '', u ? u.hash : DUMMY_HASH);
    if (!u || !ok || !u.active) throw new ApiError(401, 'Invalid email or password');
    startSession(res, u.id);
    res.json({ user: publicUser(u) });
  });

  // ---- email verification ----
  app.post('/api/auth/verify/request', authn, limits.verifyReq, (req, res) => {
    if (!channels.email) throw new ApiError(409, 'Email is not enabled on this server');
    if (req.user.email_verified) throw new ApiError(409, 'Your email address is already verified');
    sendVerification(req.user);
    res.json({ ok: true });
  });
  app.post('/api/auth/verify', limits.token, (req, res) => {
    const row = findToken(req.body?.token, 'verify');
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(row.user_id);
    db.prepare("DELETE FROM user_tokens WHERE user_id = ? AND purpose = 'verify'").run(row.user_id);
    res.json({ ok: true });
  });

  // ---- password reset (by email only; otherwise an administrator sets a temporary password) ----
  app.post('/api/auth/forgot', limits.forgot, (req, res) => {
    if (!channels.email) throw new ApiError(503, 'Password reset by email is not available on this server. Please ask an administrator to reset your password.');
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const u = email && db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
    if (u) sendEmail(u.email, 'Reset your password',
      `Hello ${u.name},\n\nSomeone asked to reset the password for this account. If it was you, choose a new password here:\n${appUrl}/#/reset?token=${issueToken(u.id, 'reset')}\n\nThis link works for 1 hour and can be used once. If you did not ask for this, ignore this message; your password has not changed.`);
    res.json({ ok: true, message: 'If that email address is registered, a reset link has been sent.' }); // identical either way
  });
  app.post('/api/auth/reset', limits.token, (req, res) => {
    const row = findToken(req.body?.token, 'reset');
    const pw = checkPassword(req.body?.password); // validated before the token is spent
    db.prepare('UPDATE users SET hash = ?, email_verified = 1 WHERE id = ?').run(hash(pw), row.user_id); // proving mailbox access also verifies it
    db.prepare('DELETE FROM user_tokens WHERE user_id = ?').run(row.user_id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id); // sign out everywhere
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', (req, res) => { clearSession(req, res); res.json({ ok: true }); });

  app.get('/api/auth/me', authn, (req, res) => res.json({ user: publicUser(req.user) }));

  app.patch('/api/auth/me', authn, (req, res) => {
    const { name, current_password, new_password, phone, notify_email, notify_sms } = req.body || {};
    if (phone !== undefined || notify_email !== undefined || notify_sms !== undefined) {
      let p = phone === undefined ? req.user.phone : (phone === null || phone === '' ? null : String(phone).replace(/[\s()-]/g, ''));
      if (p && !/^\+[1-9][0-9]{7,14}$/.test(p)) throw new ApiError(400, 'Phone must be in international format, e.g. +919876543210');
      const sm = notify_sms === undefined ? req.user.notify_sms : (notify_sms ? 1 : 0);
      if (sm && !p) throw new ApiError(400, 'Add a mobile number to receive text messages');
      db.prepare('UPDATE users SET phone=?, notify_email=?, notify_sms=? WHERE id=?')
        .run(p, notify_email === undefined ? req.user.notify_email : (notify_email ? 1 : 0), sm, req.user.id);
    }
    if (name !== undefined) db.prepare('UPDATE users SET name=? WHERE id=?').run(str(name, 'Name', 2, 100), req.user.id);
    if (new_password !== undefined) {
      checkPassword(new_password);
      if (typeof current_password !== 'string' || !check(current_password, req.user.hash))
        throw new ApiError(403, 'Current password is incorrect');
      db.prepare('UPDATE users SET hash=? WHERE id=?').run(hash(new_password), req.user.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.user.id); // invalidate every session
      startSession(res, req.user.id);
    }
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)) });
  });

  // ---- in-app notifications ----
  app.get('/api/notifications', authn, (req, res) => {
    res.json({
      unread: db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL AND channel='in_app'").get(req.user.id).n,
      items: db.prepare(`SELECT n.id, n.report_id, n.link, n.type, n.message, n.read_at, n.created_at, r.tracking_no
        FROM notifications n LEFT JOIN reports r ON r.id = n.report_id
        WHERE n.user_id=? AND n.channel='in_app' ORDER BY n.id DESC LIMIT 50`).all(req.user.id),
    });
  });
  app.post('/api/notifications/read-all', authn, (req, res) => {
    db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(Date.now(), req.user.id);
    res.json({ ok: true });
  });
  app.post('/api/notifications/:id/read', authn, (req, res) => {
    db.prepare('UPDATE notifications SET read_at=? WHERE id=? AND user_id=? AND read_at IS NULL')
      .run(Date.now(), parseId(req.params.id), req.user.id);
    res.json({ ok: true });
  });
};
