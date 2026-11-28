// Fills the owner's name and phone on every home that has a unit number but no owner details, from the
// Peninsula contacts database (matched by building and unit number). Only empty fields are filled; nothing is overwritten.
// Each run is kept as a private report for the admin (who was matched, from which contact, what's still missing).
import { q } from "./db.js";
import { unitKey } from "./contacts.js";

export const SCHEMA = `
create table if not exists owner_matches (
  id bigserial primary key,
  at timestamptz not null default now(),
  report jsonb not null default '{}'
);`;

const keysFor = (unit, tower) => {
  const k = unitKey(unit), t = String(tower || "").toLowerCase().replace(/[^a-z]/g, "");
  const out = new Set([k]);
  if (t && k && !k.startsWith(t)) out.add(t + k);
  if (/^[a-z]\d/.test(k)) out.add(k.slice(1));
  return [...out].filter(Boolean);
};

export async function matchOwners() {
  const { rows: [cn] } = await q("select count(*)::int as n from contacts where unit_key <> ''");
  if (!cn.n) return { contacts: 0, matched: [], missing: [], unsure: [] };
  const { rows: C } = await q("select id, name, phones, building, unit, unit_key, data from contacts where unit_key <> ''");
  const idx = new Map();
  for (const c of C) { const k = (c.building || 0) + ":" + c.unit_key; (idx.get(k) || idx.set(k, []).get(k)).push(c); }
  const find = (b, unit, tower) => {
    const hits = [];
    for (const k of keysFor(unit, tower)) for (const c of [...(idx.get(b + ":" + k) || []), ...(idx.get("0:" + k) || [])]) if (!hits.includes(c)) hits.push(c);
    return hits;
  };
  const [{ rows: O }, { rows: L }, { rows: st }] = await Promise.all([
    q("select id, data from offers where coalesce(data->>'avail','Available') not in ('Sold','Rented')"),
    q("select l.id, l.data, u.name as agent_name, u.agent_key from listings l join users u on u.id = l.user_id"),
    q("select data from settings where id = 'app'")]);
  const agents = (st[0] && st[0].data && st[0].data.agents) || {};
  const shared = new Map(L.filter(r => r.data.sharedOffer).map(r => [r.data.sharedOffer, r]));
  const matched = [], missing = [], unsure = [];
  const homes = O.filter(r => !shared.has(r.id) && !r.data.fromListing).map(r => ({ kind: "offers", id: r.id, d: r.data, agent: r.data.agent || "", ownerK: "owner", phoneK: "ownerPhone" }))
    .concat(L.map(r => ({ kind: "listings", id: r.id, d: r.data, agent: r.data.agent || r.agent_key || "", ownerK: "owner", phoneK: "phone" })));
  for (const h of homes) {
    const d = h.d, unit = String(d.unit || "").trim(), b = parseInt(d.b, 10) || 0;
    const needO = !String(d[h.ownerK] || "").trim(), needP = !String(d[h.phoneK] || "").trim();
    if (!needO && !needP) continue;
    const row = { id: h.id, kind: h.kind === "offers" ? "offer" : "listing", agent: (agents[h.agent] || {}).name || h.agent || "", b, beds: d.beds, size: d.size, floor: d.floor, tower: d.tower, unit, title: d.title || "" };
    if (!unit) { missing.push({ ...row, why: "No unit number yet" }); continue; }
    const hits = find(b, unit, d.tower), names = [...new Set(hits.map(c => String(c.name || "").trim().toLowerCase()).filter(Boolean))];
    if (!hits.length) { missing.push({ ...row, why: "Unit not in the contacts database" }); continue; }
    if (names.length > 1) { unsure.push({ ...row, why: "Several owners on this unit", candidates: hits.slice(0, 4).map(c => ({ name: c.name, phone: (c.phones || [])[0] || "" })) }); continue; }
    const c = hits.find(x => (x.phones || []).length) || hits[0], set = {};
    if (needO && c.name) set[h.ownerK] = c.name;
    if (needP && (c.phones || [])[0]) set[h.phoneK] = c.phones[0];
    if (!Object.keys(set).length) { missing.push({ ...row, why: "The contact has no name or phone" }); continue; }
    set.ownerFrom = "contacts";
    await q(`update ${h.kind} set data = data || $2::jsonb where id = $1`, [h.id, JSON.stringify(set)]);
    matched.push({ ...row, owner: set[h.ownerK] || d[h.ownerK] || "", phone: set[h.phoneK] || d[h.phoneK] || "", contactUnit: c.unit, nationality: (c.data && c.data.nationality) || "" });
  }
  const report = { contacts: cn.n, matched, missing, unsure };
  if (matched.length || unsure.length) await q("insert into owner_matches (report) values ($1)", [report]);
  // Only counts in the server log: names and phones stay in the database.
  console.log(`Owner match: ${matched.length} filled, ${unsure.length} to check, ${missing.length} still missing (contacts: ${cn.n})`);
  return report;
}

// The latest picture for the admin's report: everything filled from the contacts so far, plus what's still missing now.
export async function ownerReport() {
  const now = await matchOwners();
  const { rows } = await q("select report from owner_matches order by at desc limit 20");
  const seen = new Set(), matched = [];
  for (const r of rows) for (const m of r.report.matched || []) if (!seen.has(m.kind + m.id)) { seen.add(m.kind + m.id); matched.push(m); }
  return { contacts: now.contacts, matched, unsure: now.unsure, missing: now.missing };
}
