// More of the database for the AI assistant: clients, requests, app users, tasks, visitors, registered deals,
// documents, contacts by building. Each tool returns only what the person asking may see:
// the admin and the CEO see everything; an agent sees their own clients, requests and tasks.
import { q } from "./db.js";
import { queryContacts } from "./contacts.js";

const seesAll = u => u.role === "admin" || u.role === "ceo";
const t = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const lim = (v, d, m) => Math.min(m, Math.max(1, parseInt(v, 10) || d));
const day = d => d ? new Date(d).toISOString().slice(0, 10) : null;
const BLD = { 1: "Peninsula One", 2: "Peninsula Two", 3: "Peninsula Three", 4: "Peninsula Four", 5: "Peninsula Five" };

export const MORE_TOOLS = [
  { name: "clients_list", description: "The agents' own client lists from the Clients page (buyers, investors, tenants): name, phone, what they want (intent, type, budget), stage, follow-up date, source and notes. An agent gets their own clients; the admin and the CEO get every agent's, with the agent's name. Filter by words, stage, or follow-ups due.",
    input_schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", description: "Words to match in name, phone, notes, intent" }, stage: { type: "string" }, due_only: { type: "boolean", description: "Only clients whose follow-up date is today or past" }, agent: { type: "string", description: "Agent key or first name (admin/CEO only)" }, limit: { type: "integer" } } } },
  { name: "requests_list", description: "Viewing and full-details requests that clients and external agents sent from the website, with the person's name, phone, email, the home and the listing agent. An agent gets requests for their homes; the admin and the CEO get all.",
    input_schema: { type: "object", additionalProperties: false, properties: { open_only: { type: "boolean" }, days: { type: "integer", description: "How far back, default 30" }, limit: { type: "integer" } } } },
  { name: "contacts_browse", description: "Browse the Peninsula contacts database (owners, tenants) by building, bedrooms or words, e.g. all 2-bedroom owners in Peninsula Four. Clients already listed by another agent come back as taken (only the admin and the CEO see them). Returns the total and up to 25 contacts.",
    input_schema: { type: "object", additionalProperties: false, properties: { building: { type: "integer", minimum: 1, maximum: 5 }, beds: { type: "integer", minimum: 0, maximum: 4 }, text: { type: "string" }, limit: { type: "integer" } } } },
  { name: "users_list", description: "App accounts (admin and CEO only): Orla agents, external agents and clients, with phone, email, agency, who invited them, when they joined and when they were last active. Filter by role, activity or words.",
    input_schema: { type: "object", additionalProperties: false, properties: { role: { type: "string", enum: ["agent", "broker", "client", "ceo", "admin"] }, active_within_days: { type: "integer" }, never_active: { type: "boolean" }, text: { type: "string" }, limit: { type: "integer" } } } },
  { name: "tasks_list", description: "Tasks the admin or the CEO gave agents: title, notes, due date, done or open, overdue. An agent gets their own; the admin and the CEO get all (filter by agent).",
    input_schema: { type: "object", additionalProperties: false, properties: { agent: { type: "string" }, open_only: { type: "boolean" } } } },
  { name: "visitors_summary", description: "Website visitors (admin and CEO only): visitors per day, totals, where they came from, pages, countries, devices and the most viewed homes, over the last N days. The team's own visits are left out.",
    input_schema: { type: "object", additionalProperties: false, properties: { days: { type: "integer", description: "7 to 90, default 30" } } } },
  { name: "deals_list", description: "Registered Peninsula deals imported from DXB Interact or DLD (sales or rents): date, building, tower, bedrooms, size, price and price per sq ft, newest first. Use it to quote recent deals; use compare_unit for a full comparison of one unit.",
    input_schema: { type: "object", additionalProperties: false, properties: { building: { type: "integer", minimum: 1, maximum: 5 }, beds: { type: "integer", minimum: 0, maximum: 4 }, kind: { type: "string", enum: ["sale", "rent"] }, months: { type: "integer" }, limit: { type: "integer" } } } },
  { name: "documents_list", description: "The Brochures & plans library: brochures, floor plans, price lists and payment plans per building, with links agents can open or share.",
    input_schema: { type: "object", additionalProperties: false, properties: { building: { type: "integer", minimum: 1, maximum: 5 }, kind: { type: "string" }, text: { type: "string" } } } }
];

async function agentFilter(user, agent) {
  if (!seesAll(user) || !agent) return null;
  const a = String(agent).toLowerCase();
  const { rows: [st] } = await q("select data from settings where id = 'app'");
  const agents = (st && st.data && st.data.agents) || {};
  return Object.keys(agents).find(k => k === a || String(agents[k].name || "").toLowerCase().split(" ")[0] === a.split(" ")[0]) || a;
}

export async function runMore(name, i, user, appUrl) {
  if (name === "clients_list") {
    const key = await agentFilter(user, i.agent);
    const { rows } = await q(`select s.data->'clients' as clients, u.name, u.agent_key from user_state s join users u on u.id = s.user_id
      where jsonb_array_length(coalesce(s.data->'clients', '[]'::jsonb)) > 0 ${seesAll(user) ? "" : "and s.user_id = $1"}`, seesAll(user) ? [] : [user.id]);
    const today = new Date().toISOString().slice(0, 10), w = t(i.text, 60).toLowerCase();
    let l = [];
    for (const r of rows) for (const c of r.clients || []) l.push({ name: t(c.name, 80), phone: t(c.phone, 30), intent: t(c.intent, 40), beds: c.beds === "" || c.beds == null ? null : +c.beds, budget: +c.budget || null,
      stage: t(c.status, 30), followUp: c.follow || null, source: t(c.source, 40), notes: t(c.notes, 300), shortlisted: (c.short || []).length, agent: seesAll(user) ? r.name : undefined, agentKey: r.agent_key });
    if (key) l = l.filter(c => c.agentKey === key);
    if (w) l = l.filter(c => JSON.stringify(c).toLowerCase().includes(w));
    if (i.stage) l = l.filter(c => c.stage.toLowerCase().includes(String(i.stage).toLowerCase()));
    if (i.due_only) l = l.filter(c => c.followUp && c.followUp <= today);
    l.forEach(c => delete c.agentKey);
    return { total: l.length, clients: l.slice(0, lim(i.limit, 40, 80)) };
  }
  if (name === "requests_list") {
    const all = seesAll(user), days = lim(i.days, 30, 365);
    const { rows } = await q(`select l.at, l.kind, l.done, l.offer_id, l.agent_key, o.data->>'title' as title, o.data->>'b' as b, u.name, u.phone, u.email, u.role, u.company
      from leads l left join users u on u.id = l.user_id left join offers o on o.id = l.offer_id
      where l.at > now() - ($1::int || ' days')::interval ${all ? "" : "and l.agent_key = $3"} ${i.open_only ? "and not l.done" : ""} order by l.at desc limit $2`,
      all ? [days, lim(i.limit, 40, 100)] : [days, lim(i.limit, 40, 100), user.agent_key || "-"]);
    return { requests: rows.map(r => ({ at: r.at, kind: r.kind === "viewing" ? "viewing" : "full details", done: r.done, home: [BLD[r.b], r.title].filter(Boolean).join(" · "), offerId: r.offer_id, listingAgent: all ? r.agent_key : undefined,
      from: { name: r.name, phone: r.phone, email: r.email, type: r.role === "broker" ? "external agent" + (r.company ? " (" + r.company + ")" : "") : "client" } })) };
  }
  if (name === "contacts_browse") return queryContacts(user, { building: i.building, beds: i.beds, text: i.text, limit: i.limit });
  if (name === "users_list") {
    if (!seesAll(user)) return { error: "Only the admin and the CEO can see the app accounts." };
    const w = i.text ? "%" + t(i.text, 60) + "%" : null;
    const { rows } = await q(`select u.name, u.email, u.phone, u.role, u.company, u.status, u.created_at, i.name as invited_by,
        greatest((select max(at) from visits v where v.user_id = u.id), (select max(created_at) from sessions s where s.user_id = u.id)) as last_seen
      from users u left join users i on i.id = u.invited_by where ($1::text is null or u.role = $1) and ($2::text is null or u.name ilike $2 or u.email ilike $2 or u.company ilike $2 or u.phone ilike $2)
      order by last_seen desc nulls last limit 200`, [i.role || null, w]);
    let l = rows.map(r => ({ name: r.name, type: r.role, email: r.email.endsWith("@mobile.peninsula") ? null : r.email, phone: r.phone, agency: r.company || undefined, status: r.status, invitedBy: r.invited_by, joined: day(r.created_at), lastActive: r.last_seen }));
    if (i.active_within_days) l = l.filter(u => u.lastActive && Date.now() - Date.parse(u.lastActive) < i.active_within_days * 864e5);
    if (i.never_active) l = l.filter(u => !u.lastActive);
    const counts = {}; for (const u of rows) counts[u.role] = (counts[u.role] || 0) + 1;
    return { counts, total: l.length, users: l.slice(0, lim(i.limit, 50, 150)) };
  }
  if (name === "tasks_list") {
    const key = seesAll(user) ? await agentFilter(user, i.agent) : user.agent_key || "-";
    const { rows } = await q(`select agent_key, title, notes, due, done, done_at, by_name from tasks where ($1::text is null or agent_key = $1) ${i.open_only ? "and not done" : ""} order by done, due nulls last limit 100`, [key]);
    const today = new Date().toISOString().slice(0, 10);
    return { tasks: rows.map(r => ({ agent: r.agent_key, title: r.title, notes: r.notes || undefined, due: day(r.due), done: r.done, overdue: !r.done && r.due && day(r.due) < today, from: r.by_name })) };
  }
  if (name === "visitors_summary") {
    if (!seesAll(user)) return { error: "Only the admin and the CEO can see the visitors." };
    const days = Math.min(90, Math.max(7, parseInt(i.days, 10) || 30)), W = `role not in ('admin', 'agent', 'ceo') and day > (now() at time zone 'Asia/Dubai')::date - $1::int`;
    const top = col => q(`select ${col} as k, count(distinct vid)::int as n from visits where ${W} group by 1 order by 2 desc limit 6`, [days]).then(r => r.rows);
    const [{ rows: daily }, refs, pages, countries, devices, homes] = await Promise.all([
      q(`select day, count(distinct vid)::int as visitors from visits where ${W} group by 1 order by 1`, [days]),
      top("coalesce(nullif(ref, ''), 'direct')"), top("case when path like '/app%' then '/app/' else path end"), top("nullif(country, '')"), top("device"),
      q(`select v.offer_id as k, o.data->>'title' as title, o.data->>'b' as b, count(distinct v.vid)::int as n from visits v left join offers o on o.id = v.offer_id where ${W.replace(/role|day >/g, m => "v." + m)} and v.offer_id is not null group by 1, 2, 3 order by 4 desc limit 6`, [days]).then(r => r.rows)]);
    return { days, perDay: daily.map(d => ({ day: day(d.day), visitors: d.visitors })), total: daily.reduce((s, d) => s + d.visitors, 0), sources: refs, pages, countries, devices,
      mostViewedHomes: homes.map(h => ({ home: [BLD[h.b], h.title].filter(Boolean).join(" · ") || h.k, visitors: h.n })) };
  }
  if (name === "deals_list") {
    const { rows } = await q(`select kind, deal_date, building, tower, beds, layout, size::float8 as size, price::float8 as price, floor from market_deals
      where ($1::int is null or building = $1) and ($2::int is null or beds = $2) and ($3::text is null or kind = $3) and (deal_date is null or deal_date >= current_date - ($4 || ' months')::interval)
      order by deal_date desc nulls last limit $5`, [i.building || null, i.beds ?? null, i.kind || null, String(lim(i.months, 12, 36)), lim(i.limit, 30, 100)]);
    if (!rows.length) return { deals: [], note: "No imported deals match. The admin imports DXB Interact or DLD exports in Admin, Market deals." };
    return { deals: rows.map(r => ({ kind: r.kind, date: day(r.deal_date), building: BLD[r.building], tower: r.tower || undefined, beds: r.beds, layout: r.layout || undefined, size: r.size, price: r.price, psf: r.size ? Math.round(r.price / r.size) : null, floor: r.floor || undefined })) };
  }
  if (name === "documents_list") {
    const w = i.text ? "%" + t(i.text, 60) + "%" : null;
    const { rows } = await q(`select id, title, building, kind, beds, url, size from docs where ($1::int is null or building = $1 or building is null) and ($2::text is null or kind = $2) and ($3::text is null or title ilike $3) order by building nulls last, kind, title limit 60`,
      [i.building || null, i.kind || null, w]);
    return { documents: rows.map(r => ({ title: r.title, building: BLD[r.building] || "Community", kind: r.kind, beds: r.beds, link: r.url || undefined, file: !r.url ? "uploaded file: open it in Brochures & plans" : undefined })),
      note: "Files open from Brochures & plans in the app." };
  }
  return null;
}
