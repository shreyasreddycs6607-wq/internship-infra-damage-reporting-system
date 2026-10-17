const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ApiError, sniffImage } = require('./util');

// Shared by report photos and business photos. Validate first (magic bytes), write second, so a rejected
// upload never touches disk.
module.exports = (uploadDir) => ({
  prepare: (files) => (files || []).map((f) => {
    const t = sniffImage(f.buffer);
    if (!t) throw new ApiError(400, 'Only JPEG, PNG or WebP images are accepted');
    return { buf: f.buffer, ...t };
  }),
  write: (imgs) => imgs.map((i) => {
    const filename = crypto.randomUUID() + i.ext; // server-chosen name; the client filename is discarded
    fs.writeFileSync(path.join(uploadDir, filename), i.buf);
    return { filename, mime: i.mime };
  }),
  unlinkAll: (files) => files.forEach((f) => fs.rm(path.join(uploadDir, f.filename), { force: true }, () => {})),
  send: (res, img) => {
    const safe = ['image/jpeg', 'image/png', 'image/webp'].includes(img.mime);
    res.set({
      'Content-Type': safe ? img.mime : 'application/octet-stream',
      'Content-Disposition': safe ? 'inline' : 'attachment',
    });
    res.sendFile(path.join(uploadDir, path.basename(img.filename)), (err) => { if (err && !res.headersSent) res.status(404).json({ error: 'Not found' }); });
  },
});
