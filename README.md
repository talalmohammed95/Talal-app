# Peninsula Offers

An offline app holding every Peninsula (Business Bay) sale and rental offer from the Nov 2026 decks and flyers:
20 offers, a cost and yield calculator, DLD market data, a client shortlist, and an "Add listing" form whose columns match the Peninsula 3 Listings sheet.

The app is in `app/`. It's a single `index.html` with no build step.

## Run it on an iPad
1. Host the `app/` folder over HTTPS (for example GitHub Pages, Netlify Drop or Cloudflare Pages).
2. Open the link in Safari, then tap Share › Add to Home Screen.
3. After the first launch the service worker caches the app, so it opens offline from the home-screen icon.

Listings you add and your shortlist are stored on the device (localStorage).
