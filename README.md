# Peninsula Offers

Orla Properties' app for every Peninsula (Business Bay) sale and rental offer from the Nov 2026 decks and flyers. It includes a dashboard, client presentations, a client tracker, deal and mortgage calculators, market data, a login page and an admin backend.

The app is in `app/`. It's a single `index.html` plus a few small files. `npm run build` (run by Vercel) copies it to `dist/` and writes the Supabase settings into `dist/config.js` from environment variables.

## How sign-in works

| | Who | What they can do |
| --- | --- | --- |
| **Admin** | One account only: the email you put in `supabase/setup.sql` | Everything, plus the Admin tab: approve or decline new accounts, block users, add, edit and delete offers, statuses, fees, agents, the team announcement and the activity log |
| **Agent** | Anyone who registers, confirms their email and is approved by the admin | Browse offers, present them, keep their own private clients, shortlists and listings |

- Anyone can register, but nobody gets in without the admin's approval. A new user confirms their email from a link, then sees **Waiting for approval** until the admin taps **Approve** in Admin › Users. The Admin tab and the dashboard show how many accounts are waiting. Declined or blocked users can't sign in.
- Forgotten passwords are reset by email.
- The database enforces the rules, not just the app. Only the admin can change offers or settings. Nobody can promote themselves. A second admin is impossible. Pending, declined and blocked users see nothing.
- Each device can also add a PIN lock (My listings › Login & security).

## Set it up (about 15 minutes)

1. **Create the database.** Sign up at [supabase.com](https://supabase.com) and create a free project. Pick a region close to Dubai, such as Frankfurt or Mumbai.
2. **Run the setup script.** Open `supabase/setup.sql`. On the line `insert into public.app_config values ('admin_email', lower('admin@your-company.com'))`, replace the email with the admin's email. In Supabase, open **SQL Editor**, paste the whole file and press **Run**. This creates the tables and access rules and loads the 20 offers.
3. **Email sending.** Supabase's built-in email only sends to members of your Supabase team, and only a few emails an hour. For open registration, set your own SMTP under **Authentication › Emails › SMTP Settings**. Any provider works, for example Bird, Resend, SendGrid or your Google Workspace. Keep **Confirm email** switched on under **Authentication › Sign In / Providers › Email**.
4. **Deploy on Vercel.** See [Deploy on Vercel](#deploy-on-vercel) below.
5. **Allowed web addresses.** In Supabase, under **Authentication › URL Configuration**, set **Site URL** to your Vercel address, for example `https://peninsula-offers.vercel.app`. Add it to **Redirect URLs** too, plus `https://peninsula-offers-*.vercel.app/**` so preview deployments work. The confirmation and password-reset links return there.
6. **Register the admin first.** Open the app, tap **Create an account** and register with the admin email, then confirm it from your inbox. That account becomes the admin and is approved automatically. Everyone else who registers waits for your approval.

Then share the app's address with your agents. Once they've registered, approve them in Admin › Users.

Already ran an earlier version of `setup.sql`? Run the new one too. It upgrades the database in place: everyone who already had access keeps it.

## Deploy on Vercel

1. In Vercel, choose **Add New › Project** and import `talalmohammed95/Talal-app` from GitHub. Leave **Framework Preset** as **Other**; `vercel.json` sets the build command (`npm run build`) and the output folder (`dist`).
2. Before pressing **Deploy**, open **Environment Variables** and add these two, for **Production** and **Preview**:

   | Name | Value (from Supabase › Project Settings › API) |
   | --- | --- |
   | `SUPABASE_URL` | Project URL, e.g. `https://abcd1234.supabase.co` |
   | `SUPABASE_ANON_KEY` | The **anon public** key (or the **publishable** key) |

   If you connect Supabase through Vercel's Supabase integration instead, the names it creates (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`) work too.
3. Press **Deploy**. Every push to GitHub then deploys automatically.

The build protects you from common mistakes:
- With no Supabase settings, the deployment **fails** with a message saying which variables to add, instead of going live without sign-in.
- If the **service_role** or secret key is pasted by mistake, the build refuses it, because that key must never reach a browser.
- The 20 starting offers are left out of the published page, so only signed-in, approved users can see offers.
- Each deployment gets a new cache name, so installed iPads update on their next launch.

After changing an environment variable, redeploy (Deployments › ⋯ › Redeploy) for it to take effect.

**Production branch:** Vercel publishes the repository's default branch (`main`) as the live site. Merge this work into `main`, or set **Settings › Git › Production Branch** to the branch you deploy from.

To build locally: `SUPABASE_URL=… SUPABASE_ANON_KEY=… npm run build`, then serve the `dist/` folder. `ALLOW_LOCAL_MODE=1 npm run build` builds the device-only version (PIN lock, no accounts, offers stored on the device).

## Run it on an iPad

Open your Vercel address in Safari and tap Share › Add to Home Screen. It opens full screen like an app. Offers you've already loaded stay viewable offline.

## The claude.ai version

The shared claude.ai artifact signs people in with their claude.ai accounts instead. Admins there are people with Edit access in the Share menu. It can't use email and password sign-in, because claude.ai pages can't connect to outside services.
