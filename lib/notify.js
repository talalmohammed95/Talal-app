// Notifications for the team: phone notifications (Web Push) and emails, for example when a client books a viewing.
// The push keys are made once and kept in the database, so there's nothing to set up in Vercel.
import webpush from "web-push";
import { q } from "./db.js";
import { trySendMail } from "./mail.js";

let keys = null;
export async function vapidKeys() {
  if (keys) return keys;
  const { rows: [r] } = await q("select data from settings where id = 'vapid'");
  if (r && r.data && r.data.publicKey) keys = r.data;
  else {
    const k = webpush.generateVAPIDKeys();
    await q("insert into settings (id, data) values ('vapid', $1) on conflict (id) do nothing", [k]);
    const { rows: [again] } = await q("select data from settings where id = 'vapid'");
    keys = again.data;
  }
  return keys;
}

export async function subscribe(userId, sub) {
  const endpoint = String(sub && sub.endpoint || "");
  const p256dh = String(sub && sub.keys && sub.keys.p256dh || ""), auth = String(sub && sub.keys && sub.keys.auth || "");
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) return false;
  await q(`insert into push_subs (endpoint, user_id, p256dh, auth) values ($1, $2, $3, $4)
    on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = now()`, [endpoint, userId, p256dh, auth]);
  return true;
}

export async function unsubscribe(userId, endpoint) {
  await q("delete from push_subs where endpoint = $1 and user_id = $2", [String(endpoint || ""), userId]);
}

// Sends to every phone and computer these people turned notifications on for. Dead subscriptions are cleaned up.
export async function pushTo(userIds, payload) {
  if (!userIds.length) return 0;
  const k = await vapidKeys();
  const subject = process.env.APP_URL && /^https:/.test(process.env.APP_URL) ? process.env.APP_URL : "mailto:" + (process.env.ADMIN_EMAIL || "admin@example.com");
  const { rows } = await q("select endpoint, p256dh, auth from push_subs where user_id = any($1::uuid[])", [userIds]);
  let sent = 0;
  await Promise.all(rows.map(async s => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload),
        { vapidDetails: { subject, publicKey: k.publicKey, privateKey: k.privateKey }, TTL: 86400, urgency: "high" });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await q("delete from push_subs where endpoint = $1", [s.endpoint]);
      else console.error("push", e.statusCode, e.body || e.message);
    }
  }));
  return sent;
}

const BLD = { 1: "Peninsula One", 2: "Peninsula Two", 3: "Peninsula Three", 4: "Peninsula Four", 5: "Peninsula Five" };
const TYPE = ["Studio", "1 bedroom", "2 bedroom", "3 bedroom", "4 bedroom"];
const aed = v => v ? "AED " + Math.round(+v).toLocaleString("en-US") : "";

// A client or external agent booked a viewing or asked for details: tell the admin and the listing agent.
export async function notifyLead({ lead, person, offer, appUrl }) {
  const d = offer || {};
  const { rows: team } = await q(`select id, email, name, role from users where status = 'active' and (role = 'admin' or (role = 'agent' and agent_key <> '' and agent_key = $1))`, [String(d.agent || "")]);
  const agent = team.find(u => u.role === "agent");
  const who = person.name || person.email || "Someone";
  const kindTxt = lead.kind === "viewing" ? "Viewing request" : "Details request";
  const home = [d.b ? BLD[d.b] : "", d.tower && +d.b === 4 ? "Tower " + d.tower : "", d.beds != null ? TYPE[+d.beds] : ""].filter(Boolean).join(" · ");
  const price = d.deal === "rent" ? (d.rent ? aed(d.rent) + " a year" : "") : aed(d.price);
  const when = [lead.day, lead.slot].filter(Boolean).join(", ");
  const roleTxt = person.role === "broker" ? "External agent" + (person.company ? " (" + person.company + ")" : "") : "Client";
  const title = `${kindTxt}: ${who}`;
  const body = [home + (d.unit ? " · unit " + d.unit : "") + (price ? " · " + price : ""), when ? "When: " + when : "", person.phone || person.email || ""].filter(Boolean).join("\n");
  const url = "/app/#requests";
  const push = await pushTo(team.map(u => u.id), { title, body, url, tag: "lead-" + lead.id });
  const text = `${kindTxt} from the website.

${roleTxt}: ${who}
Phone: ${person.phone || "not given"}
Email: ${person.email || "not given"}

Home: ${d.title || home}
${home}${d.unit ? "\nUnit: " + d.unit : ""}${price ? "\nPrice: " + price : ""}${d.floor ? "\nFloor: " + d.floor : ""}
Listing agent: ${agent ? agent.name || agent.email : d.agent || "not set"}
${when ? "\nPreferred time: " + when : ""}${lead.note ? "\nMessage: " + lead.note : ""}

Open it: ${appUrl}${url}
Contact them soon: clients who hear back within the hour book far more viewings.`;
  const mails = await Promise.all(team.map(u => u.email && !/@mobile\.peninsula$/.test(u.email) ? trySendMail(u.email, `${title} · ${home || "Peninsula"}`, text) : false));
  return { push, emails: mails.filter(Boolean).length, to: team.map(u => u.name || u.email) };
}
