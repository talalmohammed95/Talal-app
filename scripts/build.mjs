// Builds the site into dist/ and prepares the database. Vercel runs this on every deploy (see vercel.json).
//
//   DATABASE_URL  PostgreSQL connection string (Vercel › Storage › Neon sets it for you)
//   ADMIN_EMAIL   the one admin account's email
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM   optional, for confirmation and reset emails
//   APP_URL       optional, the site's address for links in emails (Vercel's own address is used otherwise)
//
// When a required setting is missing, the deploy still succeeds on Vercel but publishes a
// "Finish setup" page that lists what to add, and no app data. Locally and in CI the build fails instead.
//
// Locally: DATABASE_URL=postgres://... ADMIN_EMAIL=you@company.com npm run build
// Device-only version without a server (PIN lock, data on the device): ALLOW_LOCAL_MODE=1 npm run build
import { cpSync, rmSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";

const env = process.env;
const onVercel = !!env.VERCEL;
const dbUrl = (env.DATABASE_URL || env.POSTGRES_URL || "").trim();
const admin = (env.ADMIN_EMAIL || "").trim();
const localMode = env.ALLOW_LOCAL_MODE === "1" && !dbUrl;

// ---------- check the settings ----------
const problems = [];
if (!localMode) {
  if (!dbUrl) problems.push({
    title: "Connect a database",
    text: "In this Vercel project, open Storage, choose Create Database, pick Neon (free PostgreSQL) and connect it to this project for Production and Preview. That adds DATABASE_URL for you. Any other PostgreSQL works too: add its connection string as DATABASE_URL under Settings › Environment Variables."
  });
  else if (!/^postgres(ql)?:\/\//.test(dbUrl)) problems.push({
    title: "Fix DATABASE_URL",
    text: "DATABASE_URL must start with postgres:// or postgresql://. Check the value under Settings › Environment Variables."
  });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(admin)) problems.push({
    title: "Add ADMIN_EMAIL",
    text: "Under Settings › Environment Variables, add ADMIN_EMAIL with the email of the one admin account, for Production and Preview."
  });
  if (env.SMTP_HOST && !env.MAIL_FROM) problems.push({
    title: "Add MAIL_FROM",
    text: "SMTP_HOST is set but MAIL_FROM isn't. Add MAIL_FROM, for example: Orla Properties <no-reply@yourdomain.com>"
  });
}

// Create tables and load the starting offers into an empty database.
if (!problems.length && dbUrl) {
  const { migrate } = await import("../lib/schema.js");
  const { closeDb } = await import("../lib/db.js");
  try {
    const { seeded } = await migrate();
    console.log(`✔ Database ready${seeded ? ` (loaded ${seeded} starting offers)` : ""}`);
  } catch (e) {
    console.error("✖ Database setup failed: " + e.message);
    problems.push({
      title: "Check the database connection",
      text: "The build couldn't connect to the database. Check that DATABASE_URL is correct and that the database is running, then redeploy. The build log has the details."
    });
  } finally { await closeDb().catch(() => {}); }
}

if (problems.length) {
  console.error("\n✖ Setup isn't finished:\n" + problems.map(p => `  • ${p.title}: ${p.text}`).join("\n") + "\n  Then redeploy (Deployments › ⋯ › Redeploy).\n");
  if (!onVercel) process.exit(1);
  writeSetupPage(problems);
  console.log("! Published a \"Finish setup\" page instead of the app. It contains no app data.");
  process.exit(0);
}

if (dbUrl) {
  console.log(`✔ Admin account: ${admin.toLowerCase()}`);
  console.log(env.SMTP_HOST && env.MAIL_FROM
    ? "✔ Email on: new users confirm their email; password resets by email."
    : "! Email off: no confirmation emails. The admin still approves every account and can make password-reset links. Add SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and MAIL_FROM to turn email on.");
} else {
  console.warn("! Building the device-only version (ALLOW_LOCAL_MODE=1): PIN lock, no accounts, data on the device.");
}

// ---------- build the app ----------
// Website at /, the app at /app/, shared files (icons, manifest, service worker, config) at the root.
rmSync("dist", { recursive: true, force: true });
cpSync("app", "dist", { recursive: true });
mkdirSync("dist/app", { recursive: true });
renameSync("dist/index.html", "dist/app/index.html");
cpSync("site/index.html", "dist/index.html");
writeFileSync("dist/config.js",
  "// Generated at build time. Do not edit.\nwindow.ORLA_CONFIG = " + JSON.stringify(dbUrl ? { api: "/api" } : {}) + ";\n");

// With accounts on, offers come only from the database: don't publish the starting offers in the page source.
let html = readFileSync("dist/app/index.html", "utf8");
if (dbUrl) {
  const a = html.indexOf("/*SEED*/"), b = html.indexOf("/*END*/");
  if (a < 0 || b < a) { console.error("✖ Couldn't find the starting-offers markers in app/index.html."); process.exit(1); }
  html = html.slice(0, a + "/*SEED*/".length) + "[]" + html.slice(b);
}
writeFileSync("dist/app/index.html", html);

// A new cache name for every deploy, so installed iPad apps pick up updates.
const version = (env.VERCEL_GIT_COMMIT_SHA || String(Date.now())).slice(0, 12);
writeFileSync("dist/sw.js", readFileSync("dist/sw.js", "utf8").replace(/const C="[^"]*";/, `const C="peninsula-offers-${version}";`));

console.log(`✔ Built dist/ (${dbUrl ? "accounts on" : "device-only"}, cache ${version})`);

// ---------- "Finish setup" page ----------
function writeSetupPage(items) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  rmSync("dist", { recursive: true, force: true });
  mkdirSync("dist", { recursive: true });
  // Unregisters any service worker from an earlier deploy so the setup page isn't hidden behind a cached app.
  writeFileSync("dist/sw.js", "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.registration.unregister()));\n");
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Peninsula Offers: finish setup</title><meta name="robots" content="noindex">
<style>
:root{--bg:#1F1D1B;--card:#fff;--fg:#1F1D1B;--muted:#5A5550;--accent:#F28C28;--ink:#B4430B;--line:#E7E2DA}
@media (prefers-color-scheme:dark){:root{--card:#1F1C1A;--fg:#F2EEE9;--muted:#B0A89F;--ink:#FFB36B;--line:#36312D}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;padding:24px 16px}
main{background:var(--card);border-radius:18px;max-width:560px;width:100%;padding:28px 26px}
.brand{font-weight:800;letter-spacing:.14em;font-size:13px;color:var(--ink)}h1{margin:6px 0 4px;font-size:26px}
p{margin:0 0 14px;color:var(--muted)}ol{margin:0;padding-left:22px;display:flex;flex-direction:column;gap:14px}
li b{display:block}li span{color:var(--muted);font-size:15px}code{background:rgba(127,127,127,.15);padding:1px 5px;border-radius:4px}
.last{margin-top:18px;padding-top:14px;border-top:1px solid var(--line);font-size:15px}
</style></head><body><main>
<div class="brand">ORLA · PENINSULA OFFERS</div>
<h1>Finish setup</h1>
<p>The app is deployed, but it needs ${items.length === 1 ? "one more setting" : "a few more settings"} before anyone can sign in. In the Vercel dashboard:</p>
<ol>${items.map(i => `<li><b>${esc(i.title)}</b><span>${esc(i.text).replace(/(DATABASE_URL|ADMIN_EMAIL|MAIL_FROM|SMTP_HOST)/g, "<code>$1</code>")}</span></li>`).join("")}
<li><b>Redeploy</b><span>Deployments › ⋯ › Redeploy. The database tables and the 20 starting offers are set up automatically.</span></li></ol>
<p class="last">Then open this address again and register with the admin email first.</p>
</main></body></html>
`;
  writeFileSync("dist/index.html", page);
  mkdirSync("dist/app", { recursive: true });
  writeFileSync("dist/app/index.html", page);
}
