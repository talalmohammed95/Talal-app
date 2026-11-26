// The CEO's weekly summary: built every Sunday morning (Vercel Cron), saved, emailed to the CEO when email is on,
// and shown on the CEO's Home with a ready WhatsApp message.
import { q } from "./db.js";
import { trySendMail, mailEnabled } from "./mail.js";

const DAY = 864e5;
const has = v => v !== undefined && v !== null && v !== "" && v !== "On request" && v !== "—";
const fmt = n => Math.round(n).toLocaleString("en-US");
// The week ends on the Sunday the summary is made (Dubai time).
export function weekKey(d = new Date()) { return new Date(d.getTime() + 4 * 3600e3).toISOString().slice(0, 10); }

// How a person is greeted: the CEO is always "Mr Munir" (Mr and the first name).
export const greet = u => { const f = String((u && u.name) || "").trim().split(" ")[0]; return u && u.role === "ceo" && f ? "Mr " + f : f; };

// Pace to the goal: how many listings each agent should have online by today, from the start to the deadline.
export function paceOf(online, g, now = Date.now()) {
  const start = Date.parse((g.start || "2026-11-20") + "T00:00:00+04:00"), end = Date.parse(g.deadline + "T23:59:59+04:00");
  const frac = Math.max(0, Math.min(1, (now - start) / Math.max(DAY, end - start))), expected = Math.floor(g.target * frac);
  const daysLeft = Math.max(0, Math.ceil((end - now) / DAY)), left = Math.max(0, g.target - online), gap = expected - online;
  const status = online >= g.target ? "done" : gap <= 0 ? "track" : gap <= Math.max(1, Math.floor(expected * 0.15)) ? "close" : "behind";
  return { status, online, expected, gap: Math.max(0, gap), left, daysLeft, perWeek: left ? Math.ceil(left / Math.max(1, daysLeft / 7)) : 0 };
}
const PACE_WORD = { behind: "Behind", close: "Close", track: "On track", done: "Goal reached" };
// Website visitors (the Orla team's own visits left out).
export async function visitorStats() {
  const { rows: [v] } = await q(`select count(distinct vid) filter (where day = (now() at time zone 'Asia/Dubai')::date - 1)::int as yesterday,
      count(distinct vid) filter (where day = (now() at time zone 'Asia/Dubai')::date - 8)::int as week_before,
      count(distinct vid) filter (where day > (now() at time zone 'Asia/Dubai')::date - 8 and day < (now() at time zone 'Asia/Dubai')::date)::int as week
    from visits where role not in ('admin', 'agent', 'ceo') and day > (now() at time zone 'Asia/Dubai')::date - 9`);
  return v;
}
export async function buildPace(teamStats) {
  const t = await teamStats(), g = t.goal;
  const agents = t.agents.filter(a => a.name).map(a => ({ key: a.key, name: a.name, ...paceOf(a.online, g) }));
  return { goal: { target: g.target, deadline: g.deadline, start: g.start }, agents, expected: agents[0] ? agents[0].expected : 0, visitors: await visitorStats() };
}
export function paceText(p, forName) {
  const by = s => p.agents.filter(a => a.status === s), line = a => `• ${a.name}: ${a.online} online, ${a.expected} expected by today${a.status === "done" ? "" : `, ${a.perWeek}/week needed`}`;
  const L = [`Peninsula · team pace, ${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}`, forName ? `Good morning ${forName},` : "", "",
    `Goal: ${p.goal.target} listings each online on Bayut and Property Finder by ${new Date(p.goal.deadline + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "long" })}. By today each agent should have ${p.expected} online.`];
  for (const s of ["behind", "close", "track", "done"]) { const l = by(s); if (l.length) L.push("", `${PACE_WORD[s]} (${l.length}):`, ...l.map(line)); }
  if (p.visitors) { const v = p.visitors; L.push("", `Website: ${v.yesterday} visitor${v.yesterday === 1 ? "" : "s"} yesterday${v.week_before !== null ? ` (${v.week_before} the same day last week)` : ""}, ${v.week} in the last 7 days.`); }
  return L.filter((x, i, A) => !(x === "" && A[i - 1] === "")).join("\n");
}
export async function runDaily(teamStats, appUrl) {
  const p = await buildPace(teamStats);
  const { rows: to } = await q("select email, name, role from users where role in ('ceo', 'admin') and status = 'active'");
  let sent = 0;
  if (mailEnabled()) for (const u of to) {
    const behind = p.agents.filter(a => a.status === "behind").length;
    if (await trySendMail(u.email, `Peninsula team pace · ${behind ? behind + " behind" : p.agents.some(a => a.status === "close") ? "none behind, some close" : "everyone on track"}`, paceText(p, greet(u)) + `\n\nOpen the app: ${appUrl}/app/`)) sent++;
  }
  return { pace: true, emailed: sent };
}

// Registration quality of one unit: share of the key details filled in.
function quality(d) {
  const f = [d.unit, d.owner, d.phone ?? d.ownerPhone, d.size, d.floor, d.view, d.deal === "rent" ? (d.rent ?? d.price) : d.price];
  return f.filter(has).length / f.length;
}

export async function buildWeekly(teamStats) {
  const now = Date.now(), from = new Date(now - 7 * DAY);
  const t = await teamStats(), g = t.goal;
  const [{ rows: L }, { rows: O }, { rows: leads }, { rows: inv }, { rows: tasks }, { rows: chat }, { rows: [prev] }] = await Promise.all([
    q("select l.data, l.created_at, u.agent_key from listings l join users u on u.id = l.user_id"),
    q("select data from offers where coalesce(data->>'agent', '') <> '' and not (data ? 'fromListing')"),
    q("select agent_key, kind, done from leads where at > $1", [from]),
    q("select i.agent_key from users u join users i on i.id = u.invited_by where u.created_at > $1", [from]),
    q("select agent_key, done, done_at, due from tasks"),
    q("select count(*)::int as n from team_chat where at > $1 and not deleted", [from]),
    q("select data from weekly_reports where week < $1 order by week desc limit 1", [weekKey()])]);
  const before = prev ? Object.fromEntries((prev.data.agents || []).map(a => [a.key, a])) : {};
  const agents = t.agents.filter(a => a.listings || a.name).map(a => {
    const mine = L.filter(r => (r.data.agent || r.agent_key) === a.key);
    const regd = mine.map(r => r.data).concat(O.filter(r => r.data.agent === a.key).map(r => r.data));
    const qual = regd.length ? Math.round(regd.reduce((s, d) => s + quality(d), 0) / regd.length * 100) : null;
    const T = tasks.filter(x => x.agent_key === a.key);
    return {
      key: a.key, name: a.name, units: a.listings, online: a.online, partly: a.partly, offMarket: a.offMarket,
      newUnits: mine.filter(r => new Date(r.created_at) > from).length,
      newOnline: (a.onlineDates || []).filter(d => new Date(d) > from).length,
      requests: leads.filter(l => l.agent_key === a.key).length,
      invited: inv.filter(i => i.agent_key === a.key).length,
      quality: qual,
      tasksDone: T.filter(x => x.done && x.done_at && new Date(x.done_at) > from).length,
      tasksOpen: T.filter(x => !x.done).length,
      tasksLate: T.filter(x => !x.done && x.due && new Date(x.due).getTime() + DAY < now).length,
      onlineChange: before[a.key] ? a.online - before[a.key].online : null
    };
  }).sort((x, y) => y.online - x.online || y.units - x.units);
  const sum = k => agents.reduce((s, a) => s + (a[k] || 0), 0);
  const top = agents.find(a => a.units) || null;
  const star = [...agents].sort((x, y) => (y.newOnline * 2 + y.newUnits) - (x.newOnline * 2 + x.newUnits))[0];
  const days = Math.max(0, Math.ceil((Date.parse(g.deadline + "T23:59:59") - now) / DAY));
  const needed = g.target * agents.length - sum("online");
  return {
    week: weekKey(), from: from.toISOString(), to: new Date(now).toISOString(), goal: { target: g.target, deadline: g.deadline, platforms: g.platforms.map(p => p.n), daysLeft: days },
    team: { units: sum("units"), online: sum("online"), partly: sum("partly"), offMarket: sum("offMarket"), newUnits: sum("newUnits"), newOnline: sum("newOnline"),
      requests: leads.length, viewings: leads.filter(l => l.kind === "viewing").length, openRequests: leads.filter(l => !l.done).length, invited: inv.length, chat: chat[0].n,
      tasksDone: sum("tasksDone"), tasksOpen: sum("tasksOpen"), tasksLate: sum("tasksLate"), goalTotal: g.target * agents.length,
      perWeekNeeded: days ? Math.ceil(needed / Math.max(1, days / 7)) : needed },
    top: top && { name: top.name, units: top.units, online: top.online },
    starOfWeek: star && (star.newOnline || star.newUnits) ? { name: star.name, newOnline: star.newOnline, newUnits: star.newUnits } : null,
    agents: agents.map(a => ({ ...a, pace: paceOf(a.online, g).status })), expected: paceOf(0, g).expected, visitors: await visitorStats()
  };
}

export function weeklyText(r, forName) {
  const T = r.team, d = s => new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const L = [`Peninsula · weekly summary, ${d(r.from)} to ${d(r.to)}`, forName ? `Good morning ${forName},` : "", "",
    `Team: ${T.units} units, ${T.online} of ${T.goalTotal} online on ${r.goal.platforms.join(" and ")} (goal: ${r.goal.target} each by ${new Date(r.goal.deadline + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "long" })}, ${r.goal.daysLeft} days left).`,
    `This week: ${T.newUnits} new unit${T.newUnits === 1 ? "" : "s"}, ${T.newOnline} went online, ${T.requests} client request${T.requests === 1 ? "" : "s"} (${T.viewings} viewing${T.viewings === 1 ? "" : "s"}), ${T.invited} client${T.invited === 1 ? "" : "s"} invited.`,
    `Tasks: ${T.tasksDone} done, ${T.tasksOpen} open${T.tasksLate ? `, ${T.tasksLate} overdue` : ""}.`,
    r.visitors ? `Website: ${r.visitors.week} visitors in the last 7 days.` : "",
    T.perWeekNeeded > 0 ? `To reach the goal the team needs about ${T.perWeekNeeded} listings online per week.` : "The team goal is reached.", ""];
  if (r.top) L.push(`★ Top achiever: ${r.top.name} (${r.top.units} units, ${r.top.online} online).`);
  if (r.starOfWeek) L.push(`Most progress this week: ${r.starOfWeek.name} (${r.starOfWeek.newOnline} online, ${r.starOfWeek.newUnits} new).`);
  if (r.agents.some(a => a.pace)) { const P = { behind: "Behind", close: "Close", track: "On track", done: "Goal reached" };
    L.push("", `Pace (${r.expected ?? 0} online expected by now): ` + ["behind", "close", "track", "done"].map(k => [k, r.agents.filter(a => a.pace === k).map(a => a.name.split(" ")[0])]).filter(x => x[1].length).map(([k, n]) => `${P[k]}: ${n.join(", ")}`).join(" · ") + "."); }
  L.push("", "Per agent (units · online · new this week · requests · registration · tasks):");
  for (const a of r.agents) L.push(`• ${a.name}: ${a.units} · ${a.online}/${r.goal.target}${a.onlineChange ? ` (${a.onlineChange > 0 ? "+" : ""}${a.onlineChange})` : ""} · ${a.newUnits} new · ${a.requests} req · ${a.quality == null ? "—" : a.quality + "%"} · ${a.tasksDone} done${a.tasksOpen ? `, ${a.tasksOpen} open` : ""}${a.tasksLate ? ` (${a.tasksLate} late)` : ""}`);
  return L.filter((x, i, A) => !(x === "" && A[i - 1] === "")).join("\n");
}

// Builds this week's summary once, saves it, and emails the CEO (and the admin) when email is on.
export async function runWeekly(teamStats, appUrl, { force } = {}) {
  const week = weekKey();
  const { rows: [done] } = await q("select week from weekly_reports where week = $1", [week]);
  if (done && !force) return { week, already: true };
  const r = await buildWeekly(teamStats);
  await q(`insert into weekly_reports (week, data) values ($1, $2) on conflict (week) do update set data = excluded.data, created_at = now()`, [week, r]);
  const { rows: to } = await q("select email, name, role from users where role in ('ceo', 'admin') and status = 'active'");
  let sent = 0;
  if (mailEnabled()) for (const u of to) if (await trySendMail(u.email, `Peninsula weekly summary · ${r.team.online} of ${r.team.goalTotal} online`, weeklyText(r, greet(u)) + `\n\nOpen the app: ${appUrl}/app/`)) sent++;
  return { week, saved: true, emailed: sent };
}
