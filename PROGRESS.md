# Project status

_Last updated: 2026-10-17. Every claim below was produced by running the code: `npm test` → **68 tests, 68 pass, 0 fail**;
`npm audit` → 0 vulnerabilities. Live site: https://internship-infra-damage-reporting-system.onrender.com/_

## Coverage of the project description

### Infrastructure damage reporting
| Requirement | Status |
|---|---|
| Web-based damage reporting; categories (potholes, streetlights, leaks, footpaths, drains, other) | Done; categories are admin-editable |
| Image upload with geo-location | Done. Location = device-reported coordinates, a map point, or a typed address, always labelled as such. It is **not** read from photo EXIF data. |
| Issue status tracking by the citizen | Done: tracking number, status history, public updates, resolution photos |
| Authority dashboard; authority receives and assigns tasks | Done: officer dashboard, filters/search/pagination, assignment and reassignment with history, internal remarks, priority, overdue |
| KPIs: average resolution time, issues resolved, satisfaction, repeated-issue rate | Done on the admin and officer dashboards, from real data (definitions in `src/analytics.js`) |
| Out of scope (native app, AI detection) | Not built, as specified |

### Women entrepreneurs, customers, admin
| Requirement | Status |
|---|---|
| Registration and secure login | Done (entrepreneur or citizen/customer at sign-up) |
| Create and manage a home-business profile; the four categories | Done (Tiffin / Home Food, Tailoring & Stitching, Beauty & Personal Care, Handicrafts & Handmade) |
| Step-by-step setup guidance: pricing, licensing and compliance, cost estimation, profit planning | Done as admin-editable articles plus a cost and profit calculator. The licensing text is **general information, not legal advice**. |
| Upload service details, images, pricing, availability | Done |
| Receive and respond to inquiries; track service requests | Done: in-platform message thread and a request status workflow |
| Marketing tips, learning resources, growth content | Done (admin-managed) |
| Customers browse **verified** businesses; search and filter by location, category, availability; detailed profiles | Done (only admin-approved profiles are public, with a Verified badge; "near me" distance search; ratings) |
| Customers send inquiries or requests and contact providers through the platform | Done |
| Admin: approve entrepreneur profiles; manage categories and listings; monitor activity; handle complaints; manage guidance content | Done (approve/reject/suspend with a reason; platform activity counts; complaints queue; content editor) |

### Non-functional requirements
| Requirement | Status |
|---|---|
| Usability, responsiveness | Plain, labelled forms; keyboard focus and skip link; checked at phone width. **Not** tested with real users and no screen-reader audit was run. |
| Performance (actions in under 2 s) | Pagination, indexes and capped payloads are in place. **Not measured**: no load test was run. |
| Scalability | **Limited by design**: SQLite and an in-memory rate limiter mean one server instance. Moving to PostgreSQL would be the next step. |
| Security | Done: hashed passwords, revocable sessions, rate limits, CSRF defence, role checks on the server, upload validation, audit log, verified email, password reset |
| Availability, reliability | Hosted on Render with a persistent disk, health check, graceful shutdown, daily database snapshot. Uptime depends on the hosting plan; it is a single instance, so deploys cause a brief interruption. |
| Maintainability | Modular code, migrations, 68 automated tests, documented setup |
| Data privacy | Privacy notice page, minimal data, no tracking cookies, email/SMS opt-in. **Gaps**: permanent account deletion is not self-service, and photos keep their embedded EXIF data. |

### Differences from the suggested stack
| Suggested | Built | Why |
|---|---|---|
| React / Next.js, Tailwind or Bootstrap | Plain HTML, CSS and JavaScript (single-page app) | No build step, small, and enough for this scope |
| Node.js + Express, REST | Same | |
| MongoDB or PostgreSQL | SQLite (Node's built-in `node:sqlite`) | Simplest reliable option for one server; limits scale |
| AWS, Vercel or Netlify | Render | Needs a persistent disk, which Vercel and Netlify do not offer |

## What was verified, and how
* **Automated (68 tests):** authentication, role and ownership checks, report workflow and invalid transitions, uploads,
  geolocation validation, analytics, legacy-data migration, business profiles and review, search and near-me, inquiries,
  ratings, complaints, content, email/SMS delivery and failure handling, verification and reset, backups, health check,
  rate limiting behind a proxy.
* **Real SMTP exchange:** the email code was run against a local SMTP server (registration, verification link,
  password reset). It has **not** been tried with a real mail provider or a real Twilio account.
* **In a browser, end to end:** citizen reports with a map point and photo; admin accepts and assigns; officer progresses
  and resolves with evidence; citizen sees only public updates; entrepreneur builds a profile and the admin approves
  it; a visitor searches and a customer sends a request; owner replies; rating and complaint flows; verification and
  reset with real emailed links; privacy page.
* **Deployment:** the exact install and start steps were run from a fresh clone with production settings; the live
  site answers its health check, sends security headers, and does not expose the database or source files.
  Not confirmed from outside: that the persistent disk keeps data across a redeploy (steps in `DEPLOY.md`).

## Known limitations
* Registration reveals whether an email is already registered; accounts cannot change their email address.
* Photos are not resized and keep EXIF metadata; there is no antivirus scan or orphan-file cleanup job.
* Repeated-report detection uses a ~110 m grid; neighbours across a cell edge are missed.
* Reports are routed to a department when filed; changing a category's department later does not re-route
  existing reports (an admin assignment does).
* Radius search ignores longitude wrap at the antimeridian and considers at most 2,000 businesses.
* Reviews can only be removed by an admin (no replies or edits). One business per entrepreneur. No payments (out of
  scope in the description).
* There is no end-to-end browser test suite; visuals were checked mainly through the page structure.
* Deploys briefly interrupt service (one instance, one disk). No CI pipeline or Dockerfile.

## Suggested next steps
1. Playwright end-to-end tests for the main journeys and an automated accessibility check.
2. Move to PostgreSQL and shared rate limiting if more than one instance is needed.
3. Image resizing and EXIF stripping; account deletion; changing the email address.
4. Off-site backups and a CI pipeline.
