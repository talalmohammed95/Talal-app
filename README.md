# Peninsula Offers

Orla Properties' website and app for every Peninsula (Business Bay) sale and rental offer from the Nov 2026 decks and flyers.

- **The website** (`/`) presents the community, with a photo slideshow, the five buildings, a gallery, available homes, market data with its sources, and three ways to register.
- **The app** (`/app/`) has photos and floor plans for every offer, client presentations, a "3 options" request wizard, a client tracker, deal and mortgage calculators, market data, sign-in with admin approval and an admin backend.

Built entirely on open-source software:
- **PostgreSQL** database. Any Postgres works: Neon through Vercel Storage (free), Railway, or your own server.
- **Node.js API** in `api/index.js`, running as a Vercel Function. It uses `pg` for the database and `nodemailer` for email.
- **Front end:** one static page in `app/`, with no framework.

```
site/        the public website (served at /)
app/         the app (served at /app/), icons, service worker; app/img holds the photos, renders and floor plans
api/         the backend: sign-in, approval, offers, settings (one Vercel Function)
lib/         database connection, tables, password hashing, email, starting offers
scripts/     build.mjs (Vercel build) and dev.mjs (run it on your computer)
```

## How sign-in works

| | Who | What they can do |
| --- | --- | --- |
| **Admin** | One account only: the address in `ADMIN_EMAIL` | Everything, plus the Admin tab: approve or decline new accounts, block users, make password-reset links, add, edit and delete offers, statuses, fees, agents, the team announcement and the activity log |
| **Orla team agent** | Registers as "On the Orla Properties team"; the admin approves | Everything except Admin: all offers (unit numbers and owners only on their own), analysis, reports, clients, presentations |
| **External agent** | Registers as "An agent at another agency" with their agency name | The simple showroom: photos, floor plans, prices, costs, market data, the 3-options wizard and presentations. **Never receives unit numbers, owner details or internal notes**: the server removes them |
| **Client** | Registers as "Buying or renting a home" | The same showroom as external agents, with "Ask about this home" buttons that open WhatsApp to the listing agent |

- Anyone can register with their name, email and a password of at least 8 characters. With email turned on, they first confirm their email from a link.
- The admin can change anyone's role in Admin › Users. Each team account is also linked to an agent name on the offers ("Listings: …"); new team accounts are linked automatically when their first name matches.
- **Agents' own units:** in the Listings tab each team agent adds their own units with the unit number, details and the owner's name and phone, and can edit or delete them. They're stored on the server: an agent sees only their own, the admin sees everyone's (Listings › Agents' listings) and can edit them. Units saved before on a device move to the agent's account on their next sign-in.
- **Sharing a unit as an offer:** on their own unit, an agent taps **Share as an offer**, enters the floor shown to others, and chooses the Orla team only or also external agents and clients. Others see the floor, price and details, never the unit number, the owner or the agent's notes. Editing the unit updates the shared offer; **Stop sharing** removes it.
- **Owners' contacts:** enter unit numbers and each owner's name and phone in Admin › Unit numbers and owners (all offers in one table). An agent sees the owner's name and phone, with Call and WhatsApp buttons, only on offers listed under their own name; other team agents see "Listed under …" with a button to call that agent. The admin sees all. The server removes owners' details from everyone else's data.
- After signing in, everyone except the admin is asked "What are you looking for?" (buy or rent, type, purpose, budget) and gets three options: premium, balanced and best value, ready to present or send on WhatsApp. **Find 3 options** in the top bar opens it any time.
- **Create an account for someone:** Admin › Users › Create an account. Enter their name and email (their username), pick the account type and which agent's offers are theirs, and either type a password or leave it empty to generate one. The account is approved straight away; copy the message or send it on WhatsApp.
- Every new account waits for the admin's approval. They see **Waiting for approval** until you tap **Approve** in Admin › Users. With email on, you get an email when someone is waiting, and they get one when you approve them. Declined or blocked users can't sign in, and blocking someone signs them out everywhere.
- Forgot a password? With email on, a reset link is sent by email. Without email, the admin taps **Reset link** in Admin › Users and sends the link, for example on WhatsApp.
- **Security, enforced by the server:**
  - Passwords are stored as scrypt hashes, never as plain text.
  - Sessions are random tokens in secure, HTTP-only cookies.
  - Repeated sign-in attempts are rate-limited.
  - Only the admin can change offers or settings, there can only be one admin, and pending or blocked accounts get no data.
- Each device can also add a PIN lock (My listings › Login & security).

## Photos and floor plans

Each offer shows a photo gallery with a full-screen viewer, and its floor plan where one exists. The photos come from the flyers' developer renders (Select Group) and from photos of the actual units, and are labelled as one or the other. The list of which photos belong to which offer is the `MEDIA` table in `app/index.html`. Offers without their own photos show the standard photos for their building.

To change an offer's photos, open Admin › Edit offer › Photos and floor plan: upload photos or a floor plan (they're resized on the device and stored in the database), pick from the photo library, set the cover, or go back to the default photos.

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
