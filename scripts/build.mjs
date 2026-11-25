// Builds the site into dist/ and prepares the database. Vercel runs this on every deploy (see vercel.json).
//
//   DATABASE_URL  PostgreSQL connection string (Vercel › Storage › Neon sets it for you)
//   ADMIN_EMAIL   the one admin account's email
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM   optional, for confirmation and reset emails
//   APP_URL       optional, the site's address for links in emails (Vercel's own address is used otherwise)
//
// Locally: DATABASE_URL=postgres://... ADMIN_EMAIL=you@company.com npm run build
// Device-only version without a server (PIN lock, data on the device): ALLOW_LOCAL_MODE=1 npm run build
import { cpSync, rmSync, readFileSync, writeFileSync } from "node:fs";

const env = process.env;
const dbUrl = env.DATABASE_URL || env.POSTGRES_URL || "";
const localMode = env.ALLOW_LOCAL_MODE === "1" && !dbUrl;
const fail = msg => { console.error("\n✖ " + msg + "\n"); process.exit(1); };

if (!dbUrl && !localMode) fail(
  "No database is connected, so the app would have no accounts.\n" +
  "  In Vercel: Storage › Create Database › Neon (Postgres) › Connect to this project. That adds DATABASE_URL.\n" +
  "  Or add DATABASE_URL yourself under Settings › Environment Variables (any PostgreSQL works). Then redeploy.\n" +
  "  To build the device-only PIN version on purpose, set ALLOW_LOCAL_MODE=1.");

if (dbUrl) {
  if (!/^postgres(ql)?:\/\//.test(dbUrl)) fail("DATABASE_URL must start with postgres:// or postgresql://.");
  const admin = (env.ADMIN_EMAIL || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(admin)) fail(
    "ADMIN_EMAIL isn't set. Add it under Settings › Environment Variables: the email of the one admin account. Then redeploy.");
  const mailOn = !!(env.SMTP_HOST && env.MAIL_FROM);
  if (env.SMTP_HOST && !env.MAIL_FROM) fail("SMTP_HOST is set but MAIL_FROM isn't. Add MAIL_FROM, e.g. \"Orla Properties <no-reply@yourdomain.com>\".");

  // Create tables and load the starting offers into an empty database.
  const { migrate } = await import("../lib/schema.js");
  const { closeDb } = await import("../lib/db.js");
  try {
    const { seeded } = await migrate();
    console.log(`✔ Database ready${seeded ? ` (loaded ${seeded} starting offers)` : ""}`);
  } catch (e) {
    fail("Couldn't set up the database: " + e.message + "\n  Check that DATABASE_URL is correct and the database is reachable.");
  } finally { await closeDb(); }
  console.log(`✔ Admin account: ${admin.toLowerCase()}`);
  console.log(mailOn ? "✔ Email on: new users confirm their email; password resets by email."
                     : "! Email off: no confirmation emails. The admin still approves every account and can make password-reset links. Add SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and MAIL_FROM to turn email on.");
} else {
  console.warn("! Building the device-only version (ALLOW_LOCAL_MODE=1): PIN lock, no accounts, data on the device.");
}

rmSync("dist", { recursive: true, force: true });
cpSync("app", "dist", { recursive: true });
writeFileSync("dist/config.js",
  "// Generated at build time. Do not edit.\nwindow.ORLA_CONFIG = " + JSON.stringify(dbUrl ? { api: "/api" } : {}) + ";\n");

// With accounts on, offers come only from the database: don't publish the starting offers in the page source.
let html = readFileSync("dist/index.html", "utf8");
if (dbUrl) {
  const a = html.indexOf("/*SEED*/"), b = html.indexOf("/*END*/");
  if (a < 0 || b < a) fail("Couldn't find the starting-offers markers in app/index.html.");
  html = html.slice(0, a + "/*SEED*/".length) + "[]" + html.slice(b);
}
writeFileSync("dist/index.html", html);

// A new cache name for every deploy, so installed iPad apps pick up updates.
const version = (env.VERCEL_GIT_COMMIT_SHA || String(Date.now())).slice(0, 12);
writeFileSync("dist/sw.js", readFileSync("dist/sw.js", "utf8").replace(/const C="[^"]*";/, `const C="peninsula-offers-${version}";`));

console.log(`✔ Built dist/ (${dbUrl ? "accounts on" : "device-only"}, cache ${version})`);
