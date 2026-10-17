const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { open, tx } = require('./db');
const { ApiError, sha256, limiter } = require('./util');
const makeNotify = require('./notify');
const makeImages = require('./images');
const { makeMailer, makeSms } = require('./channels');

const SESSION_MS = 7 * 864e5;

function createApp(opts = {}) {
  const env = process.env;
  const prod = (opts.env ?? env.NODE_ENV) === 'production';
  const db = opts.db || open(opts.dbFile || env.DB || path.join(__dirname, '..', 'data.db'));
  const uploadDir = path.resolve(opts.uploadDir || env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
  fs.mkdirSync(uploadDir, { recursive: true });
  const tileUrl = opts.tileUrl || env.MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const tileOrigin = new URL(tileUrl.replace(/\{[szxy]\}/g, 'a')).origin;

  const mailer = makeMailer(env, opts.mailer);
  const sms = makeSms(env, opts.sms);
  const appUrl = String(opts.appUrl ?? env.APP_URL ?? '').replace(/\/+$/, '');
  if (mailer && !appUrl) throw new Error('APP_URL must be set when email (SMTP) is configured: it is used for verification and reset links');
  const notify = makeNotify(db, { mailer, sms, appUrl });
  const audit = (user, action, entity, entityId, detail) =>
    db.prepare('INSERT INTO audit_log(user_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?)')
      .run(user?.id ?? null, action, entity ?? null, entityId ?? null, detail ? JSON.stringify(detail) : null, Date.now());

  const off = opts.rateLimit === false;
  const pass = (_q, _s, n) => n();
  const limits = {
    api: off ? pass : limiter({ windowMs: 60e3, max: 300 }),
    login: off ? pass : limiter({ windowMs: 15 * 60e3, max: 10 }),
    register: off ? pass : limiter({ windowMs: 3600e3, max: 10 }),
    create: off ? pass : limiter({ windowMs: 3600e3, max: 20, key: (r) => 'u' + r.user?.id }),
    forgot: off ? pass : limiter({ windowMs: 3600e3, max: 5 }),
    token: off ? pass : limiter({ windowMs: 15 * 60e3, max: 20 }),
    verifyReq: off ? pass : limiter({ windowMs: 3600e3, max: 5, key: (r) => 'v' + r.user?.id }),
  };

  const app = express();
  app.disable('x-powered-by');
  // TRUST_PROXY = number of reverse proxies in front of the app (Render: 1). Wrong values make every visitor look
  // like the proxy's address, which would share one rate-limit bucket.
  const proxyHops = Number(opts.trustProxy ?? env.TRUST_PROXY ?? 0);
  if (proxyHops > 0) app.set('trust proxy', proxyHops);

  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': `default-src 'self'; img-src 'self' data: blob: ${tileOrigin}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY',
    });
    if (prod) res.set('Strict-Transport-Security', 'max-age=15552000');
    next();
  });
  // Liveness/readiness probe for the hosting platform (no auth, touches the database, reveals nothing).
  app.get('/healthz', (_req, res) => { db.prepare('SELECT 1').get(); res.json({ ok: true }); });
  // CSRF: SameSite=Strict cookie plus rejection of cross-origin state-changing requests. No CORS is enabled.
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.headers.origin) return next();
    try { if (new URL(req.headers.origin).host === req.headers.host) return next(); } catch { /* fall through */ }
    res.status(403).json({ error: 'Cross-origin request blocked' });
  });
  app.use(express.json({ limit: '50kb' }));
  app.use('/api', limits.api);

  // ---- sessions -------------------------------------------------------------------------------------
  const cookieOpts = { httpOnly: true, sameSite: 'strict', secure: prod, path: '/' };
  const startSession = (res, userId) => {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(sha256(token), userId, Date.now() + SESSION_MS);
    res.cookie('sid', token, { ...cookieOpts, maxAge: SESSION_MS });
  };
  const sidOf = (req) => /(?:^|;\s*)sid=([\w-]+)/.exec(req.headers.cookie || '')?.[1];
  const authn = (req, _res, next) => {
    const sid = sidOf(req);
    const u = sid && db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`).get(sha256(sid), Date.now());
    if (!u) return next(new ApiError(401, 'Login required'));
    req.user = u;
    next();
  };
  // Like authn but anonymous callers pass through with req.user = null (public browsing).
  const optAuthn = (req, res, next) => authn(req, res, (err) => { if (err) req.user = null; next(); });
  // When email is configured, accounts must confirm their address before reporting/contacting/listing.
  // With no email provider nobody can verify, so nothing is blocked.
  const needVerified = (req, _res, next) =>
    !mailer || req.user.email_verified ? next() : next(new ApiError(403, 'Please verify your email address first. Use the link we emailed you, or request a new one from the banner.'));
  const need = (...roles) => (req, _res, next) =>
    roles.includes(req.user.role) ? next() : next(new ApiError(403, 'Forbidden'));

  const ctx = {
    db, tx: (fn) => tx(db, fn), authn, optAuthn, need, needVerified, appUrl, sendEmail: notify.sendEmail, images: makeImages(uploadDir), audit, notify, limits, uploadDir, startSession, cookieOpts,
    maxUploadBytes: Math.round(Number(opts.maxUploadMb || env.MAX_UPLOAD_MB || 5) * 1048576),
    clearSession: (req, res) => {
      const sid = sidOf(req);
      if (sid) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(sid));
      res.clearCookie('sid', cookieOpts);
    },
    channels: { email: !!mailer, sms: !!sms },
    config: { tile_url: tileUrl, tile_attribution: opts.attribution || env.MAP_ATTRIBUTION || '&copy; OpenStreetMap contributors' },
  };

  require('./routes/auth')(app, ctx);
  require('./routes/reports')(app, ctx);
  require('./routes/admin')(app, ctx);
  require('./routes/business')(app, ctx);
  require('./routes/admin-business')(app, ctx);

  app.use('/vendor/leaflet', express.static(path.join(__dirname, '..', 'node_modules', 'leaflet', 'dist')));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/api', (_req, _res, next) => next(new ApiError(404, 'Not found')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ApiError) return res.status(err.status).json({ error: err.message });
    if (err.name === 'MulterError') return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
      error: err.code === 'LIMIT_FILE_SIZE' ? `Image too large (max ${Math.round(ctx.maxUploadBytes / 1048576)} MB)` : 'Invalid upload' });
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'Invalid request body' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  app.locals.db = db;
  app.locals.flushNotifications = notify.flush;
  return app;
}

module.exports = { createApp };
