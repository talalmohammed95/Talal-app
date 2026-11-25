# Peninsula Offers

An offline app holding every Peninsula (Business Bay) sale and rental offer from the Nov 2026 decks and flyers:
20 offers, plus:

- **Dashboard**: active stock, sale value, average yield, follow-ups due, best entry price per type, figures to confirm
- **Present to client**: full-screen offer sheets with no internal notes; swipe or tap to move between offers
- **Clients**: stage, budget and follow-up date for each client, matching offers and saved shortlists
- **Price & status updates**: mark offers Reserved, Under offer, Sold or Rented, or change a price
- **Deal & mortgage calculator**: total cost, yield, break-even, resale return, monthly payment, cash needed upfront
- **Market data**: DLD-registered sales and rents
- **My listings** (same columns as the Peninsula 3 Listings sheet) and **Backup & restore**
- **Login page**: a device PIN with lockout after 5 wrong tries and an automatic lock when idle
- **Admin backend**: add, edit and delete offers, set statuses, fees, agents and a team announcement, and copy every offer as CSV

## Two versions
- **Team version (claude.ai artifact):** people sign in with their claude.ai account. Admins are the people with Edit access in the Share menu; Contributors are agents. Offers and settings live in a shared database that only admins can change, and each agent's clients are private to them.
- **This standalone copy (`app/`):** runs on one device with no server, so the login is a PIN and whoever unlocks it is the admin. Data stays on the device; use Backup to move it.

The app is in `app/`. It's a single `index.html` with no build step.

## Run it on an iPad
1. Host the `app/` folder over HTTPS (for example GitHub Pages, Netlify Drop or Cloudflare Pages).
2. Open the link in Safari, then tap Share › Add to Home Screen.
3. After the first launch the service worker caches the app, so it opens offline from the home-screen icon.

Listings you add and your shortlist are stored on the device (localStorage).
