# Deploying to Render

This takes about 20 minutes. You need: a [Render](https://render.com) account, this repository on GitHub, and a
payment card (a paid instance is required, see below). Prices change; check Render's pricing page first. Expect
a few dollars per month for the Starter instance plus a small charge for the 1 GB disk.

## Why a paid instance

The app stores its database and uploaded photos on disk. Render's **free** web services have no persistent disk
and go to sleep, so on the free plan every restart would erase all accounts, reports and photos. The blueprint
therefore uses the **Starter** plan with a 1 GB disk mounted at `/var/data`.

## 1. Create the service

1. Push this repository to GitHub (already done if you can see `render.yaml` in it).
2. In Render: **New → Blueprint**, connect GitHub, choose this repository and the `main` branch.
3. Render reads `render.yaml` and shows one web service, **civic-repair-desk**, with a 1 GB disk. Check the plan
   is **Starter** and click **Apply** (or **Create**).
4. Wait for the first build and deploy to finish ("Live"). Open the service URL, `https://civic-repair-desk-XXXX.onrender.com`
   (Render shows the exact address at the top of the service page). The site loads, but there is no administrator yet.

Nothing in `render.yaml` is secret. The app has **no signing secret** to configure: sessions are random tokens
stored in the database.

## 2. Create the first administrator

Open the service's **Shell** tab (paid instances have it) and run, with your own email and a long passphrase:

```bash
ADMIN_EMAIL='you@example.com' ADMIN_NAME='Your Name' ADMIN_PASSWORD='a-long-passphrase-here' npm run create-admin
```

It prints `Administrator created: you@example.com`. Sign in on the site and **change the password** under
*My account*. The shell history is not kept after the session ends.

## 3. Set up the content

As administrator: **Departments** → add them; **Categories** → give each infrastructure category a handling
department and target hours; **Users** → create officers; review the guidance articles under **Content** and
localise the licensing text for your region.

## 4. Optional: email, SMS, maps

Add these in **Environment** on the service page, then Render redeploys automatically.

| To get | Add |
|---|---|
| Email alerts, **email verification and password reset** | `APP_URL` = your site address (for example `https://civic-repair-desk-XXXX.onrender.com`, or your custom domain), plus `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`. **If you set `SMTP_HOST` you must set `APP_URL`, or the app will not start.** |
| SMS alerts | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` |
| A map tile source for heavy traffic | `MAP_TILE_URL`, `MAP_ATTRIBUTION` (OpenStreetMap's public tiles are for light use only) |

For a demo, a Gmail account with an *app password* works as SMTP (`smtp.gmail.com`, port `465`, `SMTP_SECURE=1`).
Turning email on makes unverified accounts unable to report problems or contact businesses until they verify, so
turn it on **before** inviting real users, and send yourself a test registration.

## 5. Check that it works

1. Open `/healthz`: it should show `{"ok":true}`.
2. Register a test citizen, file a report with a photo, then sign in as admin and review it.
3. Redeploy (Manual Deploy → Deploy latest commit) and confirm the report and photo are still there. That proves
   the disk is attached correctly. If they vanished, the disk is not mounted at `/var/data`.

## Backups

* The app copies the database to `/var/data/backups` once a day and keeps the newest 7 (first copy about a minute
  after each start). This protects against corruption and mistakes, but it is on the same disk.
* Render can also snapshot disks; check the **Disks** section of your service for the current options.
* For a real deployment also copy the database and the `uploads` folder somewhere else on a schedule. Restore =
  stop the service, put a backup file back at `/var/data/data.db`, restart.

## Updating

Push to `main`; Render rebuilds and redeploys. Database changes are applied automatically at startup
(migrations), and each deploy briefly interrupts service because the disk can only attach to one instance.

## Custom domain

Service → **Settings → Custom Domains**, follow the DNS instructions, then update `APP_URL` to the new address.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Build fails with a Node/`node:sqlite` error | Check `NODE_VERSION` is `24` (needs 22.13 or newer). |
| Deploy fails right after adding `SMTP_HOST` | Add `APP_URL`; it is required with SMTP. |
| Data disappears after a deploy | The disk is missing or not mounted at `/var/data`; `DB` and `UPLOAD_DIR` must point inside it. |
| Everyone is blocked with "Too many requests" | Rate limits are seeing the proxy address, not visitors. Try `TRUST_PROXY=2` (or `0`), redeploy, and test. |
| Sign-in works but you are logged out instantly | Open the site over `https://` (cookies are Secure in production). |
| No emails arrive | Check **Admin → Audit log → Email and SMS delivery log** for the provider's error. |
| Photos 404 after moving hosts | Copy the `uploads` folder along with the database. |

## Limits of this setup

One instance only (SQLite and the in-memory rate limiter are per-process). If you outgrow it you would move to
PostgreSQL and a shared rate limiter. Downtime during deploys is a few seconds to a minute.
