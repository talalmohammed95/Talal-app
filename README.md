# Peninsula Offers

Orla Properties' app for every Peninsula (Business Bay) sale and rental offer from the Nov 2026 decks and flyers. It includes a dashboard, client presentations, a client tracker, deal and mortgage calculators, market data, sign-in with admin approval and an admin backend.

Built entirely on open-source software:
- **PostgreSQL** database. Any Postgres works: Neon through Vercel Storage (free), Railway, or your own server.
- **Node.js API** in `api/index.js`, running as a Vercel Function. It uses `pg` for the database and `nodemailer` for email.
- **Front end:** one static page in `app/`, with no framework.

```
app/         the app (index.html, icons, service worker)
api/         the backend: sign-in, approval, offers, settings (one Vercel Function)
lib/         database connection, tables, password hashing, email, starting offers
scripts/     build.mjs (Vercel build) and dev.mjs (run it on your computer)
```

## How sign-in works

| | Who | What they can do |
| --- | --- | --- |
| **Admin** | One account only: the address in `ADMIN_EMAIL` | Everything, plus the Admin tab: approve or decline new accounts, block users, make password-reset links, add, edit and delete offers, statuses, fees, agents, the team announcement and the activity log |
| **Agent** | Anyone who registers and is approved by the admin | Browse and present offers, and keep their own private clients, shortlists and listings |

- Anyone can register with their name, email and a password of at least 8 characters. With email turned on, they first confirm their email from a link.
- Every new account waits for the admin's approval. They see **Waiting for approval** until you tap **Approve** in Admin › Users. With email on, you get an email when someone is waiting, and they get one when you approve them. Declined or blocked users can't sign in, and blocking someone signs them out everywhere.
- Forgot a password? With email on, a reset link is sent by email. Without email, the admin taps **Reset link** in Admin › Users and sends the link, for example on WhatsApp.
- **Security, enforced by the server:**
  - Passwords are stored as scrypt hashes, never as plain text.
  - Sessions are random tokens in secure, HTTP-only cookies.
  - Repeated sign-in attempts are rate-limited.
  - Only the admin can change offers or settings, there can only be one admin, and pending or blocked accounts get no data.
- Each device can also add a PIN lock (My listings › Login & security).

## Deploy on Vercel (free)

1. **Import the project.** In Vercel, choose **Add New › Project** and import `talalmohammed95/Talal-app` from GitHub. Leave **Framework Preset** as **Other**; `vercel.json` sets everything else.
2. **Add the database.** In the project, open **Storage › Create Database**, choose **Neon** (free PostgreSQL) and connect it to the project. This adds `DATABASE_URL` for you. To use another PostgreSQL instead, add `DATABASE_URL` yourself in step 3.
3. **Add environment variables** under **Settings › Environment Variables**, for Production and Preview:

   | Name | Required | Value |
   | --- | --- | --- |
   | `DATABASE_URL` | Yes (added by step 2) | `postgres://user:password@host/db?sslmode=require` |
   | `ADMIN_EMAIL` | Yes | The admin's email address |
   | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | For email | Your email provider's SMTP settings, for example Bird, Resend, SendGrid, Brevo, Google Workspace or Microsoft 365 |
   | `MAIL_FROM` | For email | e.g. `Orla Properties <no-reply@yourdomain.com>` |
   | `APP_URL` | No | Your site's address for links in emails, if you use your own domain. Vercel's address is used otherwise |

4. **Deploy.** The build checks the settings, creates the database tables and loads the 20 starting offers the first time. Every later push to GitHub deploys automatically, and the database keeps its data.
5. **Register the admin first.** Open the site, tap **Create an account** and register with the `ADMIN_EMAIL` address. That account is approved automatically. Then share the address with your agents and approve them as they register.

If a required setting is missing (no database, no `ADMIN_EMAIL`, a database that can't be reached, or SMTP without `MAIL_FROM`), the deploy still succeeds. Instead of the app, the site shows a **Finish setup** page that lists exactly what to add, and it contains no app data. Add what it lists, redeploy, and the app goes live. Builds on your computer or in GitHub Actions fail with the same list instead.

After changing an environment variable, redeploy (Deployments › ⋯ › Redeploy).

**Production branch:** Vercel publishes the repository's default branch as the live site. To deploy from another branch, set **Settings › Git › Production Branch**.

## Run it on your computer

You need Node.js 18+ and a PostgreSQL database (a free Neon database works too).

```
npm install
DATABASE_URL=postgres://... ADMIN_EMAIL=you@yourcompany.com npm run dev
```

Then open http://localhost:3000. Without SMTP settings, emails are written to `dev-mail.log`, so you can open the confirmation and reset links from there.

`ALLOW_LOCAL_MODE=1 npm run build` builds the device-only version instead: a PIN lock, no accounts, and data kept on the device.

## Run it on an iPad

Open your Vercel address in Safari and tap Share › Add to Home Screen. It opens full screen like an app, and offers you've already loaded stay viewable offline.

## The claude.ai version

The shared claude.ai artifact signs people in with their claude.ai accounts instead. Admins there are the people with Edit access in the Share menu.
