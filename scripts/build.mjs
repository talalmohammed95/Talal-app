// Builds the deployable site into dist/ and writes dist/config.js from environment variables.
// Vercel runs this automatically (see vercel.json). Locally:
//   SUPABASE_URL=https://xyz.supabase.co SUPABASE_ANON_KEY=... npm run build
import { cpSync, rmSync, readFileSync, writeFileSync } from "node:fs";

const env = process.env;
const pick = (...names) => (names.map(n => env[n]).find(v => v && v.trim()) || "").trim();

// Accept the names Vercel's Supabase integration sets, as well as plain ones.
const url = pick("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "VITE_SUPABASE_URL").replace(/\/+$/, "");
const key = pick("SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY",
                 "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "VITE_SUPABASE_ANON_KEY");
const localMode = env.ALLOW_LOCAL_MODE === "1";
const fail = msg => { console.error("\n✖ " + msg + "\n"); process.exit(1); };

if (!url || !key) {
  if (!localMode) fail(
    "Supabase isn't configured, so the app would have no sign-in.\n" +
    "  Add SUPABASE_URL and SUPABASE_ANON_KEY in Vercel › Project › Settings › Environment Variables\n" +
    "  (from Supabase › Project Settings › API), then redeploy.\n" +
    "  To build the device-only PIN version on purpose, set ALLOW_LOCAL_MODE=1.");
  console.warn("! Building the device-only version (ALLOW_LOCAL_MODE=1): PIN lock, no accounts.");
} else {
  if (!/^https:\/\//.test(url)) fail("SUPABASE_URL must start with https:// (for example https://abcd.supabase.co).");
  // Never ship a secret key to browsers.
  if (/^sb_secret_/.test(key)) fail("SUPABASE_ANON_KEY holds a secret key. Use the anon / publishable key instead.");
  const parts = key.split(".");
  if (parts.length === 3) {
    let role = "";
    try { role = JSON.parse(Buffer.from(parts[1], "base64url").toString()).role; } catch { /* not a JWT */ }
    if (role === "service_role") fail("SUPABASE_ANON_KEY holds the service_role key, which must stay secret. Use the anon public key instead.");
  }
}

rmSync("dist", { recursive: true, force: true });
cpSync("app", "dist", { recursive: true });

writeFileSync("dist/config.js",
  "// Generated at build time from environment variables. Do not edit.\n" +
  "window.ORLA_CONFIG = " + JSON.stringify({ supabaseUrl: url, supabaseAnonKey: key }, null, 2) + ";\n");

// With accounts on, offers come only from the database: don't publish the starting offers in the page source.
let html = readFileSync("dist/index.html", "utf8");
if (url && key) {
  const a = html.indexOf("/*SEED*/"), b = html.indexOf("/*END*/");
  if (a < 0 || b < a) fail("Couldn't find the starting-offers markers in app/index.html.");
  html = html.slice(0, a + "/*SEED*/".length) + "[]" + html.slice(b);
}
writeFileSync("dist/index.html", html);

// New cache name for every deploy, so installed iPad apps pick up updates.
const version = (env.VERCEL_GIT_COMMIT_SHA || String(Date.now())).slice(0, 12);
const sw = readFileSync("dist/sw.js", "utf8").replace(/const C="[^"]*";/, `const C="peninsula-offers-${version}";`);
writeFileSync("dist/sw.js", sw);

console.log(`✔ Built dist/ (${url && key ? "accounts on: " + new URL(url).host : "device-only PIN mode"}, cache ${version})`);
