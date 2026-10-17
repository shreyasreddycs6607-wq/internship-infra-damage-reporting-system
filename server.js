const { createApp } = require('./src/app');
const { backupDb } = require('./src/backup');

const port = process.env.PORT || 3000;
const app = createApp();
const server = app.listen(port, () => console.log('http://localhost:' + port));

// Optional daily database snapshot (set BACKUP_DIR, e.g. a folder on the persistent disk).
if (process.env.BACKUP_DIR) {
  const run = () => {
    try { console.log('backup written:', backupDb(app.locals.db, process.env.BACKUP_DIR, Number(process.env.BACKUP_KEEP || 7))); }
    catch (e) { console.error('backup failed:', e.message); }
  };
  setTimeout(run, 60e3).unref(); // first copy a minute after start, then daily
  setInterval(run, 24 * 3600e3).unref();
}

// Render stops the old instance with SIGTERM on every deploy: let in-flight emails/SMS finish first.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    setTimeout(() => process.exit(0), 8000).unref();
    server.close();
    await app.locals.flushNotifications();
    process.exit(0);
  });
}
