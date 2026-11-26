# Peninsula Offers

Orla Properties' website and app for every Peninsula (Business Bay) sale and rental offer from the Nov 2026 decks and flyers.

- **The website** (`/`) presents the community, with a photo slideshow, the five buildings, a gallery, available homes, market data with its sources, and three ways to register.
- **The app** (`/app/`) has photos and floor plans for every offer, client presentations, a "3 options" request wizard, a client tracker, deal and mortgage calculators, market data, sign-in with admin approval and an admin backend.

Built entirely on open-source software:
- **PostgreSQL** database. Any Postgres works: Neon through Vercel Storage (free), Railway, or your own server.
- **Node.js API** in `api/index.js`, running as a Vercel Function. It uses `pg` for the database and `nodemailer` for email.
- **Front end:** one static page in `app/`, with no framework.

```
site/        the public website: English at /, Russian at /ru/, German at /de/, Italian at /it/
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
- **Team performance** (Team tab, admin and Orla team only): the goal of 15 listings per agent online on Bayut and Property Finder by 31 Dec 2026, a ranking table (total units, for sale, for rent, online, off market, still to list online) and units by agent (building, type, size, floor, view, for, price, status) in the layout of the team performance report (with **Send weekly update** to post it to the team on WhatsApp), and a checklist to tick the platforms each listing is live on, or Off market. The team's units (offers marked "Counts in team performance"; the 16 from the 20–26 Nov report are marked) count under the agent each is listed under (from 20 Nov 2026), together with each agent's own units. A listing counts once it's live on every platform. The admin changes the target, dates and platforms under Goal settings. External agents and clients can't see it, and it shows counts only, never unit numbers or owners.
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

## Sales offers (team only)

On any home, **Sales offer** makes a one-page A4 PDF in the style of the Orla flyers: the building bar, "Prepared for" the client's name with date and reference, the main photo, price and price per sq ft, unit details, full purchase cost (or rent and payment), estimated yield and mortgage, two more photos and the floor plan, the building and its amenities, drive times, and the agent's card with the RERA QR code. Choose the agent on the offer and whether to show the floor plan, yield, the highlight and the exact floor (a floor band by default). **Share PDF** sends it straight to WhatsApp on phones; **Download PDF**, **Image** and a ready **WhatsApp message** are there too. The 3 options from "New client request" and the Shortlist make one PDF with a page per home. The PDF is made in the browser with html2canvas and jsPDF, included in `app/vendor` (MIT).

## AI assistant (team only)

**AI assistant** (top bar on a laptop, More on a phone, or the button on Home) is a chat for the Orla team. An agent types a unit number, for example `1203`, and sees the unit with the owner's name and phone, with Call and WhatsApp buttons. Then it writes the listing for Bayut and Property Finder (title, description, what's missing before it goes live, tips), suggests a price from the team's units and the saved market research, and answers questions like "which of my units aren't online yet?". **Put into My units form** fills the listing form, including the new portal title and description fields; the agent checks it and saves.

Privacy is the same as everywhere else: the lookups run on our server, and each agent sees owners only on their own units (the admin sees all). For a teammate's unit it says only which teammate has it. Clients and external agents can't open it.

It runs on Claude (Anthropic). Add `ANTHROPIC_API_KEY` in Vercel to turn it on. Without the key it runs in basic mode: the unit lookup with the owner works, and it fills a starter listing.

## Home-screen guide

`/home-screen/` is a page, with the picture `app/img/home-screen-guide.jpg`, showing how to put Peninsula on an iPhone (Safari: Share, Add to Home Screen, Add) or Android (Chrome: ⋮, Add to home screen or Install app) home screen. It shows the steps for the visitor's phone, and on Android an Install button when Chrome offers one. When the admin creates an account, the invitation message links to it, and **Send the picture** shares the picture straight to WhatsApp on a phone (or downloads it on a laptop). Anyone who opens the app in a phone's browser sees a reminder on Home ("Show me how", or "Install" on Android) until they add it or tap "Not now".

## Tower A / Tower B (team only)

Every unit can carry its tower: **Tower A** or **Tower B**. The team sees it next to the building on cards ("P4A"), in the offer details ("Peninsula Four · Tower B") and in the AI assistant; clients and external agents don't get it. Peninsula Four has two towers, so its units without one are flagged "Tower A or B?", and Home and My units list them with Tower A / Tower B buttons: each agent sets their own units, the admin sets anyone's. The My units form has a Tower field and won't save a Peninsula Four unit without it. Units whose floor said "Tower A" or "Tower B" were set automatically.

## Agents invite clients

Every Orla agent can invite a client or an external agent: **Clients › Invite to the website**, or **Invite a client** on Home. The account is ready straight away. The agent gets the same message the admin sends (sign-in link, email, password, the home-screen guide link, signed with their name), a button that opens WhatsApp straight to the client's number, and the home-screen picture to send. Below, "People you invited" shows who has signed in. Agents can only create client and external-agent accounts (up to 40 a day each). The admin sees "Invited by …" in Users, and every invitation is in Activity.

## What the AI assistant knows

`lib/knowledge.js` gives the assistant, on every request, Talal's playbook (the rules he set while building the app: no "over market", show below-market homes, three options with a big gap, sales offer style, privacy, the team goal, Tower A/B), the building facts and drive times, the fees and mortgage assumptions, the DLD market figures and comparable sales, and the full text of his November 2026 decks (2 Bedroom Selection, 1 Bedroom Selection, Investor Selection, Studios for Rent). It's cached, so it costs little after the first request. With its tools it searches every offer live, picks three options (premium, middle, value), prepares the sales offer with the client's name, checks the team's progress, finds units and contacts and writes portal listings. In basic mode (no key) it still finds three options when an agent types a request like "2 bed to buy, budget 3.5M".

## CEO account and team chat

The admin creates the CEO's account in **Admin › Create an account › CEO** (nobody can sign up as CEO). The CEO sees Home, Offers, Team performance, Brochures and the Team chat, like the team but without unit numbers or owners, and changes nothing: no listings, contacts, AI assistant, invitations or admin (the server refuses them). The CEO's Home is one page: team units, online against the goal, client requests this week, days left, a table per agent (units, online, partly, off market, requests in the last 30 days, clients invited and signed in, progress to the goal), the latest chat messages and the offers count.

**Team chat** (top bar, or More on a phone) is one group for the admin, the agents and the CEO. It refreshes every 15 seconds, shows an unread count, and each person can delete their own messages (the admin any). Agents are asked not to post owners' or clients' numbers there.

## Buildings and unit types

From Select Group's material: Peninsula One is one 36-floor tower with simplexes in the podium and on the waterfront; Two (36 storeys) and Three (49 floors) are single towers with studios, 1 and 2 bedrooms; Four, The Plaza, is the only building with two towers (Tower A and Tower B, 52 floors) with studios to 4 bedrooms and 16 duplex lofts; Five is one 36-storey tower (3-bed semi-penthouses at the top) plus two waterfront duplex blocks (1 to 4 bedroom duplexes). Units carry `beds` (0 to 4) and `layout` (simplex, duplex, loft, semipenthouse). The My units form offers only the types of the chosen building and the Tower field only for Peninsula Four; Offers filters by 4 bedrooms, Simplexes and Duplexes & lofts. Towers set on other buildings were removed, and the Peninsula One podium home is marked as a simplex.

## Market comparisons (DXB Interact)

The admin uploads an export of registered deals (DXB Interact or DLD, Excel or CSV) in **Admin › Market deals**; the columns are matched automatically, sizes in square metres are converted, and only Peninsula One to Five rows are kept. On any unit's page the team gets **Market comparison**, and the AI assistant answers "compare unit 1203": same building and type, last 12 months (24 if fewer than 3 deals), similar sizes first, with the average and range per sq ft (or rent), the median, the latest deals, and the unit's position. **Copy for the client** leaves out the position unless the unit is under the average; **Copy full** is for the agent. DXB Interact has no public API we can use, so the data comes in by export.

## Peninsula contacts (team only)

The admin uploads the Peninsula contacts database in **Admin › Peninsula contacts**: an Excel (.xlsx) or CSV file. The app matches the columns itself (name, phones, email, building, unit, type, size, floor, view, owner or tenant, nationality, notes); you can change any match before importing, and other columns are kept as extra details. Choose **Replace all contacts** or **Add to existing**. The file is read in your browser and sent to the database in parts.

In the **AI assistant**, an agent types a client's phone number (any format: 050…, +971 50…, 97150…), a unit number or a name. The contact shows with Call and WhatsApp, the unit details, and three buttons: **Create sales offer** (enter the price and it makes the same one-page PDF, prepared for the client), **Add to My units** and **Write the listing**. Only the Orla agents and the admin can search the contacts; clients and external agents can't.

**First listing keeps the client.** When an agent saves a listing in My units with the unit number (and building) or the client's phone, that client is theirs. Any other agent who searches the phone, the unit or the name sees only "Client taken by Giulia", with no name, phone or details. The agent who listed it sees "Your client"; the admin sees everything, marked "Listed by …". If a second agent saves a listing for the same client, they get a warning that it's already taken. If the listing is deleted, the client is free again (or passes to the next agent who listed it). Offers that carry a unit number or owner phone under an agent count the same way. Each search is limited to 300 an hour per agent and shows in Admin › Activity. The Excel reader is read-excel-file (MIT), in `app/vendor`.

## Brochures & plans (team only)

More › **Brochures & plans** is the team's library, filtered by building (P1–P5, Community) with search. It starts with the floor plans and every building's photos and renders that are in the app. Anyone on the team can add a brochure, floor plan, price list or payment plan as a file (PDF, JPG, PNG, up to 60 MB, uploaded in 2 MB parts to stay under Vercel's request limit) or as a link, and open, download or share it (on phones, Share sends the file straight to WhatsApp). Each offer has a button to its building's documents. Clients and external agents can't open it.

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
   | `ANTHROPIC_API_KEY` | For the AI assistant | An API key from console.anthropic.com. Without it the assistant runs in basic mode |
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
