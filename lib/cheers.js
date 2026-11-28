// Congratulations when an agent adds a unit or gets one online: a personal message on their phone
// (with their own numbers), a shout-out to the rest of the team, and the "Team wins" card on Home.
import { q } from "./db.js";
import { pushTo } from "./notify.js";

export const SCHEMA = `
create table if not exists cheers (
  id bigserial primary key,
  user_id uuid references users(id) on delete cascade,
  name text not null default '',
  agent_key text not null default '',
  kind text not null default 'added',
  what text not null default '',
  n_month int not null default 0,
  at timestamptz not null default now()
);
create index if not exists cheers_at on cheers (at desc);`;

const BLD = ["", "Peninsula One", "Peninsula Two", "Peninsula Three", "Peninsula Four", "Peninsula Five", "Business Bay"];
const TYPE = ["studio", "1 bed", "2 bed", "3 bed", "4 bed"];
const ord = n => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
const first = u => String(u.name || u.email || "").split(" ")[0];
export const homeOf = d => `${TYPE[Math.max(0, Math.min(4, parseInt(d.beds, 10) || 0))] || "home"}${d.layout === "duplex" || d.layout === "loft" ? " duplex" : ""} in ${BLD[+d.b] || "the Peninsula"}`;

// Personal messages: congratulate, then push to keep going. {n} = their count this month.
const ME = {
  added: [
    "That's your {n} listing this month. Every listing is a new chance to close: keep doing exactly this.",
    "Listing number {n} this month. The agent with the most listings gets the most calls. Keep going!",
    "{n} listing this month and counting. Owners talk to each other: call the next one today.",
    "Your {n} listing this month. Now get it online and price it like an expert. Proud of you."],
  online: [
    "It's live: clients can find it day and night. That's {n} online this month. Keep it up!",
    "Online on every platform: {n} this month. More listings, more viewings, more deals. Next one!",
    "{n} online this month. You're building your pipeline the right way. Keep doing what you're doing."]
};

export async function cheer(user, data, kind) {
  if (!user || !["agent", "admin"].includes(user.role)) return;
  const name = first(user), what = homeOf(data || {});
  // "added": their units added this month (this one included); "online": the listings they got online this month.
  const { rows: [r] } = kind === "added"
    ? await q(`select count(*)::int as n from listings where user_id = $1 and created_at >= date_trunc('month', now() + interval '4 hours') - interval '4 hours'`, [user.id])
    : await q(`select count(*)::int + 1 as n from cheers where user_id = $1 and kind = $2 and at >= date_trunc('month', now() + interval '4 hours') - interval '4 hours'`, [user.id, kind]);
  const n = Math.max(1, r.n);
  await q("insert into cheers (user_id, name, agent_key, kind, what, n_month) values ($1, $2, $3, $4, $5, $6)", [user.id, name, user.agent_key || "", kind, what, n]);
  const msgs = ME[kind] || ME.added, body = msgs[(n - 1) % msgs.length].replace("{n}", ord(n));
  try {
    await pushTo([user.id], { title: `Congratulations, ${name}!`, body: `${kind === "online" ? "Your " + what + " is online. " : "You added a " + what + ". "}${body}`, url: "/app/#wins", tag: "cheer-me-" + Date.now() });
    const { rows } = await q("select id, role from users where status = 'active' and role in ('agent','admin','ceo') and id <> $1", [user.id]);
    const team = rows.map(x => x.id);
    if (team.length) await pushTo(team, { title: `Well done, ${name}!`, body: `${name} ${kind === "online" ? "got a " + what + " online" : "just added a " + what} (${n} this month). Congratulations! Who's next?`, url: "/app/#wins", tag: "cheer-" + user.id + "-" + kind });
  } catch (e) { console.error("cheer push", e); }
}

export async function recentCheers(days = 7) {
  const { rows } = await q(`select c.name, c.agent_key, c.kind, c.what, c.n_month, c.at, c.user_id from cheers c where c.at > now() - make_interval(days => $1) order by c.at desc limit 30`, [days]);
  return rows.map(r => ({ name: r.name, agentKey: r.agent_key, kind: r.kind, what: r.what, n: r.n_month, at: r.at, userId: r.user_id }));
}
