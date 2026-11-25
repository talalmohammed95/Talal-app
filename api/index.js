// The app's backend: accounts, admin approval and data, on PostgreSQL.
// Vercel runs this as one serverless function; vercel.json routes /api/* here.
import { q, dbUrl } from "../lib/db.js";
import { ensureSchema } from "../lib/schema.js";
import { hashPassword, checkPassword, newToken, sha256 } from "../lib/auth.js";
import { mailEnabled, sendMail, trySendMail } from "../lib/mail.js";

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const COOKIE = "orla_session";
const SESSION_DAYS = 30;

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const fail = (status, message, code) => { throw new HttpError(status, message, code); };

// ---------- request helpers ----------
function send(res, status, body, cache) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cache || "no-store");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") return req.body ? JSON.parse(req.body) : {};
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString() || "{}");
    return req.body;
  }
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 3e6) fail(413, "Request too large."); chunks.push(c); }
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : {};
}

const cookies = req => Object.fromEntries((req.headers.cookie || "").split(/;\s*/).filter(Boolean)
  .map(c => { const i = c.indexOf("="); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
const isLocal = req => /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || "");
const clientIp = req => String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();

function setSessionCookie(req, res, token, maxAge) {
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isLocal(req) ? "" : "; Secure"}`);
}

// Links in emails point here. Taken from settings, never from the request's Host header.
function appUrl(req) {
  const env = process.env.APP_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL : "");
  if (env) return env.replace(/\/+$/, "");
  if (isLocal(req)) return "http://" + req.headers.host;
  fail(500, "APP_URL isn't set, so email links can't be made.", "no_app_url");
}

// ---------- validation ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v, max) => (typeof v === "string" ? v : "").trim().slice(0, max);
function checkEmail(v) { const e = str(v, 254).toLowerCase(); if (!EMAIL_RE.test(e)) fail(400, "Enter a valid email address.", "bad_email"); return e; }
function checkNewPassword(v) {
  if (typeof v !== "string" || v.length < 8) fail(400, "Use at least 8 characters for your password.", "weak_password");
  if (v.length > 200) fail(400, "That password is too long.", "bad_password");
  return v;
}

async function limit(key, max, seconds) {
  const { rows } = await q(
    `insert into throttle (key, count, reset_at) values ($1, 1, now() + make_interval(secs => $2::float8))
     on conflict (key) do update set
       count = case when throttle.reset_at < now() then 1 else throttle.count + 1 end,
       reset_at = case when throttle.reset_at < now() then now() + make_interval(secs => $2::float8) else throttle.reset_at end
     returning count`, [key, seconds]);
  if (rows[0].count > max) fail(429, "Too many attempts. Wait a few minutes and try again.", "rate_limited");
}

// ---------- sessions and users ----------
const publicUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, emailVerified: u.email_verified, company: u.company || "", phone: u.phone || "" });

// Roles: admin and agent (the Orla team) see everything. Brokers (agents at other agencies) and clients
// never receive unit numbers, owner details or internal notes: they're removed here, on the server.
const ROLES = ["agent", "broker", "client"];
const ROLE_NAME = { admin: "Admin", agent: "Orla team agent", broker: "External agent", client: "Buyer or tenant" };
const isTeam = u => u && (u.role === "admin" || u.role === "agent");
const TEAM_ONLY = ["unit", "owner", "ownerPhone", "notes", "check", "internal"];
function forRole(data, user) {
  if (isTeam(user)) return data;
  const d = { ...data };
  for (const k of TEAM_ONLY) delete d[k];
  if (typeof d.title === "string") d.title = d.title.replace(/\bunit\s*[#no.]*\s*\d+[a-z]?\b\s*[·,-]?\s*/gi, "").trim();
  return d;
}
const PUBLIC_FIELDS = ["b", "beds", "deal", "title", "price", "rent", "size", "floor", "view", "furn", "baths", "status", "avail", "hl", "photos", "plan", "balcony", "cheques"];
const forPublic = data => Object.fromEntries(PUBLIC_FIELDS.filter(k => data[k] !== undefined).map(k => [k, data[k]]));

async function currentUser(req) {
  const token = cookies(req)[COOKIE];
  if (!token) return null;
  const { rows } = await q(
    `select u.* from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > now()`, [sha256(token)]);
  return rows[0] || null;
}

async function startSession(req, res, userId) {
  const token = newToken();
  await q("insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + make_interval(days => $3))", [sha256(token), userId, SESSION_DAYS]);
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
}

async function makeToken(userId, kind, hours) {
  const token = newToken();
  await q("insert into tokens (token_hash, user_id, kind, expires_at) values ($1, $2, $3, now() + make_interval(hours => $4))", [sha256(token), userId, kind, hours]);
  return token;
}

async function useToken(token, kind) {
  const { rows } = await q(
    `update tokens set used = true where token_hash = $1 and kind = $2 and not used and expires_at > now()
     returning user_id`, [sha256(String(token || "")), kind]);
  if (!rows[0]) fail(400, kind === "verify" ? "This confirmation link has expired or was already used. Sign in to get a new one." : "This reset link has expired or was already used. Ask for a new one.", "bad_token");
  return rows[0].user_id;
}

const requireActive = c => {
  if (!c.user) fail(401, "Sign in first.", "signed_out");
  if (c.user.status !== "active") fail(403, "Your account doesn't have access yet.", "not_active");
};
const requireAdmin = c => { requireActive(c); if (c.user.role !== "admin") fail(403, "Only the admin can do this.", "not_admin"); };

async function sendVerification(req, u) {
  const token = await makeToken(u.id, "verify", 48);
  return trySendMail(u.email, "Confirm your email for Peninsula Offers",
    `Hi ${u.name || ""},\n\nConfirm your email to finish registering for Peninsula Offers:\n${appUrl(req)}/app/?verify=${token}\n\n` +
    `After that, the admin approves your account. This link works for 48 hours.\n\nIf you didn't register, ignore this email.\n\nOrla Properties`);
}

async function notifyAdminOfNewUser(req, u) {
  if (u.role === "admin") return;
  const { rows } = await q("select email from users where role = 'admin' and status = 'active'");
  if (rows[0]) await trySendMail(rows[0].email, "New account waiting for approval",
    `${u.name || u.email} (${u.email}) registered for Peninsula Offers as: ${ROLE_NAME[u.role] || u.role}` +
    `${u.company ? ", " + u.company : ""}${u.phone ? ", " + u.phone : ""}. They're waiting for your approval.\n\n` +
    `Approve or decline them in Admin › Users:\n${appUrl(req)}/app/\n`);
}

// Price, rent and status changes, kept per offer for days on market and price history.
async function recordHistory(id, prev, next, email) {
  const title = str(next.title, 200), rows = [];
  if (!prev) rows.push(["listed", null, next.deal === "rent" ? next.rent : next.price]);
  else for (const k of ["price", "rent", "avail"]) {
    const a = prev[k] ?? (k === "avail" ? "Available" : null), b = next[k] ?? (k === "avail" ? "Available" : null);
    if (String(a ?? "") !== String(b ?? "")) rows.push([k, a, b]);
  }
  for (const [kind, a, b] of rows)
    await q("insert into offer_history (offer_id, by_email, kind, old_value, new_value, title) values ($1, $2, $3, $4, $5, $6)",
      [id, email, kind, a == null ? null : String(a), b == null ? null : String(b), title]);
}

// ---------- routes ----------
const routes = {
  "GET auth/config": async () => ({ emailEnabled: mailEnabled() }),

  "GET auth/me": async c => {
    if (!c.user) fail(401, "Not signed in.", "signed_out");
    return { user: publicUser(c.user) };
  },

  "POST auth/register": async c => {
    const name = str(c.body.name, 100), email = checkEmail(c.body.email), password = checkNewPassword(c.body.password);
    const role = ROLES.includes(c.body.role) ? c.body.role : "client", company = str(c.body.company, 120), phone = str(c.body.phone, 40);
    if (role === "broker" && !company) fail(400, "Enter the name of your agency.", "no_company");
    if (!name) fail(400, "Enter your full name.", "no_name");
    await limit("register:" + c.ip, 10, 3600);
    const isAdmin = !!ADMIN_EMAIL && email === ADMIN_EMAIL;
    const emailOn = mailEnabled();
    let user;
    try {
      ({ rows: [user] } = await q(
        `insert into users (email, name, pass_hash, role, status, email_verified, company, phone)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
        [email, name, await hashPassword(password), isAdmin ? "admin" : role, isAdmin ? "active" : "pending", !emailOn, company, phone]));
    } catch (e) {
      if (e.code === "23505" && /only_one_admin/.test(e.constraint || "")) fail(409, "The admin account already exists.", "admin_exists");
      if (e.code === "23505") fail(409, "An account with this email already exists. Sign in instead.", "exists");
      throw e;
    }
    if (emailOn) { await sendVerification(c.req, user); return { needsVerification: true }; }
    await startSession(c.req, c.res, user.id);
    return { user: publicUser(user) };
  },

  "POST auth/verify": async c => {
    const userId = await useToken(c.body.token, "verify");
    const { rows: [user] } = await q("update users set email_verified = true where id = $1 returning *", [userId]);
    if (user.status === "pending") await notifyAdminOfNewUser(c.req, user);
    await startSession(c.req, c.res, user.id);
    return { user: publicUser(user) };
  },

  "POST auth/login": async c => {
    const email = checkEmail(c.body.email), password = String(c.body.password || "");
    await limit("login:" + email, 10, 900);
    await limit("login-ip:" + c.ip, 50, 900);
    const { rows: [user] } = await q("select * from users where email = $1", [email]);
    const ok = await checkPassword(password, user && user.pass_hash);
    if (!user || !ok) fail(401, "Wrong email or password.", "bad_login");
    if (user.status === "blocked") fail(403, "This account doesn't have access. Contact the admin.", "blocked");
    if (mailEnabled() && !user.email_verified) {
      const canResend = await limit("resend:" + email, 3, 3600).then(() => true, () => false);
      if (canResend) await sendVerification(c.req, user);
      fail(403, "Confirm your email first. We've just sent you a new confirmation link.", "unverified");
    }
    await startSession(c.req, c.res, user.id);
    return { user: publicUser(user) };
  },

  "POST auth/logout": async c => {
    const token = cookies(c.req)[COOKIE];
    if (token) await q("delete from sessions where token_hash = $1", [sha256(token)]);
    setSessionCookie(c.req, c.res, "", 0);
    return { ok: true };
  },

  "POST auth/forgot": async c => {
    const email = checkEmail(c.body.email);
    await limit("forgot:" + email, 3, 3600);
    await limit("forgot-ip:" + c.ip, 20, 3600);
    const { rows: [user] } = await q("select * from users where email = $1 and status <> 'blocked'", [email]);
    if (user && mailEnabled()) {
      const token = await makeToken(user.id, "reset", 1);
      await trySendMail(email, "Reset your Peninsula Offers password",
        `Set a new password here (the link works for 1 hour):\n${appUrl(c.req)}/app/?reset=${token}\n\nIf you didn't ask for this, ignore this email.\n\nOrla Properties`);
    }
    return { ok: true }; // same answer either way, so it doesn't reveal who has an account
  },

  "POST auth/reset": async c => {
    const password = checkNewPassword(c.body.password);
    await limit("reset-ip:" + c.ip, 20, 3600);
    const userId = await useToken(c.body.token, "reset");
    const { rows: [user] } = await q("update users set pass_hash = $2, email_verified = true where id = $1 returning *", [userId, await hashPassword(password)]);
    await q("delete from sessions where user_id = $1", [userId]); // sign out everywhere else
    await startSession(c.req, c.res, user.id);
    return { user: publicUser(user) };
  },

  "GET data/all": async c => {
    requireActive(c);
    const [offers, settings, state] = await Promise.all([
      q("select id, data, created_at, updated_at from offers order by id"),
      q("select data from settings where id = 'app'"),
      q("select data from user_state where user_id = $1", [c.user.id])
    ]);
    return { offers: offers.rows.map(r => ({ ...r, data: forRole(r.data, c.user) })), settings: settings.rows[0]?.data || {}, state: state.rows[0]?.data || null };
  },

  "PUT data/state": async c => {
    requireActive(c);
    const data = c.body.data;
    if (!data || typeof data !== "object" || JSON.stringify(data).length > 500000) fail(400, "Invalid data.");
    await q(`insert into user_state (user_id, data, updated_at) values ($1, $2, now())
             on conflict (user_id) do update set data = excluded.data, updated_at = now()`, [c.user.id, data]);
    return { ok: true };
  },

  "PUT admin/offers": async c => {
    requireAdmin(c);
    const id = str(c.body.id, 64), data = c.body.data;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) fail(400, "Invalid offer id.");
    if (!data || typeof data !== "object" || Array.isArray(data) || JSON.stringify(data).length > 64000) fail(400, "Invalid offer.");
    const { rows: [prev] } = await q("select data from offers where id = $1", [id]);
    await q(`insert into offers (id, data, updated_at, updated_by) values ($1, $2, now(), $3)
             on conflict (id) do update set data = excluded.data, updated_at = now(), updated_by = excluded.updated_by`, [id, data, c.user.id]);
    await recordHistory(id, prev && prev.data, data, c.user.email);
    return { ok: true };
  },

  "POST admin/offers/delete": async c => {
    requireAdmin(c);
    const id = str(c.body.id, 64);
    const { rows: [prev] } = await q("delete from offers where id = $1 returning data", [id]);
    if (prev) await q("insert into offer_history (offer_id, by_email, kind, title) values ($1, $2, 'removed', $3)", [id, c.user.email, str(prev.data.title, 200)]);
    return { ok: true };
  },

  "PUT admin/settings": async c => {
    requireAdmin(c);
    const data = c.body.data;
    if (!data || typeof data !== "object" || Array.isArray(data) || JSON.stringify(data).length > 64000) fail(400, "Invalid settings.");
    await q(`insert into settings (id, data, updated_at) values ('app', $1, now())
             on conflict (id) do update set data = excluded.data, updated_at = now()`, [data]);
    return { ok: true };
  },

  "GET admin/users": async c => {
    requireAdmin(c);
    const { rows } = await q("select id, email, name as full_name, role, status, email_verified, created_at, company, phone from users order by created_at");
    return { users: rows };
  },

  "POST admin/users/status": async c => {
    requireAdmin(c);
    const status = c.body.status;
    if (!["active", "blocked"].includes(status)) fail(400, "Invalid status.");
    if (c.body.id === c.user.id) fail(400, "You can't change your own access.");
    const { rows: [user] } = await q("select * from users where id = $1", [String(c.body.id || "")]);
    if (!user) fail(404, "User not found.");
    await q("update users set status = $2 where id = $1", [user.id, status]);
    if (status === "blocked") await q("delete from sessions where user_id = $1", [user.id]);
    if (status === "active" && user.status !== "active")
      await trySendMail(user.email, "Your Peninsula Offers account is approved",
        `Hi ${user.name || ""},\n\nThe admin has approved your account. Sign in here:\n${appUrl(c.req)}/app/\n\nOrla Properties`);
    return { ok: true };
  },

  "POST admin/users/role": async c => {
    requireAdmin(c);
    const role = c.body.role;
    if (!ROLES.includes(role)) fail(400, "Invalid role.");
    const { rows: [user] } = await q("select * from users where id = $1", [String(c.body.id || "")]);
    if (!user) fail(404, "User not found.");
    if (user.role === "admin") fail(400, "The admin's role can't be changed.");
    await q("update users set role = $2 where id = $1", [user.id, role]);
    return { ok: true };
  },

  // Available homes for the public website: no unit numbers, owners, agents or internal notes.
  "GET public/offers": async c => {
    const { rows } = await q("select id, data from offers order by id");
    c.cache = "public, max-age=60, s-maxage=60";
    return { offers: rows.filter(r => !["Sold", "Rented"].includes(r.data.avail)).map(r => ({ id: r.id, ...forPublic(r.data) })) };
  },

  // Photos and floor plans: the admin uploads them already resized in the browser.
  "POST admin/media": async c => {
    requireAdmin(c);
    const mime = String(c.body.mime || "");
    if (!["image/webp", "image/jpeg", "image/png"].includes(mime)) fail(400, "Use a JPEG, PNG or WebP image.");
    const buf = Buffer.from(String(c.body.data || ""), "base64");
    if (!buf.length || buf.length > 2e6) fail(400, "That image is too large. Use one under 2 MB.");
    const { rows: [m] } = await q("insert into media (mime, data, by_user) values ($1, $2, $3) returning id", [mime, buf, c.user.id]);
    return { url: "/api/media?id=" + m.id };
  },

  "GET media": async c => {
    const id = new URL(c.req.url, "http://localhost").searchParams.get("id") || "";
    if (!/^[0-9a-f-]{36}$/.test(id)) fail(404, "Not found.");
    const { rows: [m] } = await q("select mime, data from media where id = $1", [id]);
    if (!m) fail(404, "Not found.");
    c.res.statusCode = 200;
    c.res.setHeader("Content-Type", m.mime);
    c.res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    c.res.end(m.data);
    return RAW;
  },

  "POST admin/users/reset-link": async c => {
    requireAdmin(c);
    const { rows: [user] } = await q("select id from users where id = $1", [String(c.body.id || "")]);
    if (!user) fail(404, "User not found.");
    const token = await makeToken(user.id, "reset", 24);
    return { url: `${appUrl(c.req)}/app/?reset=${token}` };
  },

  "GET data/history": async c => {
    requireActive(c);
    const { rows } = await q("select offer_id, at, by_email, kind, old_value, new_value, title from offer_history order by at desc, id desc limit 1000");
    return { rows };
  },

  "GET admin/activity": async c => {
    requireAdmin(c);
    const { rows } = await q("select at, by_email, text from activity order by at desc limit 50");
    return { rows };
  },

  "POST admin/activity": async c => {
    requireAdmin(c);
    const text = str(c.body.text, 300);
    if (text) await q("insert into activity (by_user, by_email, text) values ($1, $2, $3)", [c.user.id, c.user.email, text]);
    return { ok: true };
  }
};

const RAW = Symbol("raw");

export default async function handler(req, res) {
  try {
    if (!dbUrl()) fail(503, "The database isn't connected. Set DATABASE_URL.", "no_db");
    await ensureSchema();
    const url = new URL(req.url, "http://localhost");
    const route = (url.searchParams.get("route") || url.pathname.replace(/^\/api\/?/, "")).replace(/^\/+|\/+$/g, "");
    const fn = routes[req.method + " " + route];
    if (!fn) fail(404, "Not found.", "not_found");
    // Blocks cross-site form posts: browsers can't add this header from another site without permission.
    if (req.method !== "GET" && req.headers["x-orla"] !== "1") fail(403, "Missing request header.", "csrf");
    let body = {};
    if (req.method !== "GET") {
      try { body = await readBody(req); } catch (e) { if (e instanceof HttpError) throw e; fail(400, "Invalid request."); }
      if (!body || typeof body !== "object") body = {};
    }
    const user = await currentUser(req);
    const c = { req, res, body, user, ip: clientIp(req) };
    const out = await fn(c);
    if (out !== RAW) send(res, 200, out || { ok: true }, c.cache);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, code: e.code });
    console.error(e);
    send(res, 500, { error: "Something went wrong on the server. Try again.", code: "server_error" });
  }
}
