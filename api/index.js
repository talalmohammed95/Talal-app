// The app's backend: accounts, admin approval and data, on PostgreSQL.
// Vercel runs this as one serverless function; vercel.json routes /api/* here.
import crypto from "node:crypto";
import { q, dbUrl } from "../lib/db.js";
import { ensureSchema } from "../lib/schema.js";
import { hashPassword, checkPassword, newToken, sha256 } from "../lib/auth.js";
import { mailEnabled, sendMail, trySendMail } from "../lib/mail.js";
import { SETTINGS } from "../lib/seed.js";
import Anthropic from "@anthropic-ai/sdk";
import { assist, assistOffline, aiEnabled } from "../lib/assistant.js";
import { importContacts, contactStats, searchContacts, claimWarning } from "../lib/contacts.js";
import { importDeals, dealStats } from "../lib/deals.js";
import { readBrochure, guideRows } from "../lib/guide.js";
import { vapidKeys, subscribe, unsubscribe, notifyLead, pushTo } from "../lib/notify.js";
import { runWeekly, buildWeekly, weeklyText, runDaily, greet } from "../lib/weekly.js";
import { addReminder, listReminders, setDone, snooze, removeReminder, deliverDue, morningBriefing } from "../lib/reminders.js";

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const COOKIE = "orla_session";
const SESSION_DAYS = 365; // a sign-in lasts a year from the last use: people stay signed in on their phone

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
  for await (const c of req) { size += c.length; if (size > 4.4e6) fail(413, "Request too large."); chunks.push(c); }
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
const publicUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, emailVerified: u.email_verified, company: u.company || "", phone: u.phone || "", agentKey: u.agent_key || "" });

// Roles: admin and agent (the Orla team) see everything. Brokers (agents at other agencies) and clients
// never receive unit numbers, owner details or internal notes: they're removed here, on the server.
const ROLES = ["agent", "ceo", "broker", "client"];
const SIGNUP_ROLES = ["agent", "broker", "client"]; // the CEO account is made by the admin only
const ROLE_NAME = { admin: "Admin", agent: "Orla team agent", broker: "External agent", client: "Buyer or tenant" };
const isTeam = u => u && (u.role === "admin" || u.role === "agent");
// The CEO sees what the team sees (team offers, floors, performance, chat) but no unit numbers or owners, and changes nothing.
const isStaff = u => isTeam(u) || (u && u.role === "ceo");
// The admin and the CEO see every unit number, owner, listing, contact and request. Only the admin changes settings and accounts.
const seesAll = u => !!u && (u.role === "admin" || u.role === "ceo");
const TEAM_ONLY = ["tower", "unit", "owner", "ownerPhone", "ownerNote", "notes", "check", "internal"];
const OWNER = ["owner", "ownerPhone", "ownerNote"];
// Clients and external agents see a floor band (low, mid, high), not the exact floor: they ask the agent for it.
const band = n => n <= 10 ? "Low floor" : n <= 25 ? "Mid floor" : "High floor";
const FLOOR_RE = /\b(\d{1,2})(?:st|nd|rd|th)[\s-]*floor\b/gi;
function hideFloor(d) {
  if (typeof d.floor === "string") { const m = d.floor.match(/\d{1,2}/); if (m && !/low|mid|high|podium/i.test(d.floor)) d.floor = band(+m[0]); else if (/tower/i.test(d.floor)) d.floor = d.floor.replace(/\s*·.*$/, ""); }
  for (const k of ["title", "hl"]) if (typeof d[k] === "string") { d[k] = d[k].replace(FLOOR_RE, (_, n) => band(+n).toLowerCase()); d[k] = d[k].charAt(0).toUpperCase() + d[k].slice(1); }
  return d;
}
// A home with a unit number but no floor written gets its floor from the number (1203 is the 12th floor),
// so teammates see the floor and outsiders the band, even though the number itself is hidden from them.
const ORD = n => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
function floorFromUnit(d) {
  const digits = String(d.unit || "").replace(/\D/g, "");
  if (digits.length < 3 || digits.length > 5) return d;
  if (d.floor && !/request|^\s*[—–-]?\s*$/i.test(String(d.floor))) return d;
  const n = +digits.slice(0, -2);
  return n > 0 && n < 100 ? { ...d, floor: ORD(n) } : d;
}
function forRole(data, user) {
  if (seesAll(user)) return data;
  data = floorFromUnit(data);
  if (isStaff(user)) {
    // An agent sees the owner's contact only on offers listed under their own name.
    // Unit numbers and owners' details are for the agent the offer is listed under (and the admin) only.
    if (data.agent && data.agent === user.agent_key) return data;
    const d = { ...data };
    if (d.unit || OWNER.some(k => d[k])) d.ownerHidden = true;
    for (const k of ["unit", ...OWNER]) delete d[k];
    // The yellow box on the floor plan shows which unit it is, so it goes with the unit number.
    if (d.plan && typeof d.plan === "object" && d.plan.mark) { d.plan = { ...d.plan }; delete d.plan.mark; }
    if (typeof d.title === "string") d.title = d.title.replace(/\bunit\s*[#no.]*\s*\d+[a-z]?\b\s*[·,-]?\s*/gi, "").trim();
    return d;
  }
  const d = { ...data };
  for (const k of TEAM_ONLY) delete d[k];
  if (typeof d.title === "string") d.title = d.title.replace(/\bunit\s*[#no.]*\s*\d+[a-z]?\b\s*[·,-]?\s*/gi, "").trim();
  delete d.plan; d.planOnRequest = true;
  return hideFloor(d);
}
const PUBLIC_FIELDS = ["b", "beds", "layout", "deal", "title", "price", "rent", "size", "floor", "view", "furn", "baths", "status", "avail", "hl", "photos", "plan", "balcony", "cheques", "startingPrice", "moreCount", "agent", "tour"];

// Clients see one home per agent, building, bedrooms, layout and deal: the lowest price, shown as a starting price ("from AED X").
// The others stay with the agent, so the client gets in touch for them. The team and external agents see every home.
const askPrice = d => d.deal === "rent" ? +d.rent : +d.price;
function startingPrices(rows) {
  const groups = new Map(), out = [];
  for (const r of rows) {
    const d = r.data || {};
    if (["Sold", "Rented"].includes(d.avail) || !(askPrice(d) > 0)) { out.push(r); continue; }
    const k = [d.agent || "", d.b, d.beds, d.layout || "", d.deal].join("|");
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => askPrice(a.data) - askPrice(b.data) || String(a.id).localeCompare(String(b.id)));
    const [first, ...rest] = g;
    out.push(rest.length ? { ...first, data: { ...first.data, startingPrice: true, moreCount: rest.length } } : first);
  }
  return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}
const forPublic = data => hideFloor(Object.fromEntries(PUBLIC_FIELDS.filter(k => data[k] !== undefined && k !== "plan").map(k => [k, data[k]])));

async function currentUser(req) {
  const token = cookies(req)[COOKIE];
  if (!token) return null;
  const { rows } = await q(
    `select u.*, s.expires_at as session_expires from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > now()`, [sha256(token)]);
  const u = rows[0] || null;
  if (u) u.session_token = token;
  return u;
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
const requireStaff = c => { requireActive(c); if (!isStaff(c.user)) fail(403, "Only the Orla team can do this.", "not_team"); };
const requireTeam = c => { requireActive(c); if (c.user.role !== "admin" && c.user.role !== "agent") fail(403, "Only the Orla team can do this.", "not_team"); };
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

// Links a new team account to the agent with the same first name on the offers (the admin can change it).
async function guessAgentKey(u) {
  const { rows: [st] } = await q("select data from settings where id = 'app'");
  const agents = (st && st.data && st.data.agents) || {};
  // Matches the agent profile by first name, forgiving accents, case and small spelling differences (Blendjana / Blendiana),
  // or by the email starting with the agent's key or first name (blendjana.x@…). Only an unambiguous match counts.
  const norm = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z\s]/g, " ").trim();
  const first = s => norm(s).split(/\s+/)[0] || "";
  const near = (a, b) => a && b && (a === b || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5)));
  const mail = norm(String(u.email || "").split("@")[0]).replace(/\s+/g, "");
  const hits = Object.keys(agents).filter(k => near(first(agents[k].name), first(u.name)) || (mail && (mail.startsWith(k.toLowerCase()) || (first(agents[k].name).length >= 4 && mail.startsWith(first(agents[k].name))))));
  const key = hits.length === 1 ? hits[0] : null;
  if (key) { await q("update users set agent_key = $2 where id = $1", [u.id, key]); u.agent_key = key; }
}

async function teamGoal() {
  const { rows: [st] } = await q("select data from settings where id = 'app'");
  const g = { ...SETTINGS.goal, ...((st && st.data && st.data.goal) || {}) };
  if (!Array.isArray(g.platforms)) g.platforms = SETTINGS.goal.platforms;
  return g;
}

// Units, online and off-market counts per agent for the team goal.
async function teamStats(opts = {}) {
  const goal = await teamGoal();
  const [{ rows: lrows }, { rows: orows }, { rows: [st] }] = await Promise.all([
    q("select l.id, l.data, l.created_at, u.agent_key, u.name from listings l join users u on u.id = l.user_id"),
    q("select id, data, created_at from offers"),
    q("select data from settings where id = 'app'")]);
  // The team's offers count too, under the agent each is listed under. A shared listing is counted once, as the listing.
  const rows = lrows.map(r => ({ ...r, kind: "listing" })).concat(orows.filter(r => r.data.teamUnit && !r.data.fromListing).map(r => ({ id: r.id, kind: "offer", data: r.data, created_at: r.created_at, agent_key: "", name: "" })));
  const agents = (st && st.data && st.data.agents) || SETTINGS.agents, by = {};
  const blank = k => ({ key: k, name: agents[k] ? agents[k].name : k, phone: agents[k] ? agents[k].phone || "" : "", listings: 0, online: 0, partly: 0, offMarket: 0, forSale: 0, forRent: 0, platforms: {}, onlineDates: [], addedDates: [], viewingDates: [], deals: 0, lastAdded: null, units: [] });
  for (const k of Object.keys(agents)) by[k] = blank(k);
  for (const r of rows) {
    if (r.data.future) continue; // future listings count once they're on the market
    const k = r.data.agent || r.agent_key || "";
    if (!k) continue;
    const a = by[k] || (by[k] = { ...blank(k), name: agents[k] ? agents[k].name : r.name });
    const on = r.data.online || {}, n = goal.platforms.filter(p => on[p.k]).length;
    a.listings++;
    let status = "none";
    if (n && n === goal.platforms.length) { a.online++; a.onlineDates.push(r.data.onlineAt || r.created_at); status = "online"; }
    else if (on.off) { a.offMarket++; status = "off"; }
    else if (n) { a.partly++; status = "partly"; }
    const d = r.data, num = v => Number(String(v ?? "").replace(/[^0-9.]/g, "")) || null;
    a.units.push({ b: +d.b || null, tower: ["A", "B"].includes(d.tower) ? d.tower : null, layout: d.layout || null, beds: d.beds === undefined || d.beds === "" ? null : +d.beds, size: num(d.size), floor: str(d.floor, 40), view: str(d.view, 80), deal: d.deal,
      price: d.deal === "rent" ? null : num(d.price), rent: d.deal === "rent" ? num(d.rent ?? d.price) : d.deal === "both" ? num(d.rent) : null, status,
      on: goal.platforms.filter(p => on[p.k]).map(p => p.k),
      // Everything about the unit, for the admin only (see GET team/performance).
      ...(opts.full ? { id: r.id, kind: r.kind, unit: str(d.unit, 20), owner: str(d.owner, 100), ownerPhone: str(d.phone ?? d.ownerPhone, 40), furn: str(d.furn, 40),
        condition: str(d.status, 40), listedAt: d.date || r.created_at, future: !!d.future, notes: str(d.notes ?? d.ownerNote, 200), title: str(d.title, 100), baths: d.baths ?? null, shared: !!d.sharedOffer } : {}) });
    for (const p of goal.platforms) if (on[p.k]) a.platforms[p.k] = (a.platforms[p.k] || 0) + 1;
    a.addedDates.push(r.created_at);
    if (!a.lastAdded || r.created_at > a.lastAdded) a.lastAdded = r.created_at;
    if (r.data.deal !== "rent") a.forSale++;
    if (r.data.deal === "rent" || r.data.deal === "both") a.forRent++;
  }
  // For the team board: homes marked sold or rented (deals), and viewings booked through the website in the last 5 weeks.
  for (const r of orows) if (["Sold", "Rented"].includes(r.data.avail) && by[r.data.agent]) by[r.data.agent].deals++;
  const { rows: vrows } = await q("select agent_key, at from leads where kind = 'viewing' and at > now() - interval '35 days'");
  for (const v of vrows) if (by[v.agent_key]) by[v.agent_key].viewingDates.push(v.at);
  return { goal, agents: Object.values(by) };
}

// Writes the offer for a shared listing. Only these fields are copied: the unit number, the owner and the notes stay in the listing.
const SHARE_STATUS = { Ready: "Ready", Vacant: "Ready · vacant", Tenanted: "Tenanted", "Off-plan": "Off-plan" };
// Price approval: a listing priced more than 7% above the market waits for the admin. The agent gives the reason
// (renovated, upgraded, view, furnished…); only approved listings, or listings within 7%, are published on the website.
const PRICE_CATS = { renovated: "Fully renovated", upgraded: "Upgraded finishes", furnished: "Premium furniture", view: "Exceptional view or floor", layout: "Bigger or rare layout", owner: "Owner's firm price", other: "Other" };
const priceKey = d => (d.deal === "rent" ? "r" : "s") + ":" + String(d.price ?? "").replace(/[^0-9.]/g, "");
function reviewFor(user, data, prev) {
  const want = data.priceReview && typeof data.priceReview === "object" ? data.priceReview : null, old = prev && prev.priceReview;
  if (!want || !want.needed) return null; // within 7% (or no market figure): no approval needed
  const same = old && priceKey(prev) === priceKey(data);
  if (same && old.status === "approved") return old;           // approved price unchanged: stays approved
  const r = { status: user.role === "admin" ? "approved" : "pending", cat: PRICE_CATS[want.cat] ? want.cat : "other", reason: str(want.reason, 800),
    pct: Math.round(Number(want.pct) * 10) / 10 || null, market: Number(want.market) || null, price: Number(String(data.price ?? "").replace(/[^0-9.]/g, "")) || null,
    at: same && old.status === "pending" ? old.at : new Date().toISOString(), by: str(user.name || user.email, 100) };
  if (user.role === "admin") { r.decidedAt = r.at; r.decidedBy = str(user.name || "Admin", 100); }
  if (user.role !== "admin" && !r.reason) fail(400, "Explain why the price is above the market.", "no_reason");
  return r;
}
async function notifyAdminsReview(l, data, appUrlStr) {
  const { rows } = await q("select id from users where status = 'active' and role in ('admin','ceo')");
  const r = data.priceReview, B = ["", "Peninsula One", "Peninsula Two", "Peninsula Three", "Peninsula Four", "Peninsula Five"][+data.b] || "Peninsula";
  try { await pushTo(rows.map(x => x.id), { title: `Price approval: ${r.by}`, body: `${B}${data.unit ? " · unit " + data.unit : ""} · ${r.pct}% above market\n${PRICE_CATS[r.cat]}: ${r.reason.slice(0, 140)}`, url: "/app/#approvals", tag: "pr-" + l }); } catch (e) { console.error("review push", e); }
}

// A 3D model or 360° tour link: only the viewers the app opens inside a page (Sketchfab, Matterport, Kuula, YouTube).
function cleanTour(u) {
  try { const x = new URL(String(u || "").trim()); return x.protocol === "https:" && /^(www\.)?(sketchfab\.com|my\.matterport\.com|kuula\.co|youtube\.com|m\.youtube\.com|youtu\.be)$/.test(x.hostname) ? x.href.slice(0, 300) : undefined; } catch (e) { return undefined; }
}
async function shareListing(listingId, email) {
  const { rows: [l] } = await q("select l.data, u.agent_key from listings l join users u on u.id = l.user_id where l.id = $1", [listingId]);
  if (!l || !l.data.sharedOffer) return;
  const d = l.data, beds = Math.max(0, Math.min(4, parseInt(d.beds, 10) || 0)), price = Number(d.price) || null;
  const LAYOUTS = { simplex: "simplex", duplex: "duplex", loft: "duplex loft", semipenthouse: "semi-penthouse" }, layout = LAYOUTS[d.layout] ? d.layout : undefined;
  const offer = {
    b: Math.max(1, Math.min(5, parseInt(d.b, 10) || 3)), beds, deal: d.deal === "rent" ? "rent" : "sale",
    title: `${["Studio", "1 bed", "2 bed", "3 bed", "4 bed"][beds]}${layout ? " " + LAYOUTS[layout] : ""}, ${str(d.floor, 40)}${/floor/i.test(d.floor || "") ? "" : " floor"}`, layout,
    price: d.deal === "rent" ? null : price, rent: d.deal === "rent" ? price : null, size: Number(d.size) || null,
    floor: str(d.floor, 40), view: str(d.view, 80) || "On request", furn: str(d.furn, 40) || "—", baths: "—",
    status: SHARE_STATUS[d.status] || "Ready", avail: "Available", agent: str(d.agent, 40) || l.agent_key || "",
    hl: str(d.shareNote, 500), teamOnly: d.shareTo !== "all", fromListing: listingId, tour: cleanTour(d.tour), tower: +d.b === 4 && ["A", "B"].includes(d.tower) ? d.tower : undefined, src: "Shared by the listing agent"
  };
  // The agent's own photos (uploaded in My units) go with the shared offer.
  const ph = Array.isArray(d.photos) ? d.photos.filter(p => p && /^\/api\/media\?id=[A-Za-z0-9-]{1,64}$/.test(String(p.u || ""))).slice(0, 30).map(p => ({ u: p.u, c: str(p.c, 80), t: "p" })) : [];
  if (ph.length) offer.photos = ph;
  if (d.priceReview && d.priceReview.status !== "approved") { offer.teamOnly = true; offer.pricePending = true; } else offer.pricePending = undefined;
  const { rows: [prev] } = await q("select data from offers where id = $1", [d.sharedOffer]);
  await q(`insert into offers (id, data, updated_at) values ($1, $2, now())
           on conflict (id) do update set data = excluded.data, updated_at = now()`, [d.sharedOffer, prev ? { ...prev.data, ...offer, avail: prev.data.avail || "Available" } : offer]);
  await recordHistory(d.sharedOffer, prev && prev.data, offer, email);
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
    // An Orla agent whose account isn't linked to their agent profile yet (name spelled differently at sign-up): link it now.
    if (c.user.role === "agent" && !c.user.agent_key) { try { await guessAgentKey(c.user); } catch (e) {} }
    return { user: publicUser(c.user) };
  },

  "POST auth/register": async c => {
    const name = str(c.body.name, 100), email = checkEmail(c.body.email), password = checkNewPassword(c.body.password);
    const role = SIGNUP_ROLES.includes(c.body.role) ? c.body.role : "client", company = str(c.body.company, 120), phone = str(c.body.phone, 40);
    if (role === "broker" && !company) fail(400, "Enter the name of your agency.", "no_company");
    if (!name) fail(400, "Enter your full name.", "no_name");
    await limit("register:" + c.ip, 10, 3600);
    const isAdmin = !!ADMIN_EMAIL && email === ADMIN_EMAIL;
    if (!isAdmin && role !== "agent" && phone.replace(/[^0-9]/g, "").length < 7) fail(400, "Enter your mobile number so our agents can arrange viewings.", "no_phone");
    const emailOn = mailEnabled();
    let user;
    try {
      ({ rows: [user] } = await q(
        `insert into users (email, name, pass_hash, role, status, email_verified, company, phone)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
        [email, name, await hashPassword(password), isAdmin ? "admin" : role, isAdmin || role === "client" ? "active" : "pending", !emailOn, company, phone]));
    } catch (e) {
      if (e.code === "23505" && /only_one_admin/.test(e.constraint || "")) fail(409, "The admin account already exists.", "admin_exists");
      if (e.code === "23505") fail(409, "An account with this email already exists. Sign in instead.", "exists");
      throw e;
    }
    if (role === "agent" && !isAdmin) await guessAgentKey(user);
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
    // Owners invited by their agent sign in with their mobile number; everyone else with their email.
    const login = String(c.body.email || "").trim(), password = String(c.body.password || ""), digits = login.replace(/[^0-9]/g, "");
    const byPhone = !login.includes("@") && digits.length >= 7, email = byPhone ? "" : checkEmail(login);
    await limit("login:" + (byPhone ? digits.slice(-9) : email), 10, 900);
    await limit("login-ip:" + c.ip, 50, 900);
    let user;
    if (byPhone) {
      const { rows } = await q("select * from users where right(regexp_replace(phone, '[^0-9]', '', 'g'), 9) = $1 and status <> 'blocked'", [digits.slice(-9)]);
      if (rows.length > 1) fail(400, "More than one account uses this number. Sign in with your email.", "phone_ambiguous");
      user = rows[0];
    } else ({ rows: [user] } = await q("select * from users where email = $1", [email]));
    const ok = await checkPassword(password, user && user.pass_hash);
    if (!user || !ok) fail(401, byPhone ? "Wrong mobile number or password." : "Wrong email or password.", "bad_login");
    if (user.status === "blocked") fail(403, "This account doesn't have access. Contact the admin.", "blocked");
    if (mailEnabled() && !user.email_verified) {
      const canResend = await limit("resend:" + email, 3, 3600).then(() => true, () => false);
      if (canResend) await sendVerification(c.req, user);
      fail(403, "Confirm your email first. We've just sent you a new confirmation link.", "unverified");
    }
    if (user.role === "agent" && !user.agent_key) { try { await guessAgentKey(user); } catch (e) {} }
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
    let rows = isStaff(c.user) ? offers.rows : offers.rows.filter(r => !r.data.teamOnly);
    if (c.user.role === "client") rows = startingPrices(rows);
    return { offers: rows.map(r => ({ ...r, data: forRole(r.data, c.user) })), settings: settings.rows[0]?.data || {}, state: state.rows[0]?.data || null };
  },

  "PUT data/state": async c => {
    requireActive(c);
    const data = c.body.data;
    if (!data || typeof data !== "object" || JSON.stringify(data).length > 500000) fail(400, "Invalid data.");
    await q(`insert into user_state (user_id, data, updated_at) values ($1, $2, now())
             on conflict (user_id) do update set data = excluded.data, updated_at = now()`, [c.user.id, data]);
    return { ok: true };
  },

  // An agent's own units. Each agent reads only their own; the admin reads everyone's.
  "GET data/listings": async c => {
    requireStaff(c);
    const admin = seesAll(c.user);
    const { rows } = await q(
      `select l.id, l.user_id, l.data, l.created_at, l.updated_at, u.name, u.email, u.agent_key
       from listings l join users u on u.id = l.user_id
       ${admin ? "" : "where l.user_id = $1"} order by l.created_at`, admin ? [] : [c.user.id]);
    return { listings: rows.map(r => ({ id: r.id, data: r.data, createdAt: r.created_at, updatedAt: r.updated_at, own: r.user_id === c.user.id,
      by: { id: r.user_id, name: r.name, email: r.email, agentKey: r.agent_key } })) };
  },

  // Units the team added in the last days, for the "new on the team" alert. Teammates see the home and the floor,
  // never the unit number or the owner; the admin, the CEO and the agent who added it see the unit number too.
  "GET team/new-units": async c => {
    requireStaff(c);
    const days = Math.min(14, Math.max(1, parseInt(new URL(c.req.url, "http://localhost").searchParams.get("days"), 10) || 7));
    const [{ rows: L }, { rows: O }, { rows: st }] = await Promise.all([
      q(`select l.id, l.data, l.created_at, u.id as uid, u.name, u.agent_key from listings l join users u on u.id = l.user_id
         where l.created_at > now() - make_interval(days => $1) order by l.created_at desc limit 60`, [days]),
      q(`select id, data, created_at from offers where created_at > now() - make_interval(days => $1) and coalesce(data->>'agent', '') <> ''
         and coalesce(data->>'fromListing', '') = '' order by created_at desc limit 60`, [days]),
      q("select data from settings where id = 'app'")]);
    const agents = (st[0] && st[0].data && st[0].data.agents) || {};
    const keyOf = {}; for (const r of L) keyOf[r.uid] = r.agent_key;
    const shape = (d, at, by, mine, offerId) => {
      const f = floorFromUnit(d);
      return { at, by, mine, offerId: offerId || null, b: +d.b || null, tower: +d.b === 4 ? d.tower || "" : "", beds: d.beds === undefined || d.beds === "" ? null : +d.beds, layout: d.layout || "",
        size: d.size ? +String(d.size).replace(/[^0-9.]/g, "") || null : null, floor: f.floor || "", view: d.view || "", deal: d.deal || "", price: d.deal === "rent" ? null : +d.price || null,
        rent: d.deal === "rent" ? +d.price || +d.rent || null : +d.rent || null, furn: d.furn || "", future: !!d.future, unit: seesAll(c.user) || mine ? d.unit || "" : undefined };
    };
    const items = L.map(r => shape(r.data, r.created_at, { name: r.name || "", agentKey: r.agent_key || "" }, r.uid === c.user.id, r.data.sharedOffer))
      .concat(O.map(r => shape(r.data, r.created_at, { name: (agents[r.data.agent] || {}).name || r.data.agent, agentKey: r.data.agent }, !!c.user.agent_key && r.data.agent === c.user.agent_key, r.id)))
      .sort((a, z) => new Date(z.at) - new Date(a.at));
    return { items };
  },

  "PUT data/listings": async c => {
    requireTeam(c);
    const id = str(c.body.id, 64), data = c.body.data;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) fail(400, "Invalid listing id.");
    if (!data || typeof data !== "object" || Array.isArray(data) || JSON.stringify(data).length > 20000) fail(400, "Invalid listing.");
    const { rows: [prev] } = await q("select user_id, data from listings where id = $1", [id]);
    if (prev && prev.user_id !== c.user.id && c.user.role !== "admin") fail(403, "This listing belongs to another agent.");
    // The owner's account is linked only by the invitation (team/invite), never by a save.
    if (prev && prev.data.ownerUserId) data.ownerUserId = prev.data.ownerUserId; else delete data.ownerUserId;
    // Price approval (see reviewFor). An agent can't approve their own price; changing the price asks again.
    const review = reviewFor(c.user, data, prev && prev.data);
    if (review) data.priceReview = review; else delete data.priceReview;
    // Not approved yet: it can't be marked online on the platforms either.
    if (review && review.status !== "approved" && data.online && typeof data.online === "object") data.online = data.online.off ? { off: true } : {};
    const newlyPending = review && review.status === "pending" && !(prev && prev.data.priceReview && prev.data.priceReview.status === "pending" && priceKey(prev.data) === priceKey(data));
    // The day a listing first went live on every platform counts towards the team goal.
    const goal = await teamGoal(), on = data.online && typeof data.online === "object" ? data.online : {};
    if (on.off) { for (const p of goal.platforms) delete on[p.k]; data.online = { off: true }; }
    if (goal.platforms.length && goal.platforms.every(p => on[p.k])) data.onlineAt = (prev && prev.data.onlineAt) || new Date().toISOString();
    else delete data.onlineAt;
    if (!prev) {
      const { rows: [n] } = await q("select count(*)::int as n from listings where user_id = $1", [c.user.id]);
      if (n.n >= 1000) fail(400, "You've reached 1,000 listings. Delete old ones first.");
      await q("insert into listings (id, user_id, data) values ($1, $2, $3)", [id, c.user.id, data]);
    } else await q("update listings set data = $2, updated_at = now() where id = $1", [id, data]);
    if (data.sharedOffer) await shareListing(id, c.user.email);
    if (newlyPending) await notifyAdminsReview(id, data, appUrl(c.req));
    return { ok: true, warning: await claimWarning(c.user, data), review: data.priceReview ? data.priceReview.status : null };
  },

  // An agent shares their own unit as an offer: with the floor, never the unit number or the owner.
  // The admin (or the CEO) approves or rejects a price above the market. The agent gets a notification either way.
  "POST team/price-review": async c => {
    requireStaff(c);
    if (!seesAll(c.user)) fail(403, "Only the admin approves prices.", "not_allowed");
    const id = str(c.body.id, 64), ok = c.body.decision === "approve", note = str(c.body.note, 500);
    const { rows: [l] } = await q("select user_id, data from listings where id = $1", [id]);
    if (!l || !l.data.priceReview) fail(404, "Nothing to review for this listing.");
    const data = { ...l.data, priceReview: { ...l.data.priceReview, status: ok ? "approved" : "rejected", decidedAt: new Date().toISOString(), decidedBy: str(c.user.name || c.user.email, 100), note } };
    await q("update listings set data = $2, updated_at = now() where id = $1", [id, data]);
    if (data.sharedOffer) await shareListing(id, c.user.email);
    await q("insert into activity (by_user, by_email, text) values ($1, $2, $3)", [c.user.id, c.user.email, `${ok ? "Approved" : "Rejected"} the price of listing ${id} (${data.priceReview.pct}% above market)`]);
    const B = ["", "Peninsula One", "Peninsula Two", "Peninsula Three", "Peninsula Four", "Peninsula Five"][+data.b] || "Peninsula";
    try { await pushTo([l.user_id], { title: ok ? "Price approved ✓" : "Price not approved", body: `${B}${data.unit ? " · unit " + data.unit : ""}${note ? "\n" + note : ok ? "\nIt can go online now." : "\nLower the price to within 7% of the market, or add more reasons."}`, url: "/app/#approvals", tag: "prd-" + id }); } catch (e) {}
    return { ok: true, status: data.priceReview.status };
  },

  "POST data/listings/share": async c => {
    requireTeam(c);
    const id = str(c.body.id, 64);
    const { rows: [l] } = await q("select user_id, data from listings where id = $1", [id]);
    if (!l || (l.user_id !== c.user.id && c.user.role !== "admin")) fail(404, "Listing not found.");
    const data = { ...l.data };
    if (c.body.share === false) {
      if (data.sharedOffer) {
        const { rows: [prev] } = await q("delete from offers where id = $1 and data->>'fromListing' = $2 returning data", [data.sharedOffer, id]);
        if (prev) await q("insert into offer_history (offer_id, by_email, kind, title) values ($1, $2, 'removed', $3)", [data.sharedOffer, c.user.email, str(prev.data.title, 200)]);
      }
      delete data.sharedOffer; delete data.shareTo; delete data.shareNote;
    } else {
      const floor = str(c.body.floor ?? data.floor, 40);
      if (!floor) fail(400, "Add the floor before sharing.", "no_floor");
      Object.assign(data, { floor, shareTo: c.body.to === "all" ? "all" : "team", shareNote: str(c.body.note ?? data.shareNote, 500), sharedOffer: "s-" + id.slice(0, 60) });
    }
    await q("update listings set data = $2, updated_at = now() where id = $1", [id, data]);
    if (data.sharedOffer) await shareListing(id, c.user.email);
    return { ok: true, offerId: data.sharedOffer || null };
  },

  // The AI assistant for the Orla team: finds a unit and its owner (own units only), and drafts the listing.
  "GET ai/status": async c => { requireStaff(c); return { enabled: aiEnabled() }; },
  "POST ai/assist": async c => {
    requireStaff(c);
    const raw = Array.isArray(c.body.messages) ? c.body.messages.slice(-30) : [];
    const history = raw.map(m => ({ role: m && m.role === "assistant" ? "assistant" : "user", text: str(m && m.text, 8000) })).filter(m => m.text);
    // Photos and PDFs sent with the newest message (resized on the phone first).
    const files = (Array.isArray(c.body.files) ? c.body.files : []).slice(0, 5).map(f => ({ name: str(f && f.name, 120), mime: str(f && f.mime, 40), data: String((f && f.data) || "") }))
      .filter(f => /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(f.mime) && /^[A-Za-z0-9+/=]+$/.test(f.data));
    if (files.reduce((n, f) => n + f.data.length, 0) > 4.2e6) fail(413, "The files are too big. Send fewer photos, or a smaller PDF (under 3 MB).");
    while (history.length && history[0].role !== "user") history.shift();
    if (!history.length || history[history.length - 1].role !== "user") fail(400, "Type a message.");
    await limit("ai:" + c.user.id, 80, 3600);
    if (!aiEnabled()) return assistOffline(c.user, history);
    const { rows: [st] } = await q("select data from settings where id = 'app'");
    const opts = { teamStats, appUrl: appUrl(c.req), files };
    // Streamed: the agent sees what it's doing and the reply as it's written.
    if (c.body.stream) {
      c.res.statusCode = 200;
      c.res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      c.res.setHeader("Cache-Control", "no-cache, no-transform");
      c.res.setHeader("X-Accel-Buffering", "no");
      const ev = o => { try { c.res.write("data: " + JSON.stringify(o) + "\n\n"); } catch (e) {} };
      const ping = setInterval(() => ev({ type: "ping" }), 15000);
      try { const out = await assist(c.user, history, (st && st.data && st.data.agents) || SETTINGS.agents, { ...opts, onEvent: ev }); ev({ type: "done", ...out }); }
      catch (e) {
        let msg = "The assistant couldn't answer. Try again.";
        if (e instanceof Anthropic.AuthenticationError) msg = "The AI key isn't valid. The admin needs to update ANTHROPIC_API_KEY.";
        else if (e instanceof Anthropic.RateLimitError) msg = "The assistant is busy. Try again in a minute.";
        else if (e instanceof Anthropic.APIConnectionError) msg = "Couldn't reach the AI service. Try again.";
        else if (e instanceof Anthropic.BadRequestError && files.length) msg = "I couldn't read that file. Try a clearer photo or a smaller PDF.";
        console.error("assistant", e.status, e.message);
        ev({ type: "error", error: msg });
      } finally { clearInterval(ping); c.res.end(); }
      return RAW;
    }
    try { return await assist(c.user, history, (st && st.data && st.data.agents) || SETTINGS.agents, opts); }
    catch (e) {
      if (e instanceof Anthropic.AuthenticationError) fail(503, "The AI key isn't valid. The admin needs to update ANTHROPIC_API_KEY.", "ai_key");
      if (e instanceof Anthropic.RateLimitError) fail(429, "The assistant is busy. Try again in a minute.", "ai_busy");
      if (e instanceof Anthropic.APIConnectionError) fail(503, "Couldn't reach the AI service. Try again.", "ai_down");
      if (e instanceof Anthropic.APIError) { console.error("assistant", e.status, e.message); fail(502, "The assistant couldn't answer. Try again.", "ai_error"); }
      throw e;
    }
  },

  // The Peninsula contacts database. The Orla team searches it; the admin imports it. Every lookup is logged.
  "GET team/contacts": async c => {
    requireStaff(c);
    const query = str(new URL(c.req.url, "http://localhost").searchParams.get("q"), 80);
    if (query.replace(/\s/g, "").length < 2) fail(400, "Type a phone number, a unit number or a name.");
    await limit("contacts:" + c.user.id, 300, 3600);
    const contacts = await searchContacts(query, c.user);
    await q("insert into activity (by_user, by_email, text) values ($1, $2, $3)", [c.user.id, c.user.email, `Contacts lookup: ${query} (${contacts.length} found)`]);
    return { contacts };
  },
  "GET admin/contacts": async c => { requireAdmin(c); return contactStats(); },
  "POST admin/contacts/import": async c => {
    requireAdmin(c);
    const rows = Array.isArray(c.body.rows) ? c.body.rows : [];
    if (rows.length > 2000) fail(400, "Send at most 2,000 rows at a time.");
    const n = await importContacts(rows, c.body.replace === true);
    if (c.body.last) await q("insert into activity (by_user, by_email, text) values ($1, $2, $3)", [c.user.id, c.user.email, `Imported the Peninsula contacts (${str(c.body.file, 120) || "file"})`]);
    return { imported: n, ...(c.body.last ? await contactStats() : {}) };
  },
  "POST admin/contacts/clear": async c => {
    requireAdmin(c);
    await q("delete from contacts");
    await q("insert into activity (by_user, by_email, text) values ($1, $2, $3)", [c.user.id, c.user.email, "Deleted the Peninsula contacts"]);
    return contactStats();
  },

  // Tower A or B on an offer: the agent it's listed under, or the admin, sets it.
  "POST data/offers/tower": async c => {
    requireTeam(c);
    const id = str(c.body.id, 80), tower = ["A", "B"].includes(c.body.tower) ? c.body.tower : null;
    const { rows: [o] } = await q("select data from offers where id = $1", [id]);
    if (!o) fail(404, "Offer not found.");
    if (c.user.role !== "admin" && !(c.user.agent_key && o.data.agent === c.user.agent_key)) fail(403, "Only the agent this unit is listed under, or the admin, can set its tower.");
    const data = { ...o.data };
    if (tower) data.tower = tower; else delete data.tower;
    await q("update offers set data = $2, updated_at = now(), updated_by = $3 where id = $1", [id, data, c.user.id]);
    await q("insert into activity (by_user, by_email, text) values ($1, $2, $3)", [c.user.id, c.user.email, `Set ${str(o.data.title, 80) || id} to ${tower ? "Tower " + tower : "no tower"}`]);
    return { ok: true, tower };
  },

  // Orla agents invite their own clients and external agents: the account is ready straight away, like the admin's.
  "POST team/invite": async c => {
    requireTeam(c);
    const name = str(c.body.name, 100), phone = str(c.body.phone, 40), digits = phone.replace(/[^0-9]/g, "");
    // An owner invited from a listing may have no email: they sign in with their mobile number.
    if (!str(c.body.email, 254) && digits.length < 7) fail(400, "Enter their email or mobile number.", "no_contact");
    const email = str(c.body.email, 254) ? checkEmail(c.body.email) : `m${digits}@mobile.peninsula`;
    const listingId = str(c.body.listingId, 64);
    let listing = null;
    if (listingId) {
      ({ rows: [listing] } = await q("select id, user_id, data from listings where id = $1", [listingId]));
      if (!listing || (listing.user_id !== c.user.id && !seesAll(c.user))) fail(404, "Listing not found.");
    }
    const ABC0 = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    // Already has an account (same email, or same mobile for a client): a new password and the property linked to it.
    const { rows: [prev] } = await q(`select * from users where email = $1 or ($2 <> '' and role = 'client' and right(regexp_replace(phone, '[^0-9]', '', 'g'), 9) = $2) limit 1`, [email, digits.length >= 7 ? digits.slice(-9) : ""]);
    if (prev && listing) {
      if (prev.role !== "client") fail(409, "This person already has an account as " + (prev.role === "broker" ? "an external agent" : "part of the team") + ".", "exists");
      if (prev.invited_by && prev.invited_by !== c.user.id && !seesAll(c.user)) fail(409, "This owner was invited by another agent.", "exists");
      const pw = Array.from(crypto.randomBytes(10), b => ABC0[b % ABC0.length]).join("");
      await q("update users set pass_hash = $2, status = case when status = 'blocked' then status else 'active' end, invited_by = coalesce(invited_by, $3), phone = case when phone = '' then $4 else phone end where id = $1", [prev.id, await hashPassword(pw), c.user.id, phone]);
      await q("update listings set data = data || jsonb_build_object('ownerUserId', $2::text) where id = $1", [listing.id, prev.id]);
      await q("insert into activity (by_user, by_email, text) values ($1, $2, $3)", [c.user.id, c.user.email, `Sent ${prev.name} a new invitation for their property`]);
      return { email: prev.email, password: pw, phone: prev.phone || phone, login: prev.email.endsWith("@mobile.peninsula") ? (prev.phone || phone) : prev.email, existing: true, url: appUrl(c.req) + "/app/" };
    }
    const role = c.body.role === "broker" ? "broker" : "client", company = str(c.body.company, 120);
    if (!name) fail(400, "Enter their full name.", "no_name");
    if (role === "broker" && !company) fail(400, "Enter the name of their agency.", "no_company");
    if (phone && phone.replace(/[^0-9]/g, "").length < 7) fail(400, "Check the mobile number.", "bad_phone");
    await limit("invite:" + c.user.id, 40, 86400);
    const ABC = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const password = Array.from(crypto.randomBytes(10), b => ABC[b % ABC.length]).join("");
    try {
      const { rows: [nu] } = await q(`insert into users (email, name, pass_hash, role, status, email_verified, company, phone, invited_by)
               values ($1, $2, $3, $4, 'active', true, $5, $6, $7) returning id`, [email, name, await hashPassword(password), role, company, phone, c.user.id]);
      if (listing) await q("update listings set data = data || jsonb_build_object('ownerUserId', $2::text) where id = $1", [listing.id, nu.id]);
    } catch (e) {
      if (e.code === "23505") fail(409, "This email already has an account. Ask the admin for a new password link if they forgot it.", "exists");
      throw e;
    }
    await q("insert into activity (by_user, by_email, text) values ($1, $2, $3)", [c.user.id, c.user.email, `Invited ${name} (${email}) as ${role === "broker" ? "an external agent" : "a client"}`]);
    return { email, password, phone, login: email.endsWith("@mobile.peninsula") ? phone : email, url: appUrl(c.req) + "/app/" };
  },
  "GET team/invites": async c => {
    requireStaff(c);
    const admin = seesAll(c.user);
    const { rows } = await q(`select u.id, u.name, u.email, u.phone, u.role, u.company, u.status, u.created_at, i.name as invited_by_name,
        (select max(s.created_at) from sessions s where s.user_id = u.id) as last_seen
      from users u join users i on i.id = u.invited_by ${admin ? "" : "where u.invited_by = $1"} order by u.created_at desc limit 200`, admin ? [] : [c.user.id]);
    return { invites: rows };
  },

  // Registered Peninsula deals for comparisons: the admin imports a DXB Interact (or DLD) export.
  "GET admin/deals": async c => { requireAdmin(c); return dealStats(); },
  "POST admin/deals/import": async c => {
    requireAdmin(c);
    const rows = Array.isArray(c.body.rows) ? c.body.rows : [];
    if (rows.length > 2000) fail(400, "Send at most 2,000 rows at a time.");
    const r = await importDeals(rows, { replace: c.body.replace === true, kind: c.body.kind === "rent" ? "rent" : "sale", sqm: c.body.sqm === true, source: str(c.body.file, 60) });
    if (c.body.last) await q("insert into activity (by_user, by_email, text) values ($1, $2, $3)", [c.user.id, c.user.email, `Imported Peninsula deals (${str(c.body.file, 120) || "file"})`]);
    return { ...r, ...(c.body.last ? await dealStats() : {}) };
  },
  "POST admin/deals/clear": async c => {
    requireAdmin(c);
    await q("delete from market_deals");
    return dealStats();
  },

  // The team chat. Everyone on the team and the CEO; the newest 200 messages, or those after the last one seen.
  "GET team/chat": async c => {
    requireStaff(c);
    const after = Math.max(0, parseInt(new URL(c.req.url, "http://localhost").searchParams.get("after") || "0", 10) || 0);
    const { rows } = after
      ? await q("select id, user_id, name, role, text, at, deleted from team_chat where id > $1 order by id limit 200", [after])
      : await q("select * from (select id, user_id, name, role, text, at, deleted from team_chat order by id desc limit 200) x order by id");
    return { messages: rows.map(m => ({ id: +m.id, mine: m.user_id === c.user.id, name: m.name, role: m.role, text: m.deleted ? "" : m.text, deleted: m.deleted, at: m.at })) };
  },
  "POST team/chat": async c => {
    requireStaff(c);
    const text = String(c.body.text || "").replace(/\r/g, "").trim().slice(0, 2000);
    if (!text) fail(400, "Type a message.");
    await limit("chat:" + c.user.id, 120, 3600);
    const { rows: [m] } = await q("insert into team_chat (user_id, name, role, text) values ($1, $2, $3, $4) returning id, at",
      [c.user.id, c.user.name || c.user.email, c.user.role, text]);
    return { id: +m.id, at: m.at };
  },
  "POST team/chat/delete": async c => {
    requireStaff(c);
    const { rowCount } = await q("update team_chat set deleted = true where id = $1 and (user_id = $2 or $3)", [parseInt(c.body.id, 10) || 0, c.user.id, c.user.role === "admin"]);
    if (!rowCount) fail(404, "Message not found.");
    return { ok: true };
  },
  // The CEO's page: the team's numbers in one place (counts only, no clients or owners).
  "GET team/overview": async c => {
    requireStaff(c);
    const [{ rows: leads }, { rows: invites }, { rows: offers }] = await Promise.all([
      q(`select agent_key, count(*)::int as all, count(*) filter (where kind = 'viewing')::int as viewings, count(*) filter (where not done)::int as open,
           count(*) filter (where at > now() - interval '7 days')::int as week from leads where at > now() - interval '30 days' group by agent_key`),
      q(`select i.agent_key, i.name, count(*)::int as sent, count(*) filter (where exists (select 1 from sessions s where s.user_id = u.id))::int as signed_in
         from users u join users i on i.id = u.invited_by group by i.agent_key, i.name`),
      q(`select count(*) filter (where coalesce(data->>'avail', 'Available') !~* 'sold|rented|reserved')::int as available,
           count(*) filter (where data->>'deal' <> 'rent')::int as sale, count(*) filter (where data->>'deal' <> 'sale')::int as rent from offers`)]);
    return { leads, invites, offers: offers[0] };
  },

  // AI training: the CEO and the admin teach the assistant (rules, knowledge, quick questions). Everyone on the team can read it.
  "GET ai/notes": async c => {
    requireStaff(c);
    const { rows } = await q("select id, kind, title, text, active, by_name, updated_at from ai_notes order by kind, id");
    return { notes: rows.map(r => ({ ...r, id: +r.id })), canEdit: seesAll(c.user) };
  },
  "POST ai/notes": async c => {
    requireStaff(c);
    if (!seesAll(c.user)) fail(403, "Only the CEO and the admin can train the assistant.", "not_trainer");
    const kind = ["rule", "knowledge", "quick"].includes(c.body.kind) ? c.body.kind : "knowledge", title = str(c.body.title, 120);
    const text = String(c.body.text || "").replace(/\r/g, "").trim().slice(0, kind === "quick" ? 200 : 8000), active = c.body.active !== false;
    if (!text) fail(400, kind === "quick" ? "Type the question." : "Write what the assistant should know.");
    const id = parseInt(c.body.id, 10) || 0;
    const { rows: [{ total }] } = await q("select coalesce(sum(length(text)), 0)::int as total from ai_notes where id <> $1", [id]);
    if (total + text.length > 60000) fail(400, "The training is full (60,000 characters). Shorten or delete older notes.", "too_long");
    if (id) {
      const { rowCount } = await q("update ai_notes set kind = $2, title = $3, text = $4, active = $5, by_user = $6, by_name = $7, updated_at = now() where id = $1", [id, kind, title, text, active, c.user.id, c.user.name || c.user.email]);
      if (!rowCount) fail(404, "Note not found.");
    } else await q("insert into ai_notes (kind, title, text, active, by_user, by_name) values ($1, $2, $3, $4, $5, $6)", [kind, title, text, active, c.user.id, c.user.name || c.user.email]);
    await q("insert into activity (by_user, by_email, text) values ($1, $2, $3)", [c.user.id, c.user.email, `${id ? "Edited" : "Added"} AI training: ${title || text.slice(0, 60)}`]);
    return { ok: true };
  },
  "POST ai/notes/delete": async c => {
    requireStaff(c);
    if (!seesAll(c.user)) fail(403, "Only the CEO and the admin can train the assistant.", "not_trainer");
    await q("delete from ai_notes where id = $1", [parseInt(c.body.id, 10) || 0]);
    return { ok: true };
  },

  // Private tasks: the admin or the CEO gives one to an agent; only that agent, the admin and the CEO see it.
  "GET team/tasks": async c => {
    requireStaff(c);
    const all = seesAll(c.user);
    if (!all && !c.user.agent_key) return { tasks: [] };
    const { rows } = await q(`select id, agent_key, title, notes, due, done, done_at, by_name, created_at from tasks
      ${all ? "" : "where agent_key = $1"} order by done, due nulls last, created_at desc limit 500`, all ? [] : [c.user.agent_key]);
    return { tasks: rows.map(t => ({ ...t, id: +t.id, due: t.due ? new Date(t.due).toISOString().slice(0, 10) : null })) };
  },
  "POST team/tasks": async c => {
    requireStaff(c);
    if (!seesAll(c.user)) fail(403, "Only the admin and the CEO give tasks.", "not_allowed");
    const agent = str(c.body.agent, 40), title = str(c.body.title, 200), notes = str(c.body.notes, 2000), due = /^\d{4}-\d{2}-\d{2}$/.test(c.body.due || "") ? c.body.due : null;
    if (!/^[A-Za-z0-9_-]+$/.test(agent)) fail(400, "Choose the agent.");
    if (!title) fail(400, "Write the task.");
    const id = parseInt(c.body.id, 10) || 0;
    if (id) await q("update tasks set agent_key = $2, title = $3, notes = $4, due = $5 where id = $1", [id, agent, title, notes, due]);
    else await q("insert into tasks (agent_key, title, notes, due, by_user, by_name) values ($1, $2, $3, $4, $5, $6)", [agent, title, notes, due, c.user.id, c.user.name || c.user.email]);
    await q("insert into activity (by_user, by_email, text) values ($1, $2, $3)", [c.user.id, c.user.email, `${id ? "Edited" : "Gave"} a task to ${agent}: ${title.slice(0, 80)}`]);
    return { ok: true };
  },
  "POST team/tasks/done": async c => {
    requireStaff(c);
    const done = c.body.done !== false;
    const { rowCount } = await q("update tasks set done = $2, done_at = case when $2 then now() else null end where id = $1 and ($3 or agent_key = $4)",
      [parseInt(c.body.id, 10) || 0, done, seesAll(c.user), c.user.agent_key || "-"]);
    if (!rowCount) fail(404, "Task not found.");
    return { ok: true };
  },
  "POST team/tasks/delete": async c => {
    requireStaff(c);
    if (!seesAll(c.user)) fail(403, "Only the admin and the CEO delete tasks.", "not_allowed");
    await q("delete from tasks where id = $1", [parseInt(c.body.id, 10) || 0]);
    return { ok: true };
  },

  // The CEO's weekly summary. Vercel Cron calls this every Sunday morning (see vercel.json); it runs once per week.
  "GET cron/weekly": async c => {
    const secret = process.env.CRON_SECRET, auth = c.req.headers.authorization || "";
    if (secret ? auth !== "Bearer " + secret : !/vercel-cron/i.test(c.req.headers["user-agent"] || "")) fail(401, "Not allowed.");
    return runWeekly(teamStats, appUrl(c.req));
  },
  // Every morning (Vercel Cron): the team's pace to the CEO and the admin, and on Sundays the weekly summary too.
  "GET cron/daily": async c => {
    const secret = process.env.CRON_SECRET, auth = c.req.headers.authorization || "";
    if (secret ? auth !== "Bearer " + secret : !/vercel-cron/i.test(c.req.headers["user-agent"] || "")) fail(401, "Not allowed.");
    const out = { daily: await runDaily(teamStats, appUrl(c.req)), reminders: await deliverDue({ force: true }), briefing: await morningBriefing().catch(e => { console.error("briefing", e); return 0; }) };
    if (new Date(Date.now() + 4 * 3600e3).getUTCDay() === 0) out.weekly = await runWeekly(teamStats, appUrl(c.req));
    return out;
  },
  // Every 5 minutes or so (an outside scheduler, optional): sends due reminders even when nobody has the app open.
  "GET cron/reminders": async c => {
    const secret = process.env.CRON_SECRET, auth = c.req.headers.authorization || "", key = new URL(c.req.url, "http://localhost").searchParams.get("key") || "";
    if (secret ? auth !== "Bearer " + secret && key !== secret : !/vercel-cron/i.test(c.req.headers["user-agent"] || "")) fail(401, "Not allowed.");
    return { sent: await deliverDue({ force: true }) };
  },
  "GET team/reminders": async c => {
    requireStaff(c);
    const all = new URL(c.req.url, "http://localhost").searchParams.get("all") === "1";
    return { reminders: await listReminders(c.user, { all, days: 60 }) };
  },
  "POST team/reminders": async c => {
    requireStaff(c);
    await limit("rem:" + c.user.id, 120, 3600);
    try {
      const r = await addReminder(c.user, { when: c.body.when, text: c.body.text, who: c.body.who, link: c.body.link });
      if (c.body.when === "now") await deliverDue({ force: true }); // sent to the phone straight away
      return { reminder: r };
    } catch (e) { fail(e.status || 400, e.message); }
  },
  "POST team/reminders/update": async c => {
    requireStaff(c);
    const id = parseInt(c.body.id, 10) || 0, a = c.body.action;
    const ok = a === "delete" ? await removeReminder(c.user, id) : a === "snooze" ? await snooze(c.user, id, c.body.minutes) : await setDone(c.user, id, a !== "reopen");
    if (!ok) fail(404, "Reminder not found.");
    return { ok: true };
  },
  "GET team/weekly": async c => {
    requireStaff(c);
    if (!seesAll(c.user)) fail(403, "Only the CEO and the admin see the weekly summary.", "not_allowed");
    const { rows } = await q("select week, data, created_at from weekly_reports order by week desc limit 8");
    const live = new URL(c.req.url, "http://localhost").searchParams.get("live") === "1" ? await buildWeekly(teamStats) : null;
    const reports = rows.map(r => ({ week: r.week, data: r.data, text: weeklyText(r.data, c.user.role === "ceo" ? greet(c.user) : ""), at: r.created_at }));
    return { reports, live: live && { data: live, text: weeklyText(live, c.user.role === "ceo" ? greet(c.user) : "") } };
  },
  "POST team/weekly/send": async c => {
    requireAdmin(c);
    return runWeekly(teamStats, appUrl(c.req), { force: true });
  },

  // Anonymous visits from the website and the app (see app/track.js).
  "POST track": async c => {
    const ua = String(c.req.headers["user-agent"] || "");
    if (/bot|crawl|spider|slurp|preview|headless/i.test(ua)) return { ok: true };
    await limit("track:" + c.ip, 600, 3600);
    const vid = str(c.body.vid, 40).replace(/[^a-z0-9]/gi, "");
    if (!vid) return { ok: true };
    const w = Number(c.body.w) || 0, device = /ipad|tablet/i.test(ua) || (w >= 700 && w < 1100 && /mobile|android/i.test(ua)) ? "Tablet" : /mobi|iphone|android/i.test(ua) ? "Phone" : "Computer";
    const ref = str(c.body.ref, 80).toLowerCase().replace(/^www\./, ""), path = str(c.body.path, 120);
    await q("insert into visits (vid, path, ref, country, device, lang, role, offer_id, user_id) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [vid, path, ref, str(c.req.headers["x-vercel-ip-country"], 4).toUpperCase(), device, str(c.body.lang, 8), c.user ? c.user.role : "visitor", str(c.body.offer, 80) || null, c.user ? c.user.id : null]);
    return { ok: true };
  },
  // Who uses the app: every account (Orla agents, external agents, clients) with when they were last active, for the admin and the CEO.
  "GET team/users": async c => {
    requireStaff(c);
    if (!seesAll(c.user)) fail(403, "Only the CEO and the admin see the users.", "not_allowed");
    const days = Math.min(90, Math.max(7, parseInt(new URL(c.req.url, "http://localhost").searchParams.get("days") || "30", 10) || 30));
    const [{ rows: users }, { rows: daily }] = await Promise.all([
      q(`select u.id, u.name, u.email, u.phone, u.role, u.company, u.status, u.created_at, u.agent_key, i.name as invited_by,
           greatest((select max(at) from visits v where v.user_id = u.id), (select max(created_at) from sessions s where s.user_id = u.id)) as last_seen,
           (select count(distinct day)::int from visits v where v.user_id = u.id and v.day > (now() at time zone 'Asia/Dubai')::date - 30) as days_30,
           (select count(distinct offer_id)::int from visits v where v.user_id = u.id and v.offer_id is not null) as homes,
           (select count(*)::int from leads l where l.user_id = u.id) as requests
         from users u left join users i on i.id = u.invited_by order by last_seen desc nulls last, u.created_at desc`),
      q(`select day, role, count(distinct user_id)::int as n from visits where user_id is not null and day > (now() at time zone 'Asia/Dubai')::date - $1::int group by 1, 2 order by 1`, [days])]);
    return { days, users: users.map(u => ({ ...u, me: u.id === c.user.id })), daily: daily.map(d => ({ ...d, day: new Date(d.day).toISOString().slice(0, 10) })) };
  },

  // Daily visitors for the admin and the CEO. The Orla team's own visits are left out.
  "GET team/visitors": async c => {
    requireStaff(c);
    if (!seesAll(c.user)) fail(403, "Only the CEO and the admin see the visitors.", "not_allowed");
    const days = Math.min(90, Math.max(7, parseInt(new URL(c.req.url, "http://localhost").searchParams.get("days") || "30", 10) || 30));
    const W = `role not in ('admin', 'agent', 'ceo') and day > (now() at time zone 'Asia/Dubai')::date - $1::int`;
    const top = (col, n = 8, extra = "") => q(`select ${col} as k, count(distinct vid)::int as n from visits where ${W} ${extra} group by 1 order by 2 desc limit ${n}`, [days]);
    const [{ rows: daily }, { rows: [tot] }, { rows: pages }, { rows: refs }, { rows: countries }, { rows: devices }, { rows: offers }, { rows: [signups] }] = await Promise.all([
      q(`with f as (select vid, min(day) as first from visits where role not in ('admin', 'agent', 'ceo') group by vid)
         select v.day, count(distinct v.vid)::int as visitors, count(*)::int as views, count(distinct v.vid) filter (where f.first = v.day)::int as new,
           count(distinct v.vid) filter (where v.role in ('client', 'broker'))::int as signed_in
         from visits v join f using (vid) where ${W.replace(/role/g, "v.role").replace("day >", "v.day >")} group by v.day order by v.day`, [days]),
      q(`select count(distinct vid) filter (where day = (now() at time zone 'Asia/Dubai')::date)::int as today,
           count(distinct vid) filter (where day = (now() at time zone 'Asia/Dubai')::date - 1)::int as yesterday,
           count(distinct vid) filter (where day > (now() at time zone 'Asia/Dubai')::date - 7)::int as week,
           count(distinct vid)::int as period, count(*)::int as views from visits where ${W}`, [days]),
      top("case when path like '/app%' then '/app/' else path end"), top("coalesce(nullif(ref, ''), 'direct')"), top("nullif(country, '')", 8, "and country <> ''"), top("device", 3),
      q(`select offer_id as k, count(distinct vid)::int as n from visits where ${W} and offer_id is not null group by 1 order by 2 desc limit 8`, [days]),
      q(`select count(*)::int as n from users where role in ('client', 'broker') and created_at > now() - ($1::int || ' days')::interval`, [days])]);
    return { days, daily: daily.map(d => ({ ...d, day: new Date(d.day).toISOString().slice(0, 10) })), totals: { ...tot, signups: signups.n }, pages, refs, countries, devices, offers };
  },

  // An owner sees their own property: where it's listed, its status, how many people looked at it and asked for viewings.
  "GET my/property": async c => {
    requireActive(c);
    const { rows } = await q(`select l.id, l.data, l.created_at, u.name as agent_name, u.agent_key from listings l join users u on u.id = l.user_id where l.data->>'ownerUserId' = $1`, [c.user.id]);
    const { rows: [st] } = await q("select data from settings where id = 'app'");
    const agents = (st && st.data && st.data.agents) || SETTINGS.agents;
    const out = [];
    for (const r of rows) {
      const d = r.data, oid = d.sharedOffer || null;
      const [{ rows: [v] }, { rows: [l] }] = oid ? await Promise.all([
        q("select count(distinct vid)::int as views, count(distinct vid) filter (where at > now() - interval '7 days')::int as week from visits where offer_id = $1 and role not in ('admin', 'agent', 'ceo')", [oid]),
        q("select count(*)::int as requests, count(*) filter (where kind = 'viewing')::int as viewings from leads where offer_id = $1", [oid])]) : [{ rows: [{ views: 0, week: 0 }] }, { rows: [{ requests: 0, viewings: 0 }] }];
      const a = agents[d.agent || r.agent_key] || {};
      out.push({ id: r.id, unit: str(d.unit, 20), b: +d.b || null, tower: +d.b === 4 ? d.tower || "" : "", beds: d.beds === undefined || d.beds === "" ? null : +d.beds, layout: d.layout || "",
        size: Number(d.size) || null, floor: str(d.floor, 40), view: str(d.view, 80), deal: d.deal, price: Number(d.price) || null, status: str(d.status, 40), furn: str(d.furn, 40),
        online: d.online || {}, future: !!d.future, availableFrom: d.availableFrom || null, listedAt: d.date || r.created_at, onlineAt: d.onlineAt || null, shared: !!oid,
        views: v.views, viewsWeek: v.week, requests: l.requests, viewings: l.viewings, agent: { name: a.name || r.agent_name, phone: a.phone || "", key: d.agent || r.agent_key } });
    }
    return { properties: out };
  },

  // Team performance: counts per agent only (no unit numbers, owners or prices). The admin and the Orla team see it.
  "GET team/performance": async c => {
    requireStaff(c);
    // The admin sees every unit in full (unit number, owner, all details); everyone else the summary.
    return { ...(await teamStats({ full: c.user.role === "admin" })), full: c.user.role === "admin", now: new Date().toISOString() };
  },

  // The team's top performer, for clients, external agents and the public website: name, phone and counts only.
  // Registered deals (DXB Interact / DLD exports) as averages per building and type: no deal details leave the server.
  "GET public/market": async c => {
    const { rows } = await q(`with d as (select kind, building as b, beds, coalesce(nullif(layout, ''), '') as layout, size, price, deal_date from market_deals
        where beds is not null and price > 0 and (deal_date is null or deal_date > current_date - interval '24 months')),
      g as (select kind, b, beds, layout,
        count(*) filter (where deal_date is null or deal_date > current_date - interval '12 months')::int as n12, count(*)::int as n24 from d group by 1, 2, 3, 4)
      select g.kind, g.b, g.beds, g.layout, case when g.n12 >= 3 then 12 else 24 end as months,
        count(d.*)::int as deals, round(avg(d.price))::int as avg, round(avg(d.price / nullif(d.size, 0)))::int as psf
      from g join d on d.kind = g.kind and d.b = g.b and d.beds = g.beds and d.layout = g.layout
        and (g.n12 < 3 or d.deal_date is null or d.deal_date > current_date - interval '12 months')
      group by 1, 2, 3, 4, 5`);
    c.cache = "public, max-age=600, s-maxage=600";
    return { rows };
  },

  "GET public/top": async c => {
    const { agents } = await teamStats();
    const top = [...agents].sort((a, b) => b.online - a.online || b.listings - a.listings)[0];
    c.cache = "public, max-age=120, s-maxage=120";
    return { top: top && top.listings ? { key: top.key, name: top.name, phone: top.phone, units: top.listings, online: top.online } : null };
  },

  // Ticks a platform on an offer: the agent it's listed under, or the admin.
  "POST team/online": async c => {
    requireTeam(c);
    const id = str(c.body.id, 64), platform = str(c.body.platform, 40);
    const goal = await teamGoal();
    if (platform !== "off" && !goal.platforms.some(p => p.k === platform)) fail(400, "Unknown platform.");
    const { rows: [o] } = await q("select data from offers where id = $1", [id]);
    if (!o) fail(404, "Offer not found.");
    if (c.user.role !== "admin" && (!o.data.agent || o.data.agent !== c.user.agent_key)) fail(403, "Only the agent this offer is listed under can change it.");
    const data = { ...o.data, online: { ...(o.data.online || {}), [platform]: !!c.body.on } };
    // Off market and the platforms exclude each other.
    if (c.body.on) { if (platform === "off") data.online = { off: true }; else delete data.online.off; }
    if (goal.platforms.every(p => data.online[p.k])) data.onlineAt = o.data.onlineAt || new Date().toISOString(); else delete data.onlineAt;
    await q("update offers set data = $2, updated_at = now() where id = $1", [id, data]);
    return { ok: true, online: data.online };
  },

  // A client or external agent asks to view a home or for its full details; the listing agent sees it.
  "POST data/lead": async c => {
    requireActive(c);
    const more = c.body.kind === "more", kind = c.body.kind === "details" || more ? "details" : "viewing", id = str(c.body.offerId, 64);
    await limit("lead:" + c.user.id, 40, 3600);
    const { rows: [o] } = await q("select data from offers where id = $1", [id]);
    if (!o) fail(404, "Home not found.");
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(c.body.day || "")) ? c.body.day : "", slot = str(c.body.slot, 40);
    let note = str(c.body.note, 500);
    // "The other homes like this": the agent sees what the client is after.
    if (more && !note) {
      const d = o.data, what = (+d.beds === 0 ? "studios" : d.beds + " bedroom homes") + " for " + (d.deal === "rent" ? "rent" : "sale") + " in Peninsula " + (["", "One", "Two", "Three", "Four", "Five"][+d.b] || d.b);
      note = `Asked for the other ${what}, with prices and floors (saw the starting price of AED ${askPrice(d).toLocaleString("en-US")}).`;
    }
    const phone = str(c.body.phone, 30).replace(/[^\d+ ]/g, "");
    if (phone && !c.user.phone) await q("update users set phone = $2 where id = $1 and phone = ''", [c.user.id, phone]);
    const dayTxt = day ? new Date(day + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }) : "";
    // A booking with a time always counts; a plain tap on the same home within the hour doesn't repeat.
    const { rows: [recent] } = day || c.body.note ? { rows: [] } : await q("select id from leads where user_id = $1 and offer_id = $2 and kind = $3 and at > now() - interval '1 hour'", [c.user.id, id, kind]);
    if (recent) return { ok: true };
    const { rows: [lead] } = await q("insert into leads (user_id, offer_id, agent_key, kind, title, day, slot, note, phone) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id, kind",
      [c.user.id, id, str(o.data.agent, 40), kind, str(o.data.title, 200), dayTxt || null, slot || null, note || null, phone || null]);
    const person = { name: c.user.name, email: /@mobile\.peninsula$/.test(c.user.email) ? "" : c.user.email, phone: phone || c.user.phone, role: c.user.role, company: c.user.company };
    let sent = null;
    try { sent = await notifyLead({ lead: { ...lead, day: dayTxt, slot, note }, person, offer: o.data, appUrl: appUrl(c.req) }); } catch (e) { console.error("notify", e); }
    return { ok: true, notified: sent ? sent.push + sent.emails > 0 : false };
  },

  // Notifications on this phone or computer (the Orla team).
  "GET push/key": async c => { requireStaff(c); return { key: (await vapidKeys()).publicKey }; },
  "POST push/subscribe": async c => {
    requireStaff(c);
    if (!(await subscribe(c.user.id, c.body.sub))) fail(400, "This browser couldn't turn on notifications.");
    return { ok: true };
  },
  "POST push/unsubscribe": async c => { requireStaff(c); await unsubscribe(c.user.id, c.body.endpoint); return { ok: true }; },
  "POST push/test": async c => {
    requireStaff(c);
    await limit("pushtest:" + c.user.id, 10, 3600);
    const n = await pushTo([c.user.id], { title: "Notifications are on", body: "You'll get a notification here when a client books a viewing.", url: "/app/#requests", tag: "test" });
    return { sent: n };
  },

  // Requests for the agent's own homes (the admin sees all), with the person's contact details.
  "GET team/leads": async c => {
    requireStaff(c);
    const admin = seesAll(c.user);
    const { rows } = await q(
      `select l.id, l.at, l.offer_id, l.agent_key, l.kind, l.title, l.done, l.day, l.slot, l.note, coalesce(u.name, l.name) as name, u.email, coalesce(nullif(l.phone, ''), u.phone) as phone, coalesce(u.role, 'visitor') as role, u.company
       from leads l left join users u on u.id = l.user_id
       ${admin ? "" : "where l.agent_key = $1"} order by l.done, l.at desc limit 200`, admin ? [] : [c.user.agent_key || "-"]);
    return { leads: rows };
  },

  "POST team/leads/done": async c => {
    requireTeam(c);
    await q("update leads set done = $3 where id = $1 and ($2 or agent_key = $4)", [Number(c.body.id) || 0, c.user.role === "admin", !!c.body.done, c.user.agent_key || "-"]);
    return { ok: true };
  },

  // ---------- Documents library (team and admin) ----------
  "GET team/docs": async c => {
    requireStaff(c);
    const { rows } = await q(`select d.id, d.title, d.building, d.kind, d.beds, d.mime, d.size, d.parts, d.url, d.by_user, d.by_name, d.created_at, d.read_at, d.read_rows, d.read_note,
      (select count(*)::int from doc_parts p where p.doc_id = d.id) as have from docs d order by d.created_at desc`);
    return { docs: rows.map(r => ({ ...r, ready: !!r.url || r.have === r.parts, mine: r.by_user === c.user.id })) };
  },

  "POST team/docs": async c => {
    requireTeam(c);
    const title = str(c.body.title, 160), url = str(c.body.url, 1000), kind = ["brochure", "floorplan", "pricelist", "photos", "other"].includes(c.body.kind) ? c.body.kind : "other";
    if (!title) fail(400, "Give the document a name.");
    const building = [1, 2, 3, 4, 5].includes(+c.body.building) ? +c.body.building : null, beds = [0, 1, 2, 3, 4].includes(+c.body.beds) && c.body.beds !== "" && c.body.beds != null ? +c.body.beds : null;
    let mime = null, size = 0, parts = 0;
    if (url) { if (!/^https:\/\//i.test(url)) fail(400, "Links must start with https://"); }
    else {
      mime = str(c.body.mime, 100); size = Math.floor(+c.body.size || 0); parts = Math.floor(+c.body.parts || 0);
      if (!/^(application\/pdf|image\/(jpeg|png|webp))$/.test(mime)) fail(400, "Upload a PDF, JPG, PNG or WebP file.");
      if (size <= 0 || size > 60e6 || parts < 1 || parts > 40) fail(400, "Files can be up to 60 MB.");
    }
    const { rows: [d] } = await q("insert into docs (title, building, kind, beds, mime, size, parts, url, by_user, by_name) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id",
      [title, building, kind, beds, mime, size, parts, url || null, c.user.id, c.user.name || c.user.email]);
    return { id: d.id };
  },

  "POST team/docs/part": async c => {
    requireTeam(c);
    const { rows: [d] } = await q("select by_user, parts from docs where id = $1", [String(c.body.id || "")]);
    if (!d || d.by_user !== c.user.id) fail(404, "Document not found.");
    const idx = Math.floor(+c.body.idx), buf = Buffer.from(String(c.body.data || ""), "base64");
    if (!(idx >= 0 && idx < d.parts) || !buf.length || buf.length > 2.2e6) fail(400, "Invalid part.");
    await q("insert into doc_parts (doc_id, idx, data) values ($1, $2, $3) on conflict (doc_id, idx) do update set data = excluded.data", [c.body.id, idx, buf]);
    return { ok: true };
  },

  "GET team/docs/part": async c => {
    requireStaff(c);
    const u = new URL(c.req.url, "http://localhost"), id = u.searchParams.get("id") || "", idx = Math.floor(+u.searchParams.get("idx"));
    if (!/^[0-9a-f-]{36}$/.test(id)) fail(404, "Not found.");
    const { rows: [p] } = await q("select data from doc_parts where doc_id = $1 and idx = $2", [id, idx]);
    if (!p) fail(404, "Not found.");
    c.res.statusCode = 200;
    c.res.setHeader("Content-Type", "application/octet-stream");
    c.res.setHeader("Cache-Control", "private, max-age=86400");
    c.res.end(p.data);
    return RAW;
  },

  "POST team/docs/delete": async c => {
    requireTeam(c);
    const { rowCount } = await q("delete from docs where id = $1 and (by_user = $2 or $3)", [String(c.body.id || ""), c.user.id, c.user.role === "admin"]);
    if (!rowCount) fail(404, "Document not found, or it was added by someone else.");
    return { ok: true };
  },

  // The admin: every home (offer or listing) with no unit number yet, with likely units from the Peninsula contacts
  // (same building and bedrooms, size within about 2%, the same floor when the home's floor is known).
  "GET admin/units-missing": async c => {
    requireStaff(c);
    const mine = !seesAll(c.user); // an agent gets only the homes under their own name
    const [{ rows: O }, { rows: L }, { rows: C }, { rows: st }] = await Promise.all([
      q("select id, data from offers where coalesce(data->>'unit', '') = '' and coalesce(data->>'avail', 'Available') not in ('Sold', 'Rented')"),
      q("select l.id, l.data, u.name, u.agent_key from listings l join users u on u.id = l.user_id where coalesce(l.data->>'unit', '') = ''"),
      q("select name, unit, building, data from contacts where unit <> '' and building between 1 and 5"),
      q("select data from settings where id = 'app'")]);
    const agents = (st[0] && st[0].data && st[0].data.agents) || {};
    const num = v => { const n = parseFloat(String(v ?? "").replace(/[^0-9.]/g, "")); return Number.isFinite(n) && n > 0 ? n : null; };
    const floorOf = f => { const m = String(f || "").match(/\d{1,2}/); return m && !/low|mid|high|podium/i.test(f) ? +m[0] : null; };
    const suggest = d => {
      const b = +d.b, beds = d.beds === undefined || d.beds === "" ? null : +d.beds, size = num(d.size), fl = floorOf(d.floor);
      return C.filter(x => +x.building === b).map(x => {
        const xb = x.data && x.data.beds != null ? +x.data.beds : null, xs = num(x.data && x.data.size), digits = String(x.unit).replace(/\D/g, "");
        const xf = digits.length >= 3 ? +digits.slice(0, -2) : null;
        if (beds != null && xb != null && xb !== beds) return null;
        if (size && xs && Math.abs(xs - size) / size > 0.02) return null;
        if (fl != null && xf != null && xf !== fl) return null;
        const score = (size && xs ? 2 : 0) + (fl != null && xf === fl ? 2 : 0) + (beds != null && xb === beds ? 1 : 0);
        return score ? { unit: x.unit, name: x.name, size: xs, type: (x.data && x.data.type) || "", score } : null;
      }).filter(Boolean).sort((a, z) => z.score - a.score).slice(0, 4);
    };
    const pick = d => ({ b: d.b, beds: d.beds, layout: d.layout, size: d.size, floor: d.floor, view: d.view, deal: d.deal, price: d.price, rent: d.rent, title: d.title, tower: d.tower });
    let homes = O.map(r => ({ kind: "offer", id: r.id, agentKey: r.data.agent || "", agent: (agents[r.data.agent] || {}).name || r.data.agent || "", needsAgent: !!r.data.needsAgent, src: str(r.data.src, 80), ...pick(r.data), suggestions: suggest(r.data) }))
      .concat(L.filter(r => !r.data.sharedOffer).map(r => ({ kind: "listing", id: r.id, agentKey: r.data.agent || r.agent_key || "", agent: (agents[r.data.agent || r.agent_key] || {}).name || r.name || "", ...pick(r.data), suggestions: suggest(r.data) })));
    if (mine) homes = homes.filter(h => !h.needsAgent && h.agentKey && h.agentKey === c.user.agent_key).map(h => ({ ...h, suggestions: [] }));
    return { homes, contacts: mine ? 0 : C.length, agents: Object.fromEntries(Object.entries(agents).map(([k, a]) => [k, { name: a.name, phone: a.phone || "" }])) };
  },
  "POST admin/unit-set": async c => {
    requireStaff(c);
    const kind = c.body.kind === "listing" ? "listings" : "offers", id = str(c.body.id, 64), unit = str(c.body.unit, 20).toUpperCase().replace(/[^A-Z0-9-]/g, "");
    if (!unit) fail(400, "Type the unit number.");
    if (c.user.role !== "admin") {
      // An agent fills the unit number of a home under their own name only.
      const { rows: [own] } = kind === "listings" ? await q("select 1 from listings where id = $1 and user_id = $2", [id, c.user.id])
        : await q("select 1 from offers where id = $1 and data->>'agent' = $2 and coalesce(data->>'needsAgent','') = ''", [id, c.user.agent_key || "-"]);
      if (!own) fail(403, "You can fill unit numbers only for your own homes.");
    }
    const { rows: [r] } = await q(`update ${kind} set data = jsonb_set(data, '{unit}', to_jsonb($2::text)) where id = $1 returning data->>'title' as title`, [id, unit]);
    if (!r) fail(404, "Home not found.");
    await q("insert into activity (by_user, by_email, text) values ($1, $2, $3)", [c.user.id, c.user.email, `Set unit ${unit} on ${str(r.title, 100)}`]);
    return { ok: true };
  },

  // The admin moves a home to the agent who really listed it.
  "POST admin/offer-agent": async c => {
    requireAdmin(c);
    const id = str(c.body.id, 64), agent = str(c.body.agent, 40);
    if (!/^[A-Za-z0-9_-]+$/.test(agent)) fail(400, "Choose the agent.");
    const { rows: [r] } = await q(`update offers set data = (data - 'needsAgent') || jsonb_build_object('agent', $2::text) where id = $1 returning data->>'title' as title`, [id, agent]);
    if (!r) fail(404, "Home not found.");
    await q("insert into activity (by_user, by_email, text) values ($1, $2, $3)", [c.user.id, c.user.email, `Moved ${str(r.title, 100)} to ${agent}`]);
    return { ok: true };
  },

  // The unit types in each building, from the owners list (lofts, duplexes, simplexes, 1 to 4 bedrooms).
  "GET team/unit-types": async c => {
    requireStaff(c);
    const { rows } = await q(`select building as b, (data->>'beds')::int as beds, coalesce(data->>'layout', '') as layout, count(*)::int as n
      from contacts where building between 1 and 5 and data->>'beds' ~ '^[0-4]$' group by 1, 2, 3 order by 1, 3, 2`);
    return { types: rows };
  },

  // ---------- The unit guide, read from the brochures ----------
  "GET team/guide": async c => {
    requireStaff(c);
    return { rows: await guideRows(), ai: aiEnabled() };
  },

  "POST team/guide/read": async c => {
    requireActive(c);
    if (!seesAll(c.user)) fail(403, "Only the admin and the CEO can do this.");
    if (!aiEnabled()) fail(503, "Add the AI key (ANTHROPIC_API_KEY) in Vercel first. The AI reads the brochures.", "ai_off");
    await limit("guide:" + c.user.id, 60, 3600);
    let out;
    try { out = await readBrochure(str(c.body.id, 40)); }
    catch (e) {
      if (e instanceof Anthropic.AuthenticationError) fail(503, "The AI key isn't valid. The admin needs to update ANTHROPIC_API_KEY.", "ai_key");
      if (e instanceof Anthropic.RateLimitError) fail(429, "The AI is busy. Try again in a minute.", "ai_busy");
      if (e instanceof Anthropic.APIError) { console.error("guide", e.status, e.message); fail(502, "This brochure couldn't be read" + (e.status === 400 ? " (it may be too long: split it into PDFs of under 100 pages)" : "") + ". Try again.", "ai_error"); }
      if (e instanceof SyntaxError) fail(502, "The brochure was read, but the answer was cut off. Try again.");
      throw e;
    }
    if (out.error) fail(400, out.error);
    await q("insert into activity (by_user, by_email, text) values ($1, $2, $3)", [c.user.id, c.user.email, `Brochure read: ${out.rows} units and layouts`]);
    return out;
  },

  "POST team/guide/plan": async c => {
    requireActive(c);
    if (!seesAll(c.user)) fail(403, "Only the admin and the CEO can do this.");
    const id = str(c.body.doc, 40), page = Math.floor(+c.body.page), buf = Buffer.from(String(c.body.data || ""), "base64");
    if (!/^[0-9a-f-]{36}$/.test(id) || !(page >= 1 && page <= 2000) || !buf.length || buf.length > 2.2e6) fail(400, "Invalid page.");
    const { rows: [d] } = await q("select 1 from docs where id = $1", [id]);
    if (!d) fail(404, "Document not found.");
    await q("insert into guide_plans (doc_id, page, data) values ($1, $2, $3) on conflict (doc_id, page) do update set data = excluded.data", [id, page, buf]);
    return { ok: true };
  },

  "GET team/guide/plan": async c => {
    requireStaff(c);
    const u = new URL(c.req.url, "http://localhost"), id = u.searchParams.get("doc") || "", page = Math.floor(+u.searchParams.get("page"));
    if (!/^[0-9a-f-]{36}$/.test(id)) fail(404, "Not found.");
    const { rows: [p] } = await q("select data from guide_plans where doc_id = $1 and page = $2", [id, page]);
    if (!p) fail(404, "Not found.");
    c.res.statusCode = 200;
    c.res.setHeader("Content-Type", p.data[0] === 0x89 ? "image/png" : p.data[0] === 0xff ? "image/jpeg" : "image/webp");
    c.res.setHeader("Cache-Control", "private, max-age=86400");
    c.res.end(p.data);
    return RAW;
  },

  "POST data/listings/delete": async c => {
    requireTeam(c);
    const { rows: [gone] } = await q("select data from listings where id = $1 and (user_id = $2 or $3)", [str(c.body.id, 64), c.user.id, c.user.role === "admin"]);
    if (gone && gone.data.sharedOffer) await q("delete from offers where id = $1 and data->>'fromListing' = $2", [gone.data.sharedOffer, str(c.body.id, 64)]);
    const { rowCount } = await q("delete from listings where id = $1 and (user_id = $2 or $3)", [str(c.body.id, 64), c.user.id, c.user.role === "admin"]);
    if (!rowCount) fail(404, "Listing not found.");
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

  // An agent edits a home listed under their own name. They can't move it to another agent, change whether it
  // counts in team performance, or change its Bayut / Property Finder ticks here (those have their own switch).
  "PUT team/offers": async c => {
    requireTeam(c);
    const id = str(c.body.id, 64), data = c.body.data;
    if (!data || typeof data !== "object" || Array.isArray(data) || JSON.stringify(data).length > 64000) fail(400, "Invalid offer.");
    const { rows: [prev] } = await q("select data from offers where id = $1", [id]);
    if (!prev) fail(404, "Home not found.");
    if (c.user.role !== "admin" && (!prev.data.agent || prev.data.agent !== c.user.agent_key)) fail(403, "You can edit only the homes listed under your name. Ask Talal to change this one.");
    const keep = ["agent", "teamUnit", "online", "onlineAt", "fromListing", "src", "market"];
    const next = { ...data };
    for (const k of keep) { if (prev.data[k] === undefined) delete next[k]; else next[k] = prev.data[k]; }
    await q("update offers set data = $2, updated_at = now(), updated_by = $3 where id = $1", [id, next, c.user.id]);
    await recordHistory(id, prev.data, next, c.user.email);
    await q("insert into activity (by_user, by_email, text) values ($1, $2, $3)", [c.user.id, c.user.email, `Edited their home: ${str(next.title, 120)}`]);
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
    const { rows } = await q(`select u.id, u.email, u.name as full_name, u.role, u.status, u.email_verified, u.created_at, u.company, u.phone, u.agent_key, i.name as invited_by_name
                              from users u left join users i on i.id = u.invited_by order by u.created_at`);
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

  // The admin creates an approved account and gets a password to send the person.
  "POST admin/users/create": async c => {
    requireAdmin(c);
    const name = str(c.body.name, 100), email = checkEmail(c.body.email);
    if (!name) fail(400, "Enter their full name.", "no_name");
    const role = ROLES.includes(c.body.role) ? c.body.role : "agent", key = str(c.body.agentKey, 40);
    if (key && !/^[A-Za-z0-9_-]+$/.test(key)) fail(400, "Invalid agent.");
    const ABC = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const password = c.body.password ? checkNewPassword(c.body.password)
      : Array.from(crypto.randomBytes(12), b => ABC[b % ABC.length]).join("");
    try {
      await q(`insert into users (email, name, pass_hash, role, status, email_verified, company, agent_key)
               values ($1, $2, $3, $4, 'active', true, $5, $6)`,
        [email, name, await hashPassword(password), role, str(c.body.company, 120), role === "agent" ? key : ""]);
    } catch (e) {
      if (e.code === "23505") fail(409, "An account with this email already exists. Use Reset link on their row instead.", "exists");
      throw e;
    }
    return { email, password, url: appUrl(c.req) + "/app/" };
  },

  "POST admin/users/agent": async c => {
    requireAdmin(c);
    const key = str(c.body.agentKey, 40);
    if (key && !/^[A-Za-z0-9_-]+$/.test(key)) fail(400, "Invalid agent.");
    const { rowCount } = await q("update users set agent_key = $2 where id = $1", [String(c.body.id || ""), key]);
    if (!rowCount) fail(404, "User not found.");
    return { ok: true };
  },

  // Available homes for the public website: no unit numbers, owners, agents or internal notes.
  "GET public/offers": async c => {
    const { rows } = await q("select id, data from offers order by id");
    c.cache = "public, max-age=60, s-maxage=60";
    return { offers: startingPrices(rows.filter(r => !["Sold", "Rented"].includes(r.data.avail) && !r.data.teamOnly)).map(r => ({ id: r.id, ...forPublic(r.data) })) };
  },

  // The agents' names and phones and the purchase fees, for visitors browsing without an account.
  "GET public/settings": async c => {
    const { rows: [s] } = await q("select data from settings where id = 'app'");
    const d = s?.data || {}, agents = {};
    for (const [k, a] of Object.entries(d.agents || {})) agents[k] = { name: str(a.name, 80), phone: str(a.phone, 30), ...(a.photo ? { photo: str(a.photo, 300) } : {}) };
    c.cache = "public, max-age=300, s-maxage=300";
    // GOOGLE_MAPS_EMBED_KEY (optional): a browser key for Google's Maps Embed API, which is free and shows many search results on the map.
    // It is public by design (it sits in the map's address); restrict it to this website in Google Cloud.
    return { settings: { agents, fees: d.fees || {} }, mapsKey: str(process.env.GOOGLE_MAPS_EMBED_KEY, 80) };
  },

  // A visitor without an account books a viewing or asks about a home: name and mobile go to the agent and the admin.
  "POST public/lead": async c => {
    await limit("publead:" + c.ip, 8, 3600);
    const id = str(c.body.offerId, 64), name = str(c.body.name, 100), phone = str(c.body.phone, 30).replace(/[^\d+ ]/g, "");
    if (!name) fail(400, "Enter your name.", "no_name");
    if (phone.replace(/\D/g, "").length < 7) fail(400, "Add your mobile number so the agent can confirm.", "no_phone");
    const { rows: [o] } = await q("select data from offers where id = $1", [id]);
    if (!o || o.data.teamOnly) fail(404, "Home not found.");
    const kind = c.body.kind === "viewing" ? "viewing" : "details";
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(c.body.day || "")) ? c.body.day : "", slot = str(c.body.slot, 40), note = str(c.body.note, 500);
    const dayTxt = day ? new Date(day + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }) : "";
    const { rows: [lead] } = await q("insert into leads (user_id, offer_id, agent_key, kind, title, day, slot, note, phone, name) values (null, $1, $2, $3, $4, $5, $6, $7, $8, $9) returning id, kind",
      [id, str(o.data.agent, 40), kind, str(o.data.title, 200), dayTxt || null, slot || null, note || null, phone, name]);
    try { await notifyLead({ lead: { ...lead, day: dayTxt, slot, note }, person: { name, phone, email: "", role: "client" }, offer: o.data, appUrl: appUrl(c.req) }); } catch (e) { console.error("notify", e); }
    return { ok: true };
  },

  // Photos and floor plans: the admin uploads them already resized in the browser.
  "POST admin/media": async c => {
    requireTeam(c);
    await limit("media:" + c.user.id, 200, 3600);
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
    // Due reminders go out with whatever request comes in (at most once a minute per server), so they're sent on time while the team uses the app.
    deliverDue().catch(e => console.error("reminders", e));
    // Sliding sign-in: in use, it's pushed back to a full year (at most once a day), so the app stays signed in on the phone.
    if (user && user.session_expires && new Date(user.session_expires) - Date.now() < (SESSION_DAYS - 1) * 864e5) {
      try {
        await q("update sessions set expires_at = now() + make_interval(days => $2) where token_hash = $1", [sha256(user.session_token), SESSION_DAYS]);
        setSessionCookie(req, res, user.session_token, SESSION_DAYS * 86400);
      } catch (e) { console.error("session renew", e); }
    }
    const c = { req, res, body, user, ip: clientIp(req) };
    const out = await fn(c);
    if (out !== RAW) send(res, 200, out || { ok: true }, c.cache);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, code: e.code });
    console.error(e);
    send(res, 500, { error: "Something went wrong on the server. Try again.", code: "server_error" });
  }
}
