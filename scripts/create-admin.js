// Creates the first administrator. The password comes from the environment so it never lands in shell
// history flags or source control. Usage (PowerShell):
//   $env:ADMIN_EMAIL='a@city.gov'; $env:ADMIN_PASSWORD='...'; npm run create-admin
const path = require('path');
const { open } = require('../src/db');
const { createUser } = require('../src/users');

const { ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD } = process.env;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD (and optionally ADMIN_NAME) in the environment.');
  process.exit(1);
}
const db = open(process.env.DB || path.join(__dirname, '..', 'data.db'));
try {
  const u = createUser(db, { name: ADMIN_NAME || 'Administrator', email: ADMIN_EMAIL, password: ADMIN_PASSWORD, role: 'admin', email_verified: 1 });
  console.log(`Administrator created: ${u.email}`);
} catch (e) { console.error(e.message); process.exit(1); }
