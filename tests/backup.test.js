const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { backupDb } = require('../src/backup');
const { open } = require('../src/db');
const { createUser } = require('../src/users');
const { boot } = require('./helpers');

test('backup is a complete, openable copy and old copies are pruned', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idr-bak-'));
  const db = open(path.join(dir, 'live.db'));
  createUser(db, { name: 'Backup Person', email: 'b@x.test', password: 'password123' });
  const first = backupDb(db, path.join(dir, 'backups'), 2);
  const copy = new DatabaseSync(first);
  assert.equal(copy.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
  assert.equal(copy.prepare('PRAGMA user_version').get().user_version, db.prepare('PRAGMA user_version').get().user_version);
  assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  copy.close();
  const second = backupDb(db, path.join(dir, 'backups'), 2);
  const third = backupDb(db, path.join(dir, 'backups'), 2);
  const left = fs.readdirSync(path.join(dir, 'backups')).sort();
  assert.equal(left.length, 2); // keep=2
  assert.ok(!left.includes(path.basename(first)));
  assert.ok(left.includes(path.basename(third)) && left.includes(path.basename(second)));
  // unrelated files in the folder are never deleted
  fs.writeFileSync(path.join(dir, 'backups', 'notes.txt'), 'keep me');
  backupDb(db, path.join(dir, 'backups'), 1);
  assert.ok(fs.existsSync(path.join(dir, 'backups', 'notes.txt')));
});

test('health check answers without logging in and reports a working database', async () => {
  const t = await boot();
  try {
    const r = await t.client().get('/healthz');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { ok: true });
  } finally { t.close(); }
});

test('behind one proxy, rate limits key on the proxy-added address and spoofed headers cannot dodge them', async () => {
  const t = await boot({ trustProxy: 1, rateLimit: true });
  try {
    const login = async (xff) => (await fetch(t.base + '/api/auth/login', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': xff }, body: JSON.stringify({ email: 'a@b.co', password: 'wrong-password' }) })).status;
    // The proxy appends the real client address as the LAST entry; anything before it is client-supplied.
    for (let i = 0; i < 10; i++) assert.equal(await login(`10.0.0.${i}, 198.51.100.7`), 401); // spoofed prefixes differ each time
    assert.equal(await login('10.9.9.9, 198.51.100.7'), 429); // still the same visitor
    assert.equal(await login('10.0.0.1, 198.51.100.8'), 401); // a different visitor is unaffected
  } finally { t.close(); }
});
