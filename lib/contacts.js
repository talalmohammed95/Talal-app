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
  const m = s.match(/([1-4])\s*(?:br|bhk|bed|b\/r|bedroom)?/);
  return m ? Math.min(3, +m[1]) : null;
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
      data: Object.fromEntries([["building", t(r.building, 60)], ["type", t(r.type, 40)], ["beds", bedsNum(r.type)], ["size", t(r.size, 20)], ["floor", t(r.floor, 30)], ["view", t(r.view, 80)], ["role", t(r.role, 40)], ["nationality", t(r.nationality, 60)], ["notes", t(r.notes, 600)],
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

const shape = r => ({ ...r.data, buildingText: r.data.building || "", id: String(r.id), name: r.name, phones: r.phones, email: r.email, building: r.building, unit: r.unit });

// A phone number (7+ digits), a unit number, or part of a name (3+ letters).
export async function searchContacts(query) {
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
  return rows.map(shape);
}

export { FIELDS as CONTACT_FIELDS };
