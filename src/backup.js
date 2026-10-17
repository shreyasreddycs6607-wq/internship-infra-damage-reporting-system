const fs = require('fs');
const path = require('path');

// Consistent point-in-time copy of the live database (VACUUM INTO is safe while the app is running and
// also compacts the file). Keeps the newest `keep` copies. Protects against corruption and mistakes; it lives
// on the same disk, so it is not a substitute for off-site backups.
function backupDb(db, dir, keep = 7) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `data-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  fs.readdirSync(dir).filter((f) => /^data-.*\.db$/.test(f)).sort().reverse().slice(Math.max(keep, 1))
    .forEach((f) => fs.rmSync(path.join(dir, f), { force: true }));
  return file;
}

module.exports = { backupDb };
