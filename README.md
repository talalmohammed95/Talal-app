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

**How it thinks.** It runs on Claude's strongest model, reasons through each question before answering (adaptive thinking, high effort), checks facts with its tools instead of guessing, and suggests the next step. Replies appear as they're written, with what it's doing ("Finding the unit…", "Searching the web…").

**Photos and PDFs.** The paperclip sends up to 5 photos or a PDF of up to 3 MB (a title deed, a floor plan, a screenshot of a Bayut ad or a WhatsApp chat, a contract). Photos are resized on the phone first. You can also paste a screenshot or drag files in on a laptop. It reads them, for example to pull the unit details out of a title deed into a listing. Files aren't stored: they go to the AI with that one message.

**The web.** It can search the web and read web pages (Dubai market news, DLD and RERA rules and fees, Golden Visa, mortgage rates, a link the agent sends) and says where the information comes from. It never puts an owner's or client's name, number or unit in a search. Web search must be allowed for the Anthropic account (Claude Console › Settings › Privacy, if it's off).

**Memory.** The chat stays on the device, even after closing the app (the last 40 messages), so it remembers the client and unit being discussed. **New chat** starts fresh.

**Voice notes.** The microphone next to Send records a voice note in English, Arabic, Russian, German or Italian (the small selector; it remembers the choice). The words appear as you speak; it sends when you tap Send or stop talking for a few seconds, and the message shows as a voice note. It uses the browser's own speech recognition (Safari on iPhone, Chrome on Android and computers), so no other service is involved; the site's `Permissions-Policy` allows the microphone for this site only. Where a browser can't, the keyboard's own microphone works too.

**The whole database.** Besides homes, units, owners and contacts, the assistant can look up: the agents' client lists (Clients page), client requests from the website, the Peninsula contacts by building and bedrooms, app accounts and their activity, tasks, website visitors, imported DXB Interact or DLD deals, the Brochures & plans library, and the team's pace to the goal. It combines them (for example, follow-ups due today with homes that match each client's budget). It only receives what the person asking may see: the admin and the CEO see everything, an agent sees their own clients, owners, requests and tasks, and accounts and visitors are for the admin and the CEO. Lookups of clients, requests, accounts and contacts are written to Activity.

## Home-screen guide

`/home-screen/` is a page, with the picture `app/img/home-screen-guide.jpg`, showing how to put Peninsula on an iPhone (Safari: Share, Add to Home Screen, Add) or Android (Chrome: ⋮, Add to home screen or Install app) home screen. It shows the steps for the visitor's phone, and on Android an Install button when Chrome offers one. When the admin creates an account, the invitation message links to it, and **Send the picture** shares the picture straight to WhatsApp on a phone (or downloads it on a laptop). Anyone who opens the app in a phone's browser sees a reminder on Home ("Show me how", or "Install" on Android) until they add it or tap "Not now".

## Tower A / Tower B (team only)

Every unit can carry its tower: **Tower A** or **Tower B**. The team sees it next to the building on cards ("P4A"), in the offer details ("Peninsula Four · Tower B") and in the AI assistant; clients and external agents don't get it. Peninsula Four has two towers, so its units without one are flagged "Tower A or B?", and Home and My units list them with Tower A / Tower B buttons: each agent sets their own units, the admin sets anyone's. The My units form has a Tower field and won't save a Peninsula Four unit without it. Units whose floor said "Tower A" or "Tower B" were set automatically.

## Owners follow their property

Right after an agent saves a unit in My units with the owner's name and mobile, the app offers **Invite on WhatsApp**: one tap makes the owner's account (no email needed: they sign in with their mobile number) and links it to that listing; the next opens WhatsApp to the owner's number with a message from the agent explaining the website, the sign-in and password, and the home-screen guide. The same button is on the owner card of the agent's unit (and **Send the invitation again** gives a new password). An owner who already has a client account gets the property added to it.

When the owner signs in, Home starts with **Your property**: the unit, size, floor, view and price; whether it's live on Bayut and Property Finder (or coming soon, or shared privately); how many people opened it on the website (in total and this week); viewing and other requests; and the agent's photo with WhatsApp and Call. The owner sees only their own property. Only the invitation links an owner to a listing, so a later save can't remove or change it, and agents can invite only the owners of their own units.

The sign-in screen accepts an email or a mobile number.

## Agents invite clients

Every Orla agent can invite a client or an external agent: **Clients › Invite to the website**, or **Invite a client** on Home. The account is ready straight away. The agent gets the same message the admin sends (sign-in link, email, password, the home-screen guide link, signed with their name), a button that opens WhatsApp straight to the client's number, and the home-screen picture to send. Below, "People you invited" shows who has signed in. Agents can only create client and external-agent accounts (up to 40 a day each). The admin sees "Invited by …" in Users, and every invitation is in Activity.

## What the AI assistant knows

`lib/knowledge.js` gives the assistant, on every request, Talal's playbook (the rules he set while building the app: no "over market", show below-market homes, three options with a big gap, sales offer style, privacy, the team goal, Tower A/B), the building facts and drive times, the fees and mortgage assumptions, the DLD market figures and comparable sales, the full text of his November 2026 decks (2 Bedroom Selection, its Original Prices version, 1 Bedroom Selection, Investor Selection, Studios for Rent), and the 17 one-page sales offer flyers from the Peninsula Three Sales & Rental Offers design (Talal's, Giulia's and Blendjana's). Nothing with owners' names, owners' phones or unit numbers is included, because every agent's assistant reads it; the Peninsula 3 Listings sheet stays out for that reason. It's cached, so it costs little after the first request. With its tools it searches every offer live, picks three options (premium, middle, value), prepares the sales offer with the client's name, checks the team's progress, finds units and contacts and writes portal listings. In basic mode (no key) it still finds three options when an agent types a request like "2 bed to buy, budget 3.5M".

## CEO account and team chat

The admin creates the CEO's account (Munir Al Deraawi, always addressed as "Mr Munir" by the website, the emails and the assistant) in **Admin › Create an account › CEO** (nobody can sign up as CEO). The CEO sees everything the admin sees: every unit number and owner, every agent's own listings, the Peninsula contacts (with who has each client), and all client requests. Agents still see only their own owners. The CEO uses the AI assistant with that full view, and trains it (below). The CEO doesn't create or edit listings, invite people, mark requests done, or open Admin: settings and accounts stay with the admin. The CEO's Home: team units, online against the goal, requests this week, days left, a table per agent, the open requests, the latest chat messages, and buttons for the assistant and the training.

**AI training** (More › AI training; the CEO and the admin) teaches the assistant in three kinds of notes: **Rules** (always or never do), **Knowledge** (market, buildings, negotiation, scripts) and **Quick questions** (shown as buttons in the assistant). Notes can be edited, paused or deleted; up to 60,000 characters in all. The assistant gets them on every question, after its fixed knowledge and with priority over it, cached like the rest. Every change is in Activity.

**Team chat** (top bar, or More on a phone) is one group for the admin, the agents and the CEO. It refreshes every 15 seconds, shows an unread count, and each person can delete their own messages (the admin any). Agents are asked not to post owners' or clients' numbers there.

## App users (the admin and the CEO)

**More › Users & visitors** starts with **App users**: how many accounts there are in the Orla team, external agents and clients, how many were active this week (opened the app in the last 7 days) and how many are new; three small charts of active users per day (one per group, same scale); and every account in a list with type, last active, days active in the last 30, homes viewed, viewing or details requests sent, who invited them and when they joined. Filter by group or "Never opened", and search by name, email or agency. Accounts waiting for approval and blocked ones are marked. Activity comes from the app's visit counter (linked to the signed-in account) and sign-ins.

## Website visitors (the admin and the CEO)

Every page of the website (English, Russian, German, Italian, the home-screen guide) and the app loads `track.js`, which records an anonymous visit: a random id kept in that browser (no cookies), the page, where the visitor came from (the referring site or `?utm_source=`), the country (from Vercel), the device and, in the app, which homes were opened. No names, emails or IP addresses are stored; bots and automated browsers are skipped; visits older than 400 days are deleted. The Orla team's own visits (admin, agents, CEO) are recorded as team and left out of the numbers.

**More › Users & visitors** then shows visitors per day (each person once a day) for 7, 30 or 90 days, with a hover for new, signed-in and pages viewed, and a table view; today, yesterday, the last 7 days, the period, the daily average and the best day; new accounts; where visitors come from (Google, Instagram, Bayut, Property Finder, direct or WhatsApp…), what they open, countries, devices, and the most viewed homes. The CEO's and the admin's Home show a small Website visitors card, the morning email adds yesterday's visitors (against the same day last week) and the last 7 days, and the weekly summary adds the week's visitors. Tip: links shared on Instagram or in campaigns can end with `?utm_source=instagram` to be counted by name.

## Daily pace to the goal

Each agent should have `goal × (days since the start ÷ days in the period)` listings online on both platforms by today (from 20 Nov to 31 Dec, 15 each). On the first visit of each day:
- an **agent** sees where they stand: **behind** (red, with how many a week gets them to 15), **very close** (one listing short, a little more as the target grows), **on track** or **goal reached**, with a progress bar, the marker for today, and a button to My units. Their Home also shows the line under the greeting.
- the **CEO** and the **admin** see who's behind, close, on track and done, with each agent's online, expected and weekly need; tapping an agent opens their review; **Share on WhatsApp** and **Copy** send the same summary. The CEO's team table has a **Pace** column.

Every morning at 9:00 Dubai time, Vercel Cron (`/api/cron/daily`) emails the team pace to the CEO and the admin when email is set up, and on Sundays sends the weekly summary as well.

## The CEO's weekly summary

Every Sunday at 9:00 Dubai time (05:00 UTC), the daily Vercel Cron (`/api/cron/daily`, see `crons` in `vercel.json`) also makes the weekly summary. It builds the week's summary once and saves it: team units and online against the goal, units added and gone online this week, client requests and viewings, clients invited, tasks done and overdue, how many listings a week the team needs to reach the goal, the top achiever, who made the most progress, and per agent (units, online with the change from last week, new units, requests, registration quality, tasks). When email is set up (SMTP), it's emailed to the CEO and the admin. The CEO's Home and the admin's Home show a **Weekly summary** card; **Read it** opens this week so far and the last 8 weeks, with **Share on WhatsApp** and **Copy**. The admin also has **Email it now**. Optional: set `CRON_SECRET` in Vercel so only Vercel can trigger it (otherwise it accepts Vercel's cron and runs at most once a week).

## Agent review and tasks (the admin and the CEO)

**More › Agent review** (or tap an agent in the CEO's table) shows one agent at a time: units, online on both platforms against the goal, partly online, off market, client requests in the last 30 days, clients invited, and a registration-quality score. **How the units are registered** lists every unit the agent has (My units and offers), incomplete ones first, with what's missing: unit number, owner, owner phone, size, floor, view, price, furnishing, status, tower (Peninsula Four) and whether it's online. **Task: complete the missing details** fills a task with the list.

**Tasks** are private: the admin or the CEO gives one to an agent (with a due date and notes), and only that agent, the admin and the CEO see it. They show on the agent's Home (overdue ones in red), and the agent ticks them done.

## Price approval (over 7% above the market)

We list homes up to 7% above the market. Above that, the admin approves first. The market is the DXB Interact registered deals for the building, bedrooms and layout: price per sq ft × size for a sale, the average rent for a rental.

- **While typing the price** (My units), a line shows the market and how far above it the price is. Green means it goes online straight away; amber or red means it needs Talal's approval, with the highest price that doesn't.
- **Saving above 7%** opens "Price approval". It shows the market, the agent's price and the highest price that needs no approval. The agent picks why the home is worth more (fully renovated, upgraded finishes, premium furniture, exceptional view or floor, bigger or rare layout, owner's firm price, other) and explains it: what was done, when, the cost. A warning shows over 10%. "Change the price" goes back to the price instead.
- **While waiting:** the listing shows "Waiting for price approval". It stays in the agent's units, isn't published on the website (a shared offer is kept team-only) and can't be ticked online on the platforms.
- **The admin** (and the CEO) get a phone notification and a **Price approvals** panel at the top of Home. Each row shows the agent, unit, price, +%, market, number of photos and the reason, with a note box and **Approve** or **Not approved**. The home's page shows the same box. The agent is notified of the decision with the note.
- **Approved:** the listing can go online, and stays approved while the price stays the same. **Not approved:** the agent sees the note and a "Change the price" button. Any new price over 7% asks again.
- The admin's own listings are approved automatically. Agents editing an offer directly can't go over 7% there.
- Prices are stored in `priceReview` on the listing (status, category, reason, %, market, who asked, who decided, note). The decision route is `POST team/price-review`.

The motivation card's messages also push expertise and negotiation: knowing the deals, the price per sq ft and the building, and pricing it right.

## Staying open on the phone

- **Sign-in lasts a year from the last use.** Every day someone uses the app, their sign-in is pushed back to a full year. People who use it stay signed in.
- **PIN lock:** when the phone closes the app in the background, reopening it doesn't ask for the PIN again unless the person was really idle longer than their setting (5, 15 or 60 minutes). With "Never", that phone never asks again.
- **Back where you left off:** reopening goes to the same page, scrolled to the same place.

## Reminders (the AI reminds you)

Tell the AI assistant "remind me tomorrow at 10 to call Valeria about 2107", "remind Giulia Monday at 9 to send Form A" (the admin and the CEO can set reminders for agents), "what reminders do I have this week?" or "mark the Valeria one done". It also offers a reminder when something needs a follow-up. Every time is Dubai time.

- **On Home** (agents, the admin and the CEO, near the top): one Reminders panel for everything to follow up on. It has a quick add form, your reminders (Done, +1 hour, delete), **clients to call back** (follow-up date today or past, with Call and WhatsApp) and **listings to follow up** (reminder dates from My units, due or within 3 days). The badge counts what's due.
- **When a reminder is due:** it goes to the phone as a notification (for anyone who turned notifications on), and pops up in the app with Done and "Remind me in 1 hour".
- **Every morning** (with the 9:00 daily run): each team member gets a notification with today's reminders, client follow-ups due and open requests.
- **Delivery:** due reminders are sent with any request the app makes, at most once a minute, so while the team uses the app they arrive on time. To get them on time even when nobody has the app open, point a free scheduler (e.g. cron-job.org) every 5 minutes at `https://<your-site>/api/cron/reminders?key=<CRON_SECRET>`, with `CRON_SECRET` set in Vercel. Vercel's own free cron only runs once a day.

The reminders are in the `reminders` table (`lib/reminders.js`). The AI uses the `reminder_set`, `reminders_list` and `reminder_update` tools.

## Peninsula Stars (the team competition board)

At the top of the Team page, for the admin, the CEO and every agent:
- **Star of the week:** the agent with the most points this week. Points are 1 per unit added, 2 per listing online on every platform, and 1 per viewing booked through the website. Weeks run Monday to Sunday, Dubai time.
- **Leaderboard squares:** one square per agent, ranked by listings online. Each shows a ring that fills towards the goal, gold, silver and bronze for the top three, a 🔥 streak (days in a row with a new unit), and units, viewings (last 5 weeks) and deals (homes marked Sold or Rented).
- **This week's winners:** most units added, most listings online, most viewings, best priced (share of listings within 7% of market) and longest streak.
- **Achievements:** First listing, Five online, Ten online, Goal hit, Price pro (every listing within 7%), On fire (5-day streak), Closer (a home sold or rented) and Show-runner (8+ viewings). Faces show who has each one; grey means nobody yet.

The numbers come from `GET team/performance`, which adds `addedDates`, `viewingDates` and `deals` per agent. The samples it was picked from are in the Claude artifact "Peninsula Stars Board".

## A push after every listing (agents)

Every time an agent adds a unit, or a listing goes online on every platform (from My units or the Team page), a short card comes up from the bottom. It has:
- a quick message, rotating so it doesn't repeat: "Unit in. Now get it online." or "Live. It's working for you now. You're one listing closer to your next deal.";
- their progress bar to the goal (e.g. "1 of 15 online · 14 to go · 3 a week keeps you on track");
- **Add the next unit**, which opens a fresh My units form.

The card closes by itself after 15 seconds. The messages are in `MOTIV` in the app; the admin and the CEO don't get it.

## Photos of a listing (agents)

Editing and photos are one tap from wherever the agent is:
- **My units:** under every unit there's **Edit**, **Add photos** / **Photos (n)** and **Download**.
- **The home's page:** under the gallery, **Add photos**, **Edit listing** and **Download all n photos**.
- **Full-screen photos:** a **Download** button for the photo on screen.
- **The form:** "Photos of this home" has **＋ Add photos** (several at once, resized in the phone) and, on each photo, **Make cover**, **Download** and **Remove**. The first photo is the cover. "Add photos" opens the phone's photo picker straight away and goes to that section. **Save changes** stays in view at the bottom of the screen while editing.

Downloading on a phone opens the share sheet with every photo at once ("Save images" on iPhone puts them in Photos, ready for WhatsApp, Bayut or Property Finder). On a computer they download one by one. Photos are saved as JPEG and named after the building and unit, e.g. `Peninsula-Three-unit-1203-1.jpg`. Without the agent's own photos, the building's standard photos are what download.

A listing shared as an offer passes its photos to the offer. The 7%/10% price rule applies to a new or changed price only, so a listing whose price isn't changing can always be edited.

## Agents edit their own homes
On a home listed under their name, an agent taps **Edit this home** and gets the same editor as the admin: headline, building, type, sale or rent, status (available, reserved, under offer, sold, rented), price, rent, size, floor, view, furnishing, cheques, deposit, highlights, the unit number and owner, and photos and the floor plan. It saves for everyone straight away, price and status changes go into the home's history, and it shows in Admin › Activity. They can't move a home to another agent or change whether it counts in team performance (only the admin can), and they can't edit homes listed under someone else. Their own units in My units were already editable there. The admin also has **Edit this home** on every home.

## New on the team
When an agent adds a unit (in My units, or an offer under their name), everyone else on the team sees it first thing the next time they open the website: a pop-up with the agent's photo, the type, building, floor, size, view and price, an **Open** button when it's shared as an offer, and **Message Giulia** (WhatsApp) to say they may have a client. It comes before the welcome screen and the pace message, and shows only units added since they last saw it. Home keeps a **New on the team this week** list. Teammates see the floor (from the unit number if none is written), never the unit number or the owner; the admin, the CEO and the agent who added it see the unit number.

## Your guide to the Peninsula (3D)

A guide to the community, not a sales page. It's a card on Home ("Your guide to the Peninsula", with buttons for Cafés & dining, Shops & services, Sports, Parks & walks and Getting around), a button in every home's Sun & views, and the public website's "Explore the community in 3D" button (`/app/?guide=1`). It opens a full-screen 3D model of the community:

- **Places pinned on the model,** coloured by kind:
  - the Community Mall (66,000 sq ft and 23 shops: supermarket, pharmacies, salons, healthcare, cafés);
  - the canal promenade (cafés, restaurants and shops) and the waterfront walk;
  - The Plaza (the central square with fountains) and the community park;
  - the tennis and padel courts and the 3-on-3 basketball court;
  - the main entrance, the drop-off and parking, the central roundabout and the canal waterfront.
- **Filters** show one kind at a time, with names. With everything shown, pins are icons, and a pin that would overlap a nearer one waits until the view turns.
- **Tapping a pin** flies the camera there and opens a card saying what it is.
- **The Guide list** has every place, including those the brochures name without a location (skate park, squash, kids' play area, running and cycling tracks), what's inside the towers for residents, and drive times to the Metro, Dubai Mall, DIFC, the airport and the beaches.
- **The sun:** a month dropdown, a time slider and "Now" move it, with real shadows. Download the model as .glb for Sketchfab.

Everything comes from Select Group's brochures (Peninsula One, Two and Three) and the master plan, which is from the Peninsula Two brochure: its highlighted tower is **Peninsula Two** and the highlighted block is **the Community Mall**. Places, buildings and heights are in `app/models/peninsula-community.json`:
- `places` hold x, y (fractions of the plan), a category, a name and a description; `unpinned` are places without a location; `around` are the drive times.
- Heights are approximate. Peninsula Two is 140 m (36 floors); the other buildings aren't identified on the plan, so they're 40 to 170 m.
- **Named places** (`venues` in the same file, checked 28 Nov 2026) are on the place's card and at the top of each category in the Guide, marked **Open** or **Announced**:
  - **Black Sheep Coffee**, open at Peninsula Three, ground floor (Retail 1). Source: Caterer Middle East and Deliveroo.
  - **Half Cup** (café), **Freedom Pizza**, **Spinneys** (supermarket) and **Yas Healthcare** (clinic), named by Select Group as confirmed Community Mall tenants. Source: Arabian Business and CBN Middle East.

  Names seen only on one listing and contradicted elsewhere (Drinkit, Katrina Coffee & Cakes, Mordi) are left out. Add new places to `venues` with `st: "open"` once they're open.

three.js 0.170.0 (`app/vendor/three-0.170.0`, MIT) loads only when the guide opens.

## Google Maps in the guide

The guide has two views at the top: **3D guide** and **Google Maps**. The Google Maps view shows Google's live map around the Peninsula, with buttons for The Peninsula, cafés, restaurants, supermarkets, pharmacies, clinics, gyms, salons and parks. Visitors see Google's own names, reviews, opening hours and photos without leaving the website, and "Open in Google Maps" takes them to the app.

Every named place and the Community Mall also have **Google Maps** and **Directions** links. "Google Maps around us" on the Home card opens the map straight on cafés.

It works without any setup: Google's plain map shows the search. For a richer map that pins every result, add a free **Maps Embed API** key:
1. In Google Cloud, create a project and enable "Maps Embed API". It's free with no usage limit, but Google may ask for a billing account.
2. Create an API key. Restrict it to "Maps Embed API" and to the website's address (HTTP referrers, e.g. `https://your-domain/*`).
3. Add it in Vercel as `GOOGLE_MAPS_EMBED_KEY` and redeploy.

The key is meant to be public (it's in the map's address), which is why it's restricted to the website.

## Speed

- `all()` (every home, with the market figures) is worked out once per redraw instead of dozens of times.
- The analysis and reports pages draw when they're opened.
- The 30-second refresh for signed-in users redraws only when something changed.
- The photo slideshows on Home and the public website load one photo at a time.
- On a phone slowed down 4×, a full redraw for visitors went from about 110 ms to 50 ms. A first visit loads 573 KB on the public website (was 938 KB) and 1.2 MB in the app (was 1.6 MB).

## 3D models and 360° tours

Any home can have a 3D model or 360° tour. In **My units** (and the admin's offer form) paste the link into "3D model or 360° tour (link)". Clients then see **Explore in 3D** (or **Walk through in 360°**) on the home's page. The viewer loads only when they tap it, so pages stay quick on a phone. It opens inside the page: drag to look around, pinch to zoom, full screen and VR where the viewer offers it.

Links that work:
- **Sketchfab:** `sketchfab.com/3d-models/…` or `sketchfab.com/models/…` (3D models).
- **Matterport:** `my.matterport.com/show/?m=…` (walk-through tours).
- **Kuula:** `kuula.co/share/…` (360° photo tours).
- **YouTube:** 360° videos (`youtube.com/watch?v=…` or `youtu.be/…`).

Anything else is ignored, and the server keeps only those sites when a listing is shared as an offer. A shared listing passes its link to the offer.

## Sun & views (every home)

Every home's page has a **Sun & views** card, for everyone including visitors:
- **The compass:** the sun's path over the Peninsula on the 21st of the chosen month, sunrise and sunset points, the Burj Khalifa direction, and a blue wedge for where the windows face.
- **Today's figures:** sunrise, sunset and hours of daylight, in Dubai time.
- **Month buttons and a time slider** to move the sun through the year and the day.
- **For each side the home faces:** roughly how many hours of direct sun its windows get in summer and in winter, and whether you see the sunrise or the sunset.
- **Two links:** "Sun and shadows in 3D" opens Shadowmap at the Peninsula for that month and time. "Map and 360° street view" opens Google Maps.

The sun is worked out in the app from the standard solar formulas (21 June: 05:30 to 19:13; 21 December: 07:00 to 17:35). The window directions come from the view in the brochure: on the Peninsula's plans, Burj Khalifa is to the north, the canal to the south and the skyline to the west. They're approximate, and the card says so. The Peninsula's map position is `PEN_LOC` in the app (25.1857, 55.2776, approximate). Check it against Google Maps and correct it if the 3D view opens off the buildings.

**Public website language:** one dropdown (globe, EN ▾) on every screen size, instead of the row of language codes. The sliding "this site in your language" hint is off. "Browse homes" at the top opens the homes list in the app directly.

## Open entry: look first, register later

Anyone who opens the website goes straight in and can browse the homes: Home, Homes, Find my home (the 4 questions) and the shortlist on their device. There's no sign-in wall. They see what the public website shows: starting prices, floor bands, no unit numbers or owners.

- **The registration box** comes later, as a friendly box from the bottom of the screen. It shows after 90 seconds of browsing, or when the visitor opens a fourth home, or after their first star on a home. The visitor picks: buying or renting (client), an agent at another agency, or on the Orla team. "I already have an account" signs in, and "Not now, keep browsing" closes the box. It shows at most twice a visit, at least 3 minutes apart, and never over another window. The **Sign up** button at the top opens it at any time.
- **Signing up is short**: name, mobile, email and one password. Clients are in straight away (after confirming their email when email is on). External agents and Orla agents still wait for the admin's approval. The sign-up page has "Just look at the homes" to go back.
- **Visitors can still reach the agent**: WhatsApp buttons work. Booking a viewing asks for a name and mobile, and the request reaches the agent and the admin like any other (marked as a visitor in Requests).
- **From the public website**: tapping a home opens it straight on its page in the app, and "Get 3 options" opens the questions.

## Starting prices for clients

When an agent has several homes of the same kind, a client sees only the cheapest one. "Same kind" means the same building, bedrooms, layout and sale or rent: for example Giulia's studios for sale in Peninsula Three. That home shows as a starting price ("From AED 1.19M"), with "+2 more studios, ask Giulia" on its card. Its page has a box: "Giulia has 2 more studios for sale in Peninsula Three … Ask Giulia for the full list", with a "See all 3 with Giulia" button. The button opens WhatsApp with a ready message and records the request. The agent and the admin get it as a details request, with a note saying which homes the client wants. The other homes aren't sent to the client's phone at all. This applies to signed-in clients and to the public website (all four languages). The team (the admin, the CEO and every agent) and external agents still see every home, with its own price, floor and unit as before. Sold and rented homes aren't grouped.

## Unit numbers (who sees them)
- **The admin and the CEO** see every unit number and owner, everywhere.
- **The agent a home is listed under** sees its unit number and owner.
- **The other Peninsula Stars** see the exact floor (worked out from the unit number when no floor is written: 1203 is the 12th floor), never the unit number or owner.
- **External agents and clients** see a low, mid or high floor only.

**Unit numbers to fill** (the admin's Team page): every home and listing that has no unit number yet, with likely units from the Peninsula contacts (same building and bedrooms, size within about 2%, same floor when known). Tap a suggestion or type the number, then Save. It shows in Admin › Activity.

## Unit numbers by agent (the admin's board)

On the Team page, **Unit numbers by agent** lists every home without its unit number under the agent who listed it, matching the "Peninsula Stars · Team Performance" report of 20–26 Nov 2026: Giulia 8, Talal 4 (including 2107, which has its number), Blendjana 3, Derya 1.

- **"Which agent listed these?"** at the top holds the 7 Peninsula Three offers that came from the market flyers ("priced from the lowest listing on Bayut / Property Finder"). They aren't in the report under any agent, so they're marked `needsAgent` (a migration, once) and wait for the admin to choose the agent. They still show Talal as the contact until then.
- **Each row** has **Listed by** (move the home to another agent), contact suggestions and the unit number box.
- **Each agent's group** has **WhatsApp [agent]**, a ready message listing their homes with a blank "Unit no." for each, and **PDF for [agent]**, a one-page form to fill and send back.
- **Agents** see **Unit numbers to fill** on their own Home with their homes and a box for each. They can fill only their own: `POST admin/unit-set` checks it, and `POST admin/offer-agent` is admin-only.
- **Reminding the team with a link:** the board opens with "N homes without a unit number, N agents" and **Remind everyone**, and each agent's group has **Remind [agent]**. That sends the agent a reminder straight away ("Fill the unit numbers of your N homes: tap to open them"). It arrives as a phone notification, a pop-up in the app (**Open now** / **Later (1 hour)**) and a row in their Reminders with **Open**. Each one opens `/app/#units`, the agent's **Unit numbers to fill** box, highlighted. **WhatsApp the link** sends the same link in a message. On a phone that isn't signed in, the link asks them to sign in and then opens the box. Arriving from a link skips the welcome pop-ups. When the agent fills their last number, the reminder closes itself. An agent without an app account gets no reminder (the toast says so); use WhatsApp for them.
- Reminders can carry a link to a place in the app (`link` on the reminder; `#units`, `#approvals`, `#reminders` or `#requests`).
- Unit numbers stay private: the admin and the listing agent only.

## Unit lookup (team home)
At the top of the team's Home: type any unit number (or a duplex number like G07), and pick a building if you know it. It shows, for each building where that number exists, the floor plan, layout, floor, size and view from the developer's brochures, and the owner if they're in the Peninsula contacts (with Call and WhatsApp; a client another agent already listed shows as taken, as everywhere else). **List this unit** or **List with this owner** opens My units already filled in. Every contacts lookup is logged as before.

## The best homes right now (home page)
Everyone's home page (the admin, the agents and clients) opens with the 3 best-value homes for sale and the 3 for rent. Only available homes count (not sold, rented or coming soon). They're ranked on price against the registered market: the deals imported from DXB Interact / DLD (averages for the same building and type over the last 12 months, or 24 if there are fewer than 3), otherwise the DLD and Bayut / Property Finder figures in the app. Then come rental yield for sales, a recent price cut and real photos, and one home per building and type where possible. Each card says why it's there ("15% under the registered average", "7.1% rental yield"). The team also sees the agent and the unit number; clients see a floor band. It updates by itself whenever prices, homes or the imported deals change. The same registered averages now also drive the value chips across the app. Only averages leave the server, never deal details.

## Viewing bookings and notifications
A client or external agent taps **Book a viewing** on a home, picks a day (the next 10 days) and a time (morning, afternoon or evening), checks their mobile and can add a message. Their WhatsApp opens with the message to the listing agent, and the booking is saved.

The admin and the listing agent are told straight away, with the person's name, type (client or external agent and company), mobile, email, the home (building, type, unit for the team, price, floor), the day and time, and the message:
- **On their phone:** a notification, even when the app is closed. Each person turns it on once on Home (**Viewing requests on your phone › Turn on**). On iPhone this works from the Home Screen app (Share › Add to Home Screen), iOS 16.4 or later. The push keys are made automatically and kept in the database; there's nothing to set up. Tapping the notification opens the requests.
- **In the app:** a pop-up with WhatsApp and Call buttons (the app checks every 45 seconds while it's open), and the request in **Requests** on Home with the booked time and message.
- **By email,** when SMTP is set up.

Mr Munir sees every request in the app too, without the notifications.

## Unit details from the brochures (team only)
The AI reads the developer brochures and floor plan books in Brochures & plans. A Dubai unit number is the floor and then the stack (1203 is floor 12, stack 03), so from each brochure's key plans it records every stack's layout, size, balcony, view and floor plan page. In Brochures & plans, the admin or the CEO taps **Read the brochures** (or **Read units** on one PDF). Each brochure takes 1 to 3 minutes, and their phone saves the floor plan pages as images for everyone. This needs `ANTHROPIC_API_KEY`.

After that, the website never says "on request" for the floor, view, size or floor plan:
- In **My units**, typing the unit number fills in the floor, view, size and type, and shows the floor plan. The agent changes anything that's different in their unit.
- Every unit with a number shows its floor, view and the brochure's floor plan in its page, in sales offers and in the admin's Team table. What the agent typed always wins over the brochure.
- **Find a unit in the brochures** (top of Brochures & plans) shows the layout, floor, size, view and plan for any unit number.
- The AI assistant uses it when an agent types a unit number.

**Built in: Select Group's brochures and floor plans for Peninsula One to Five** (sent by Talal, 27 and 28 Nov 2026). They're in Brochures & plans as PDFs to open, download or share (in `app/docs`, public files but not linked anywhere outside the team pages), with the Peninsula master plan. Every floor plan in them is a picture in `app/img/plans` and every unit type is in `lib/brochure-units.js` (by stack and floors: layout, total size with balcony, view, floor plan). Peninsula One and Two have a plan per unit type with sizes; Peninsula Three and Four have a plan per floor plate (Four: both towers) with views but no sizes per unit. So an agent who types a Peninsula One, Two or Four unit number gets the layout, size, view and floor plan straight away, without reading anything. Peninsula Five: tower plates and the Block 2 duplexes (units G01 to G12 and 401 to 406 match exactly), no sizes.

**The unit's floor plan, straight from its number.** As soon as an agent types a unit number in My units, its floor plan shows full width at the top of the form (open full size or share on WhatsApp), with the layout and size. When they save, the plan is saved with the listing; it shows right under the photos on the listing's page, in the sales offer (Floor plan is ticked by default) and in the AI's listing drafts. A plan an agent uploads themselves is kept instead.

**The unit marked on its floor plan.** Every unit in the brochures has its place on the plan: a yellow box around it on the floor plate (Peninsula Three, Four and Five), or around it on the small key plan beside the unit's own plan (Peninsula One and Two). The box shows wherever the plan of a known unit appears: the listing page, the photo gallery and full screen, the My units form, the Unit lookup and the plan search. It's also in the picture when the plan is opened full size or shared on WhatsApp. The boxes are in `lib/brochure-units.js` (`mark`: left, top, right and bottom as fractions of the plan picture) and the app draws them into a copy of the plan. The box only shows to whoever can see the unit number (the admin, the CEO and the agent the home is listed under), since it gives the unit away. Other agents and outside viewers get the plan without it.

**Floor plans by unit** (Brochures & plans): every floor plan page the AI found in the brochures, one card per plan, with the layout, building and tower, size, the units or stacks and floors it covers, and the view. Open it full size or share it on WhatsApp. The building buttons filter them, and typing a unit number in the search shows that unit's own plan.

A detail nobody has is simply left out instead of saying "on request". Clients still see a floor band and no unit numbers, and they get the floor plan through the agent.

## Every unit in full (the admin only)
On the Team page, "Units by agent" shows the admin every unit of every agent with nothing hidden: unit number, building and tower, type, size, floor, view, furnishing, price, the owner's name and phone (call or WhatsApp), whether it is online and when it was listed. Tap a row to open it. The CEO and the agents keep the summary view.

## Buildings and unit types

From Select Group's material: Peninsula One is one 36-floor tower with simplexes in the podium and on the waterfront; Two (36 storeys) and Three (49 floors) are single towers with studios, 1 and 2 bedrooms; Four, The Plaza, is the only building with two towers (Tower A and Tower B, 52 floors) with studios to 4 bedrooms and duplex lofts with 1, 2, 3 and 4 bedrooms; Five is one 36-storey tower (3-bed semi-penthouses at the top) plus two waterfront duplex blocks (1 to 4 bedroom duplexes). Units carry `beds` (0 to 4) and `layout` (simplex, duplex, loft, semipenthouse). The My units form offers only the types of the chosen building and the Tower field only for Peninsula Four; Offers filters by 4 bedrooms, Simplexes and Duplexes & lofts. Towers set on other buildings were removed, and the Peninsula One podium home is marked as a simplex.

**From the owners list.** The unit types in the owners list (Peninsula contacts) are added to each building's choices too, so lofts, duplexes, simplexes and 1 to 4 bedroom units the owners list has show in My units and in the sales offer from a contact. Types are read from the owners list's type column ("3 BR Duplex Loft", "Duplex 2BR", "4 BR"…), and the AI can browse owners by layout ("all duplex loft owners in Peninsula Four").

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
   | `CRON_SECRET` | No | Any long random text: only Vercel Cron can then run the weekly summary |
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
