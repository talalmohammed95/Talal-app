// The Peninsula contacts database: the admin imports it from Excel or CSV; the Orla team looks people up
// by phone number, unit number or name. Every lookup is written to the activity log.
import { q } from "./db.js";

const t = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
export const unitKey = u => String(u ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^0+(?=\d)/, "");
// The last 9 digits identify a UAE number whichever way it was typed (050…, +971 50…, 97150…).
export const phoneKey = p => { const d = String(p ?? "").replace(/\D/g, ""); return d.length >= 7 ? d.slice(-9) : ""; };
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5 };
export function buildingNum(v) {
  const s = String(v ?? "").toLowerCase();
  if (!s) return null;
  if (/plaza/.test(s)) return 4;
  if (/signature/.test(s)) return 5;
  const w = s.match(/\b(one|two|three|four|five)\b/); if (w) return WORDS[w[1]];
  const m = s.match(/(?:peninsula|p|tower|bldg|building)\s*[-#]?\s*([1-5])\b/) || s.match(/^\s*([1-5])\s*$/);
  return m ? +m[1] : null;
}
export function bedsNum(v) {
  const s = String(v ?? "").toLowerCase();
  if (/studio|^\s*0\s*$/.test(s)) return 0;
  const w = s.match(/\b(one|two|three|four)\b[\s-]*(?:br|bhk|bed)/); if (w) return { one: 1, two: 2, three: 3, four: 4 }[w[1]];
  const m = s.match(/([1-5])\s*(?:br|bhk|bed|b\/r|bedroom)/) || s.match(/(?:^|\D)([1-5])(?:\D|$)/);
  return m ? Math.min(4, +m[1]) : null;
}
// Loft, duplex, simplex or semi-penthouse, from the owners list's unit type ("3 BR Duplex Loft", "Duplex 2BR"…).
export function layoutOf(v) {
  const s = String(v ?? "").toLowerCase();
  if (/loft/.test(s)) return "loft";
  if (/semi[\s-]*pent/.test(s)) return "semipenthouse";
  if (/duplex/.test(s)) return "duplex";
  if (/simplex|town\s*house|podium villa/.test(s)) return "simplex";
  return "";
}

const FIELDS = ["name", "phone", "phone2", "phone3", "email", "building", "unit", "type", "size", "floor", "view", "role", "nationality", "notes"];

export async function importContacts(rows, replace) {
  if (replace) await q("delete from contacts");
  const recs = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const phones = [r.phone, r.phone2, r.phone3].map(p => t(p, 40)).filter(Boolean);
    const rec = {
      name: t(r.name, 160), phones, phone_keys: [...new Set(phones.map(phoneKey).filter(Boolean))], email: t(r.email, 200).toLowerCase(),
      building: buildingNum(r.building) ?? buildingNum(r.unit), unit: t(r.unit, 30), unit_key: unitKey(r.unit),
      data: Object.fromEntries([["building", t(r.building, 60)], ["type", t(r.type, 40)], ["beds", bedsNum(r.type)], ["layout", layoutOf(r.type)], ["size", t(r.size, 20)], ["floor", t(r.floor, 30)], ["view", t(r.view, 80)], ["role", t(r.role, 40)], ["nationality", t(r.nationality, 60)], ["notes", t(r.notes, 600)],
        ["extra", r.extra && typeof r.extra === "object" ? Object.fromEntries(Object.entries(r.extra).slice(0, 20).map(([k, v]) => [t(k, 40), t(v, 200)]).filter(([k, v]) => k && v)) : {}]].filter(([, v]) => v !== "" && v !== null))
    };
    if (rec.name || rec.phones.length || rec.unit) recs.push(rec);
  }
  if (recs.length) await q(
    `insert into contacts (name, phones, phone_keys, email, building, unit, unit_key, data)
     select x.name, array(select jsonb_array_elements_text(x.phones)), array(select jsonb_array_elements_text(x.phone_keys)), x.email, x.building, x.unit, x.unit_key, x.data
     from jsonb_to_recordset($1::jsonb) as x(name text, phones jsonb, phone_keys jsonb, email text, building int, unit text, unit_key text, data jsonb)`, [JSON.stringify(recs)]);
  return recs.length;
}

export async function contactStats() {
  const { rows: [r] } = await q("select count(*)::int as n, max(imported_at) as at, count(distinct unit_key) filter (where unit_key <> '')::int as units from contacts");
  return { count: r.n, units: r.units, importedAt: r.at };
}

// ---------- first listing wins ----------
// When an agent saves a listing on the website with the unit number or the client's phone, that client is theirs:
// other agents searching the contacts see only who has it. The earliest listing wins; the admin sees everything.
// Claims are worked out from the listings at search time, so deleting a listing frees the client again.
async function claims() {
  const [{ rows: L }, { rows: O }, { rows: U }] = await Promise.all([
    q(`select l.user_id, l.created_at as at, l.data->>'unit' as unit, l.data->>'b' as b, l.data->>'phone' as phone, u.name, u.agent_key
       from listings l join users u on u.id = l.user_id
       where coalesce(l.data->>'unit', '') <> '' or coalesce(l.data->>'phone', '') <> ''`),
    q(`select updated_at as at, data->>'unit' as unit, data->>'b' as b, data->>'ownerPhone' as phone, data->>'agent' as agent from offers
       where coalesce(data->>'agent', '') <> '' and (coalesce(data->>'unit', '') <> '' or coalesce(data->>'ownerPhone', '') <> '')`),
    q("select id, name, agent_key from users where agent_key is not null and agent_key <> '' and role in ('agent', 'admin')")]);
  const byKey = Object.fromEntries(U.map(u => [u.agent_key, u]));
  const list = L.map(r => ({ userId: r.user_id, name: r.name, agentKey: r.agent_key, at: r.at, unitKey: unitKey(r.unit), b: parseInt(r.b, 10) || null, phoneKey: phoneKey(r.phone) }))
    .concat(O.map(r => ({ userId: byKey[r.agent] ? byKey[r.agent].id : null, name: byKey[r.agent] ? byKey[r.agent].name : r.agent, agentKey: r.agent, at: r.at, unitKey: unitKey(r.unit), b: parseInt(r.b, 10) || null, phoneKey: phoneKey(r.phone) })));
  return list.sort((x, y) => new Date(x.at) - new Date(y.at));
}
const claimOf = (list, r) => list.find(c => (c.unitKey && c.unitKey === r.unit_key && (!c.b || !r.building || c.b === r.building)) || (c.phoneKey && r.phone_keys.includes(c.phoneKey)));
const mineClaim = (c, user) => c.userId ? c.userId === user.id : !!(user.agent_key && c.agentKey === user.agent_key);
export async function claimWarning(user, data) {
  const r = { unit_key: unitKey(data.unit), building: parseInt(data.b, 10) || null, phone_keys: [phoneKey(data.phone)].filter(Boolean) };
  if (!r.unit_key && !r.phone_keys.length) return null;
  const list = await claims();
  // The client may be known by the unit or by the phone: check the listing itself and every contact it matches.
  const { rows } = await q(`select unit_key, building, phone_keys from contacts
    where ($1 <> '' and unit_key = $1 and ($2::int is null or building is null or building = $2)) or phone_keys && $3::text[] limit 50`, [r.unit_key, r.building, r.phone_keys]);
  const c = [r, ...rows].map(x => claimOf(list, x)).filter(Boolean).sort((x, y) => new Date(x.at) - new Date(y.at))[0];
  if (!c || mineClaim(c, user)) return null;
  return `This client is already listed by ${String(c.name || "another agent").split(" ")[0]} (since ${new Date(c.at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}). The first listing keeps the client.`;
}

const shape = r => ({ ...r.data, buildingText: r.data.building || "", id: String(r.id), name: r.name, phones: r.phones, email: r.email, building: r.building, unit: r.unit });

// A phone number (7+ digits), a unit number, or part of a name (3+ letters).
export async function searchContacts(query, user) {
  const raw = t(query, 80), digits = raw.replace(/\D/g, ""), key = phoneKey(raw), uk = unitKey(raw.replace(/^(?:unit|apt|apartment|flat)\s*/i, ""));
  let rows = [];
  if (key && digits.length >= 7) ({ rows } = await q("select * from contacts where phone_keys @> array[$1]::text[] order by id limit 20", [key]));
  if (!rows.length && uk && uk.length >= 2 && /\d/.test(uk)) {
    const b = buildingNum(raw), plain = uk.replace(/^p[1-5]/, "");
    ({ rows } = await q("select * from contacts where (unit_key = $1 or unit_key = $2) and ($3::int is null or building is null or building = $3) order by building nulls last, id limit 20", [uk, plain, b]));
  }
  if (!rows.length && /[a-z]{3,}/i.test(raw) && !/^\d/.test(raw)) {
    const like = "%" + raw.replace(/[%_\\]/g, "\\$&") + "%";
    ({ rows } = await q("select * from contacts where name ilike $1 or email ilike $1 order by id limit 20", [like]));
  }
  return redact(rows, user);
}

// Browse the contacts by building, type or words (for the AI assistant). The same rule: a client listed by another agent is hidden.
export async function queryContacts(user, { building, beds, layout, text, limit } = {}) {
  const lay = ["loft", "duplex", "simplex", "semipenthouse", "apartment"].includes(layout) ? layout : null;
  const like = text ? "%" + String(text).slice(0, 60).replace(/[%_\\]/g, "\\$&") + "%" : null;
  const { rows } = await q(`select * from contacts where ($1::int is null or building = $1) and ($2::int is null or (data->>'beds')::int = $2)
      and ($3::text is null or name ilike $3 or email ilike $3 or unit ilike $3 or data::text ilike $3)
      and ($5::text is null or coalesce(nullif(data->>'layout', ''), 'apartment') = $5) order by building nulls last, unit_key limit $4`,
    [building || null, beds ?? null, like, Math.min(25, Math.max(1, parseInt(limit, 10) || 15)), lay]);
  const { rows: [{ n }] } = await q(`select count(*)::int as n from contacts where ($1::int is null or building = $1) and ($2::int is null or (data->>'beds')::int = $2)
      and ($3::text is null or name ilike $3 or email ilike $3 or unit ilike $3 or data::text ilike $3)
      and ($4::text is null or coalesce(nullif(data->>'layout', ''), 'apartment') = $4)`, [building || null, beds ?? null, like, lay]);
  return { total: n, contacts: await redact(rows, user) };
}

async function redact(rows, user) {
  if (!rows.length) return [];
  const list = await claims(), admin = user && (user.role === "admin" || user.role === "ceo");
  return rows.map(r => {
    const c = claimOf(list, r), by = c ? String(c.name || "another agent") : "";
    if (!c) return shape(r);
    if (admin) return { ...shape(r), claimedBy: by };
    if (user && mineClaim(c, user)) return { ...shape(r), yours: true };
    // Another agent listed this client first: only who has it, nothing to contact them with.
    return { id: String(r.id), taken: true, by: by.split(" ")[0], since: c.at };
  });
}

export { FIELDS as CONTACT_FIELDS };
