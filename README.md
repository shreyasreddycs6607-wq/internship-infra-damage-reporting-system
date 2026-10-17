# Public Infrastructure Damage Reporting System

**Live demo:** https://internship-infra-damage-reporting-system.onrender.com/  ·  **Status and requirement coverage:** [PROGRESS.md](PROGRESS.md)  ·  **Deployment guide:** [DEPLOY.md](DEPLOY.md)

Two parts in one web app, as specified in the project description:

1. **Infrastructure damage reporting** – citizens report potholes, streetlights, leaks, footpaths, drains…;
   officers work the reports through a validated workflow; administrators manage people, departments,
   categories and oversight.
2. **Women-led home-business platform** – entrepreneurs create a business profile (category, services, prices,
   photos, availability) and get step-by-step guidance; customers browse **verified** businesses, search/filter,
   send inquiries and service requests and message the owner; administrators approve profiles, manage business
   categories and learning content, and handle complaints.

One Node process serves the JSON API and the web app.

* **Stack:** Node ≥ 22.13 (built-in `node:sqlite`), Express 4, Multer, Leaflet 1.9.4 (served locally). Plain
  JavaScript, no build step. Runtime dependencies: `express`, `multer`, `nodemailer`, `leaflet`.
* **Status of this build:** see [PROGRESS.md](PROGRESS.md) for what is done, verified, and still open.

## Run it

```bash
npm install
npm test                                  # 68 automated tests
# one-time: create the first administrator (password is read from the environment, never hardcoded)
ADMIN_EMAIL=you@city.gov ADMIN_NAME="Your Name" ADMIN_PASSWORD='choose-a-long-passphrase' npm run create-admin
npm start                                 # http://localhost:3000
```

PowerShell: `$env:ADMIN_EMAIL='you@city.gov'; $env:ADMIN_PASSWORD='…'; npm run create-admin`.

First-time setup in the UI (as admin): **Departments** → add one; **Categories** → give each category a handling
department and a target resolution time; **Users** → create officers (tick *Team lead* for those who may assign
work). Reports are routed to the department of their category **when filed**; an admin assigning an un-routed
report moves it into the assignee's department.

Citizens and entrepreneurs self-register (the register form asks which one). There is no default or demo account, and the legacy `admin@city.gov / admin123`
seed login no longer exists (see Migrations).

## Configuration (environment variables)

The app reads the process environment only; it does not load `.env` files. See [.env.example](.env.example).

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | – | `production` → `Secure` cookies and HSTS header. Serve over HTTPS in production. |
| `PORT` | 3000 | Listen port |
| `DB` | `./data.db` | SQLite file |
| `UPLOAD_DIR` | `./uploads` | Photo storage. Not web-served; delivered only via the authorised `/api/images/:id`. |
| `MAX_UPLOAD_MB` | 5 | Per-image limit |
| `TRUST_PROXY` | 0 | Number of reverse proxies in front of the app (Render: `1`) so rate limits see client IPs |
| `BACKUP_DIR`, `BACKUP_KEEP` | – / 7 | Daily database snapshot folder and how many to keep |
| `MAP_TILE_URL`, `MAP_ATTRIBUTION` | OpenStreetMap | Raster tile source for the map |
| `APP_URL` | – | Public address (e.g. `https://repairs.example.org`); used for links in emails/texts. **Required when SMTP is configured** (the app refuses to start without it) |
| `SMTP_HOST`, `SMTP_FROM` (+ `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`) | – | Enables **email** notifications |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | – | Enables **SMS** notifications |

No secrets are needed by the browser. There is no signing secret to configure: sessions are random tokens
stored (hashed) in the database.

**Map tiles.** The default is OpenStreetMap's public tile server, which has a
[usage policy](https://operations.osmfoundation.org/policies/tiles/) (attribution required, no heavy or
bulk use). For production traffic use a commercial/own tile provider via `MAP_TILE_URL`. If tiles or Leaflet fail
to load, the report form still works with manual address/coordinates.

## Email and SMS notifications

In-app notifications always work. **Email** (SMTP via nodemailer) and **SMS** (Twilio REST API) switch on only when
their environment variables are set; otherwise they are off, the account page says so, and nothing pretends to
send. Users choose per channel in *My account* (email defaults on, SMS is opt-in and needs a mobile number in
international format such as `+919876543210`). Every attempt is stored with its outcome (`pending`, `sent`,
`failed` + error text) and admins can review them in **Audit log → Email and SMS delivery log**. Sending runs in
the background, so a slow or failing provider can never delay or undo the action that triggered it. Messages
contain the same text as the in-app notification plus a link built from `APP_URL`.

Verified: the SMTP path against a local SMTP server and the Twilio request format with a fake HTTP call (see
`tests/extras.test.js`). **Not verified against real providers**: use your own credentials and send yourself a
test (for example register, file a report, watch the delivery log).

## Email verification and password reset

Both need the email channel (SMTP + `APP_URL`). With **no email provider configured** nothing is blocked, the sign-in
page tells people to ask an administrator, and "forgot password" answers honestly that it is unavailable.

* **Verification.** Self-registered accounts get an email with a link (valid 24 h). Until verified they can browse
  but cannot file reports, send inquiries, file complaints or save a business profile (403 with a clear message;
  a banner offers to resend). Alert emails are sent only to verified addresses. Accounts created by an admin,
  staff migrated from before, and the first admin start verified.
* **Forgot password.** `POST /api/auth/forgot` returns the same reply whether or not the address exists and only
  emails real, active accounts. The link is valid for 1 hour and single-use; asking again voids the previous link.
  Choosing a new password signs the user out of **every** session and also verifies the mailbox.
* **Token handling.** 256-bit random tokens, only their SHA-256 stored, spent on use, expired ones purged, a
  verify token cannot be used to reset a password, and the frontend removes the token from the address bar.
  Requests are rate limited (5 reset requests/hour/IP, 5 verification emails/hour/user, 20 token checks/15 min/IP).
* **Without email**, an admin can still set a temporary password (Admin → Users → Reset password).

Verified with 12 automated tests and a browser run against a real local SMTP server (register, read the actual
email, follow the link, forgot password, reset, sign in). Not verified against a real mail provider.
Registration still reveals whether an address is already taken (409): avoiding that would need
"confirm by email before the account exists", which this version does not do.

## Ratings and "near me"

* A customer can rate a business **once per completed request** (1–5 stars + optional comment); owners cannot rate
  themselves. Reviews show the reviewer as first name + last initial, an average appears on listings and the
  profile, results can be sorted by rating, and an admin can remove an abusive review (audit-logged).
* Owners can set an approximate location (map click, device location or typed coordinates). It is stored rounded to
  3 decimals (about 110 m), shown publicly only as an approximate area, and never exposed more precisely, so
  repeated distance searches cannot reveal a home address. Customers search "near me" (device location) within
  5–100 km (API accepts up to 200); results are nearest-first with the distance. Businesses without a location
  appear in normal browsing but not in distance searches.

## Roles and rules (enforced in the backend)

Four roles: **citizen** (also the *customer* of the marketplace), **entrepreneur**, **officer**, **admin**.
Assumptions: a citizen account is used both to report infrastructure problems and to browse/contact businesses;
an entrepreneur account owns exactly one business profile and cannot use infrastructure reporting. The system
cannot verify who is a woman entrepreneur: the controls are the admin's manual profile review and the Verified
badge shown only on approved profiles.

* **Entrepreneur** – one business profile (starts *Pending*; admin approves/rejects/suspends with a reason),
  services with price/unit/availability, up to 6 photos, accepts or declines inquiries and requests, answers
  customers in a message thread, reads the guidance and uses the cost/profit calculator. Edits to an approved
  profile stay live (a rejected profile returns to review when resubmitted); admins can suspend at any time.
* **Customer (citizen)** – browse approved businesses without logging in; search by name/service, filter by
  category, location (city) and availability; open a profile; log in to send an inquiry or service request, follow
  the conversation, cancel a request, and file complaints.
* **Admin (marketplace)** – review queue, business categories (4 seeded: Tiffin / Home Food Service, Tailoring &
  Stitching, Beauty & Personal Care Services, Handicrafts & Handmade Products), complaints with a response,
  guidance/learning content editor, platform activity counts.
* **Inquiries are private** to the customer and the business owner (not even admins can read them). Complaints
  are how disputes reach admins.

* **Citizen** – register, file reports (1–3 photos), see only their own reports and *public* history, edit a
  report until review starts, reopen a resolved report (reason required), leave feedback once.
* **Officer** – sees reports of their department or assigned to them. May review/accept/reject unassigned
  department reports, act on reports assigned to them, claim an unassigned report for themselves. *Team leads*
  (`can_assign`) may assign/reassign within their department and act on any of its reports.
* **Admin** – everything above, plus users, departments, categories, analytics, audit log and CSV export.
  Admins cannot demote or deactivate themselves.

Unauthorised access to a report returns **404**, identical to "does not exist", so IDs cannot be probed.

### Status workflow

```
SUBMITTED ─▶ UNDER_REVIEW ─▶ ACCEPTED ─(assign)─▶ ASSIGNED ─▶ IN_PROGRESS ─▶ RESOLVED ─▶ CLOSED
    │              │             │                                  ▲            │
    └──────────────┴─────────────┴─▶ REJECTED (reason required)     └─ REOPENED ◀┘ (reason required)
```

`SUBMITTED→ACCEPTED` is also allowed. `ASSIGNED` is reached only through the assign endpoint. `RESOLVED` needs a
resolution note; resolution photos are optional. `REJECTED` and `CLOSED` are final. Every change is stored in
`report_events` with actor, time, previous/new value and note. Concurrent edits are rejected with 409 (the update
is conditional on the status the caller saw).

## API (all JSON unless noted; errors are `{ "error": "message" }`)

| Area | Endpoints |
|---|---|
| Public | `GET /api/meta` |
| Auth | `POST /api/auth/register · login · logout`, `GET/PATCH /api/auth/me`, `POST /api/auth/verify/request · verify · forgot · reset` |
| Reports | `POST /api/reports` (multipart), `GET /api/reports` (filters: `status, priority, category_id, department_id, assigned_to=me\|unassigned\|<id>, overdue=1, q, sort, order, page, limit≤50`), `GET /api/reports/markers`, `GET/PATCH /api/reports/:id` |
| Workflow | `POST /api/reports/:id/status · assign · remarks · images · feedback`, `PATCH /api/reports/:id/priority`, `GET /api/officers`, `GET /api/dashboard` |
| Images | `GET /api/images/:id` (authorised) |
| Notifications | `GET /api/notifications`, `POST /api/notifications/read-all`, `POST /api/notifications/:id/read` |
| Admin | `/api/admin/users`, `/departments`, `/categories`, `GET /api/admin/analytics · audit · export.csv` |
| Marketplace (public) | `GET /api/business-categories`, `GET /api/businesses` (`q, category_id, city, available=1, page`), `GET /api/businesses/cities`, `GET /api/businesses/:id`, `GET /api/business-images/:id` |
| Marketplace (entrepreneur) | `GET/PUT /api/my/business`, `POST/PATCH/DELETE /api/my/business/services[/:id]`, `POST/DELETE /api/my/business/images[/:id]`, `GET /api/content` |
| Marketplace (customer/owner) | `POST /api/businesses/:id/inquiries`, `GET /api/inquiries`, `GET /api/inquiries/:id`, `POST /api/inquiries/:id/messages · status`, `POST /api/complaints`, `GET /api/complaints/mine` |
| Marketplace (ratings) | `POST /api/inquiries/:id/review`, `DELETE /api/admin/reviews/:id`; list filters `near_lat, near_lng, radius_km, sort=rating\|newest` |
| Notifications (admin) | `GET /api/admin/deliveries` (email/SMS outcomes) |
| Marketplace (admin) | `GET /api/admin/businesses`, `POST /api/admin/businesses/:id/review`, `/api/admin/business-categories`, `GET/PATCH /api/admin/complaints`, `POST/PATCH/DELETE /api/admin/content` |

## Security measures

* scrypt password hashing; generic login errors with equalised timing; login 10/15 min and registration
  10/h per IP; 20 report creations/h per user; 300 API calls/min per IP (in-memory, per process).
* Opaque random session tokens, only their SHA-256 stored; `HttpOnly; SameSite=Strict; Secure` (production)
  cookie, 7-day expiry, deleted on logout, password change, role change and deactivation.
* CSRF: SameSite=Strict plus rejection of any state-changing request whose `Origin` differs from the host. CORS is
  not enabled.
* Uploads: JPEG/PNG/WebP only, identified by **magic bytes** (client MIME/filename ignored), size and count
  limits, server-generated filenames, stored outside the web root, served with `nosniff` and `inline` only for the
  three safe types.
* CSP `default-src 'self'` (+ tile host for images), `nosniff`, `X-Frame-Options: DENY`, no `x-powered-by`.
  The frontend writes user text with `textContent` only.
* All SQL is parameterised; sort columns are whitelisted; `LIKE` wildcards are escaped.
* CSV export neutralises spreadsheet-formula injection.
* Audit log for status/assignment/priority changes, evidence uploads, user/department/category changes, exports.

## Database & migrations

SQLite, versioned by `PRAGMA user_version`; migrations in `src/db.js` (4 so far: legacy baseline, infrastructure schema, marketplace schema + starter guidance, notification preferences/business location/reviews) run automatically at start, each in a
transaction, and are append-only (never edit an applied one). Migration 2 converts the original `issues` table
into the new schema (**data preserved**: reports, photos, ratings; legacy statuses are mapped; the old free-text
assignee becomes an internal remark) and **disables** the old seeded `admin123` account if it still has that
password; remaining `authority` users become `admin`. This path is covered by a test using a legacy-shaped
database. Legacy report rows get tracking numbers like `IDR-2023-L00001`.

**Backup / restore.** Stop writes or use SQLite's online backup, and copy both the DB and `UPLOAD_DIR`:

```bash
sqlite3 data.db ".backup 'backup-$(date +%F).db'"   # consistent snapshot while running
cp -r uploads backup-uploads-$(date +%F)
```

Restore = stop the app, put the backup file back as `DB`, restore the uploads directory, start the app.
Keep backups off the server and test a restore.

## Deployment

**Render** is the supported target: see **[DEPLOY.md](DEPLOY.md)** (a `render.yaml` blueprint creates the service, a
1 GB persistent disk and all required settings). Generic requirements for any host: Node 22.13 or newer, HTTPS
in front, one instance only, `DB`, `UPLOAD_DIR` (and optionally `BACKUP_DIR`) on a **persistent volume**,
`NODE_ENV=production`, `TRUST_PROXY` = number of proxies in front, and `npm run create-admin` once.
Serverless hosts (Vercel, Netlify) are not suitable because they have no persistent disk.

## Troubleshooting

* `node:sqlite` missing / `ExperimentalWarning`: need Node ≥ 22.13 (the warning is harmless).
* Everyone gets 429: behind a proxy, set `TRUST_PROXY` to the number of proxies (usually `1`).
* Officers see no reports: the report's category has no department, or the officer has none. Fix in
  Admin → Categories / Users.
* Photos disappear after a redeploy: `UPLOAD_DIR` is not on persistent storage.
* Map blank: tiles blocked or offline; the form still accepts an address.

## Tests

`npm test` runs `node --test` over `tests/` (auth, access control/IDOR, workflow, uploads, geolocation validation,
admin/analytics, legacy migration, notification-failure isolation, business profiles, review, search, inquiries,
complaints, content). They use in-memory databases and a
temporary upload directory; no external services are needed.

## Known limitations

See [PROGRESS.md](PROGRESS.md#not-done--limitations).
