// Reminders: set by talking to the AI ("remind me tomorrow at 10 to call Valeria") or on the Home page.
// When one is due it goes to the person's phone (push) and shows in the app. Times are Dubai time (UTC+4).
import { q } from "./db.js";
import { pushTo } from "./notify.js";

const t = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const seesAll = u => u.role === "admin" || u.role === "ceo";

// "2026-11-28T10:00" (Dubai) → Date. Also accepts a full ISO time with a zone.
export function dubaiTime(s) {
  const v = String(s || "").trim();
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(v)) { const d = new Date(v); return isNaN(d) ? null : d; }
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] === undefined ? 9 : +m[4], m[5] === undefined ? 0 : +m[5]) - 4 * 3600e3);
}
export const dubaiStr = d => new Date(new Date(d).getTime() + 4 * 3600e3).toISOString().slice(0, 16).replace("T", " ");

export const SCHEMA = `
create table if not exists reminders (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  at timestamptz not null,
  text text not null,
  done boolean not null default false,
  sent_at timestamptz,
  by_user uuid references users(id) on delete set null,
  by_name text not null default '',
  via text not null default 'app',
  created_at timestamptz not null default now()
);
create index if not exists reminders_due on reminders (sent_at, at) where not done;
create index if not exists reminders_user on reminders (user_id, done, at);
alter table reminders add column if not exists link text not null default '';`;

// Whom a reminder is for: yourself, or (the admin and the CEO) an agent by key or first name.
async function targetUser(user, who) {
  const w = t(who, 60).toLowerCase();
  if (!w || /^(me|myself|self)$/.test(w) || !seesAll(user)) return user;
  const { rows } = await q("select id, name, agent_key, role from users where status = 'active' and role in ('agent','admin','ceo')");
  const hit = rows.filter(u => u.agent_key === w || String(u.name || "").toLowerCase().split(" ")[0] === w.split(" ")[0]);
  if (hit.length !== 1) throw Object.assign(new Error(`No single team member called "${who}".`), { status: 400 });
  return hit[0];
}

// A link inside the app (e.g. /app/#units) that the reminder opens: from the phone notification, the pop-up or the list.
const cleanLink = l => /^\/app\/(#[a-z0-9-]{1,40})?$/.test(String(l || "")) ? String(l) : "";
export async function addReminder(user, { when, text, who, via = "app", link = "" }) {
  const at = when === "now" ? new Date() : dubaiTime(when), what = t(text, 300);
  if (!at) throw Object.assign(new Error("Give the date and time, e.g. 2026-11-28T10:00 (Dubai time)."), { status: 400 });
  if (!what) throw Object.assign(new Error("Write what to remind about."), { status: 400 });
  if (at.getTime() < Date.now() - 5 * 60e3) throw Object.assign(new Error("That time has already passed."), { status: 400 });
  const { rows: [n] } = await q("select count(*)::int as n from reminders where user_id = $1 and not done", [user.id]);
  if (n.n >= 300) throw Object.assign(new Error("You have 300 open reminders. Clear some first."), { status: 400 });
  const to = await targetUser(user, who);
  const { rows: [r] } = await q("insert into reminders (user_id, at, text, by_user, by_name, via, link) values ($1, $2, $3, $4, $5, $6, $7) returning id, at",
    [to.id, at, what, user.id, user.name || user.email, via, cleanLink(link)]);
  return { id: +r.id, at: dubaiStr(r.at) + " Dubai time", text: what, for: to.id === user.id ? "you" : to.name };
}

export async function listReminders(user, { all = false, days = 30 } = {}) {
  const { rows } = await q(`select r.id, r.at, r.text, r.done, r.sent_at, r.by_name, r.by_user, r.link, r.via, u.name as for_name from reminders r join users u on u.id = r.user_id
    where ($1::uuid is null or r.user_id = $1) and (not r.done or r.at > now() - interval '2 days') and r.at < now() + make_interval(days => $2)
    order by r.done, r.at limit 200`, [all && seesAll(user) ? null : user.id, Math.max(1, Math.min(365, parseInt(days, 10) || 30))]);
  return rows.map(r => ({ id: +r.id, at: r.at, when: dubaiStr(r.at), text: r.text, done: r.done, due: new Date(r.at) <= new Date(), fromOther: r.by_user && r.by_user !== user.id ? r.by_name : null, link: r.link || "", via: r.via, for: all ? r.for_name : undefined }));
}

export async function setDone(user, id, done = true) {
  const { rowCount } = await q("update reminders set done = $3 where id = $1 and (user_id = $2 or by_user = $2)", [id, user.id, !!done]);
  return rowCount > 0;
}
export async function snooze(user, id, minutes) {
  const m = Math.max(5, Math.min(7 * 1440, parseInt(minutes, 10) || 60));
  const { rowCount } = await q("update reminders set at = now() + make_interval(mins => $3), sent_at = null, done = false where id = $1 and user_id = $2", [id, user.id, m]);
  return rowCount > 0;
}
export async function removeReminder(user, id) {
  const { rowCount } = await q("delete from reminders where id = $1 and (user_id = $2 or by_user = $2)", [id, user.id]);
  return rowCount > 0;
}

// Sends every due reminder once (phone notification). Safe to call from many places at once.
let lastRun = 0;
export async function deliverDue({ force = false } = {}) {
  if (!force && Date.now() - lastRun < 60e3) return 0;
  lastRun = Date.now();
  const { rows } = await q(`update reminders set sent_at = now() where id in (
      select id from reminders where not done and sent_at is null and at <= now() order by at limit 50 for update skip locked)
    returning id, user_id, text, by_name, by_user, link, via`);
  for (const r of rows) {
    try { await pushTo([r.user_id], r.via === "cheer" ? { title: r.text.split(/[!:]/)[0].slice(0, 60), body: r.text.slice(r.text.split(/[!:]/)[0].length + 1).trim() || r.text, url: r.link || "/app/#wins", tag: "cheer-" + r.id } : { title: "Reminder", body: r.text + (r.by_user && r.by_user !== r.user_id ? `\n(from ${r.by_name})` : ""), url: r.link || "/app/#reminders", tag: "rem-" + r.id }); }
    catch (e) { console.error("reminder push", e); }
  }
  return rows.length;
}

// The morning briefing for each Orla agent, the admin and the CEO: today's reminders, client follow-ups due and open requests.
export async function morningBriefing() {
  const { rows: people } = await q("select id, name, role, agent_key from users where status = 'active' and role in ('agent','admin','ceo')");
  let sent = 0;
  for (const u of people) {
    const [{ rows: [r] }, { rows: [f] }, { rows: [l] }] = await Promise.all([
      q("select count(*)::int as n, min(text) as first from reminders where user_id = $1 and not done and at < date_trunc('day', now() + interval '4 hours') - interval '4 hours' + interval '1 day'", [u.id]),
      q(`select count(*)::int as n from user_state s, jsonb_array_elements(coalesce(s.data->'clients','[]'::jsonb)) c
         where s.user_id = $1 and coalesce(c->>'follow','') <> '' and (c->>'follow') <= to_char(now() + interval '4 hours', 'YYYY-MM-DD')`, [u.id]),
      q(`select count(*)::int as n from leads where not done and ${u.role === "agent" ? "agent_key = $1" : "true"}`, u.role === "agent" ? [u.agent_key || "-"] : [])]);
    const parts = [r.n ? `${r.n} reminder${r.n === 1 ? "" : "s"} today` : "", f.n ? `${f.n} client follow-up${f.n === 1 ? "" : "s"} due` : "", l.n ? `${l.n} open request${l.n === 1 ? "" : "s"}` : ""].filter(Boolean);
    if (!parts.length) continue;
    const first = String(u.name || "").split(" ")[0], hi = u.role === "ceo" ? "Mr " + first : first;
    sent += await pushTo([u.id], { title: `Good morning${hi ? ", " + hi : ""}`, body: parts.join(" · ") + (r.n && r.first ? `\nFirst: ${r.first}` : ""), url: "/app/#reminders", tag: "brief-" + new Date().toISOString().slice(0, 10) });
  }
  return sent;
}
