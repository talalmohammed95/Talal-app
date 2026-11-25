# Peninsula Offers

Orla Properties' app for every Peninsula (Business Bay) sale and rental offer from the Nov 2026 decks and flyers. It includes a dashboard, client presentations, a client tracker, deal and mortgage calculators, market data, a login page and an admin backend.

The app is in `app/`. It's a single `index.html` with no build step.

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
4. **Allowed web addresses.** Under **Authentication › URL Configuration**, set **Site URL** to the address where the app is hosted, for example `https://talalmohammed95.github.io/Talal-app/app/`. Add the same address to **Redirect URLs**. The confirmation and password-reset links return there.
5. **Connect the app.** Under **Project Settings › API**, copy the **Project URL** and the **anon public** key into `app/config.js`, then commit. The anon key is meant to be public; the access rules protect the data.
6. **Register the admin first.** Open the app, tap **Create an account** and register with the admin email, then confirm it from your inbox. That account becomes the admin and is approved automatically. Everyone else who registers waits for your approval.

Then share the app's address with your agents. Once they've registered, approve them in Admin › Users.

Already ran an earlier version of `setup.sql`? Run the new one too. It upgrades the database in place: everyone who already had access keeps it.

## Run it on an iPad

Host the `app/` folder over HTTPS, for example on GitHub Pages (Settings › Pages) or Netlify. Open it in Safari and tap Share › Add to Home Screen. Offers you've already loaded stay viewable offline.

If `app/config.js` is left empty, the app runs on that one device only, with a PIN instead of accounts.

## The claude.ai version

The shared claude.ai artifact signs people in with their claude.ai accounts instead. Admins there are people with Edit access in the Share menu. It can't use email and password sign-in, because claude.ai pages can't connect to outside services.
