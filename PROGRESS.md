# Progress

_Last updated: 2026-10-16. Test status below was produced by actually running the commands._

## Starting point
A single 150-line `server.js` (Express + SQLite + Multer) with register/login, report create/list, an
authority status/assignee patch, rating and KPIs, an **empty** `public/`, no tests, a hardcoded fallback token
secret and a seeded `admin@city.gov / admin123` login. No frontend, no `.env`/`.gitignore`/README.
The original `server.js` was replaced (the folder was not under git, so there is no copy; its behaviour is
covered by `src/`). The old `/api/issues…` and `/api/kpis` endpoints were replaced by `/api/reports…`,
`/api/dashboard`, `/api/admin/analytics`; nothing in the repo consumed them.

## Done and verified

| Area | Evidence |
|---|---|
| Stabilisation: `engines`, `.gitignore`, `.env.example`, README, working `npm test` | `npm test` |
| Migrations (versioned, data-preserving; legacy admin123 login disabled) | `tests/admin.test.js` legacy test |
| Auth: scrypt, sessions (cookie, hashed server-side, revocable), rate limits, CSRF origin check, generic errors, password change | `tests/auth.test.js` |
| Citizen reporting: validation, tracking number, location sources, photos by magic bytes, ownership | `tests/reports.test.js`, browser |
| Workflow: transitions, required notes, stale-update 409, assignment history, priority, remarks (internal/public), resolution evidence, reopen, feedback | `tests/reports.test.js`, browser |
| Authorisation: IDOR → 404, officer scope, lead vs officer, admin-only routes, self-lockout | `tests/reports.test.js`, `tests/admin.test.js` |
| Admin: users/roles, departments, categories, audit log, CSV export (formula-safe), analytics with documented KPI definitions, empty-data case | `tests/admin.test.js` |
| In-app notifications; failure never rolls back the update | `tests/reports.test.js` |
| Frontend (citizen / officer / admin SPA, map, geolocation with denied-permission fallback, responsive, empty/loading/error states) | driven in the in-app browser |

**Latest results:** `npm test` → 65 tests, 65 pass, 0 fail. `npm audit` → 0 vulnerabilities.

### Password reset and email verification (added on request)
Done: one-time hashed tokens, verification link (24 h), reset link (1 h, single use, voids older links, signs out
all sessions), identical "forgot" reply for known/unknown addresses, gating of reporting/inquiries/complaints/
business profiles for unverified accounts **only when email is configured**, alert emails only to verified
addresses, rate limits, honest 503/409 replies when email is off, startup refusal when SMTP is set without
`APP_URL`. 12 tests in `tests/account.test.js`; browser-verified against a local SMTP catcher (real messages,
real links). Not verified against a real mail provider. Existing self-registered users become "unverified"
(staff are marked verified by the migration); if you switch email on later they will see the banner.
Known gaps: registration still discloses taken addresses; the account email address cannot be changed yet
(so there is no re-verification flow); verification and reset emails are plain text.

### Email/SMS alerts, business ratings, radius search (added on request, before deployment)
Done: SMTP email and Twilio SMS channels (off unless configured, per-user opt-in/out, background sending,
recorded outcomes, admin delivery log); one rating per completed request with averages, sorting and admin
removal; business location stored to ~110 m with "near me" search (bounding box + exact distance), distance
shown, sorting. Verified by 11 tests (`tests/extras.test.js`) including a real SMTP exchange with a local
server, and in the browser (account preferences, saving a location, denied/granted device location, far-away
search returning nothing, rating a completed request, reviews on the public page, delivery log).
Not verified: delivery through a real SMTP provider or real Twilio account (no credentials available);
SMS cost and number-verification rules of your provider apply.
Payments were not added: the project description says customers use the platform for discovery and inquiry,
not instant payment, in the first version.

### Marketplace (women entrepreneurs / customers) – added after the project description was re-confirmed
Done and verified (13 API tests in `tests/business.test.js` + browser run): registration as entrepreneur or
customer; business profile with the four required categories; services/prices/availability; photos (validated by
content, max 6); admin approve/reject/suspend with reasons and notifications; public browse/search/filter by
location, category, availability; inquiries and service requests with message thread and status workflow;
complaints handled by admin; admin-editable guidance (setup steps, pricing strategies, licensing/compliance,
cost estimation, marketing tips, learning); cost and profit calculator (browser-side, break-even, suggested
price); platform activity statistics; audit log entries. Phone-width layout checked on the new pages.
Browser run: entrepreneur registered, built a profile with a service and photo, admin approved it, anonymous
visitor searched and opened it, customer sent a service request, owner replied and accepted, customer filed a
complaint, admin resolved it.

Marketplace limitations: guidance text is general (India-flavoured examples) and **not legal advice**, admins
should localise it; no payments (out of scope per the description); inquiry contact is in-platform messaging only
; one business per entrepreneur; reviews can only be removed by an admin (no replies or edits); the radius
search ignores longitude wrap at the antimeridian and caps candidates at 2000; the calculator ignores tax.

**Browser run (real server, scratch DB, in-app browser):** registered a citizen through the form; filed a report
(map click, geolocation permission denied → fallback message shown, photo upload) and got a tracking number;
admin accepted and assigned it; the officer progressed it, added public and internal remarks, changed priority,
uploaded a resolution photo and resolved it (missing-note error displayed); the citizen saw the public history
and resolution without internal notes or staff names, and submitted feedback. Admin dashboard, map (marker),
audit log, overdue filter and CSP (no violations) checked. 375 px layout: no page-level horizontal overflow.

## Journeys
* **A (citizen)** – verified (test + browser).
* **B (authority)** – verified (test + browser).
* **C (admin)** – verified by test; UI for departments/categories/users/dashboard/audit/map exercised in browser.
  Not exercised in the browser: user deactivation/password-reset buttons, category SLA edits, CSV download click.
* **D (security)** – verified by test.

## Not done / limitations
* **Email/SMS** need your own provider credentials (see README); unverified against real providers.
* **Password recovery / email verification:** built (needs email configured). Without email an admin sets a
  temporary password in Admin → Users.
* **Map tiles:** OpenStreetMap blocked requests when the app sent no `Referer` (fixed by `Referrer-Policy:
  strict-origin-when-cross-origin`). For production traffic use your own/commercial tile source.
* **Application configuration UI / notification settings:** not built; configuration is environment-based.
  Per-category target hours are editable.
* **Registration reveals whether an email exists** (409). Needs email verification to avoid.
* **Rate limiting is per-process memory.** Single-instance only.
* **Location is never "verified".** Device-supplied coordinates are labelled as such and unverified.
* **Repeated-report detection** uses a ~110 m grid; neighbours across a cell edge are missed.
* **Report routing** happens at creation from the category's department; changing a category's department
  later does not re-route existing reports (an admin assignment does).
* **Photos:** no thumbnails/resizing, no EXIF stripping (photos may contain location metadata), no
  antivirus scan, no cleanup job for files whose DB row was removed. Files are written only after validation and
  removed if the DB insert fails.
* **Performance targets are not measured.** Pagination, indexes and capped payloads are in place; no load test
  was run. Procedure: seed 100k reports, run `autocannon` against `GET /api/reports?page=…` and
  `/api/dashboard` with an admin cookie, and check p95 latency.
* **No end-to-end test suite** (only API tests plus manual browser verification); screenshots could not be
  captured in this environment, so visual polish and image rendering were checked via DOM only.
* **Accessibility** basics (labels, focus, landmarks, skip link, live regions, contrast via system colours) are
  implemented but no screen-reader or automated audit was run.
* **Operational:** no Dockerfile/CI; no log shipping (errors go to stderr).
* Wide admin tables scroll horizontally inside their container on phones.

## Next steps (suggested order)
1. Email provider behind `src/notify.js` + password reset + email verification.
2. Strip EXIF / resize images; orphan-file cleanup job.
3. Playwright E2E for journeys A–D and an axe accessibility pass.
4. CI (tests + audit), Dockerfile, backup cron.
5. Load test and, if needed, move to Postgres + shared rate limiter.
