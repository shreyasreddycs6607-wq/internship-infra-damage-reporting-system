const crypto = require('crypto');

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// scrypt, same format as the legacy implementation so existing hashes keep working.
const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
  salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
const check = (pw, h) => {
  const a = Buffer.from(hash(pw, h.split(':')[0]));
  const b = Buffer.from(h);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const str = (v, name, min, max) => {
  if (v != null && typeof v !== 'string') throw new ApiError(400, `${name} must be text`);
  const s = (v ?? '').trim();
  if (s.length < min || s.length > max) throw new ApiError(400, `${name} must be ${min}-${max} characters`);
  return s;
};
const parseId = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new ApiError(404, 'Not found');
  return n;
};

// Never trust client MIME: identify by magic bytes. Only JPEG, PNG, WebP are accepted.
function sniffImage(b) {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: '.png' };
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  return null;
}

// ponytail: in-memory per-process fixed window; use a shared store (Redis) if running multiple instances.
function limiter({ windowMs, max, key = (req) => req.ip }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now(), k = key(req);
    let h = hits.get(k);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(k, h); }
    if (hits.size > 10000) for (const [kk, v] of hits) if (v.reset < now) hits.delete(kk);
    if (++h.n > max) {
      res.set('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests, please try again later' });
    }
    next();
  };
}

// Neutralise spreadsheet formula injection and quote for CSV.
const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

module.exports = { ApiError, hash, check, sha256, str, parseId, sniffImage, limiter, csvCell };
