// Registered Peninsula deals (sales and rents) for comparisons. The admin imports them from a DXB Interact
// (or DLD) export; only Peninsula One to Five rows are kept. The AI assistant and the unit page compare a unit with them.
import { q } from "./db.js";
import { buildingNum, bedsNum } from "./contacts.js";

const t = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const num = v => { const n = Number(String(v ?? "").replace(/[^0-9.]/g, "")); return Number.isFinite(n) && n > 0 ? n : null; };
export const layoutOf = s => { s = String(s || "").toLowerCase(); return /loft/.test(s) ? "loft" : /penthouse/.test(s) ? "semipenthouse" : /duplex/.test(s) ? "duplex" : /simplex|town ?house/.test(s) ? "simplex" : ""; };
// Dates come as 2026-11-13, 13/11/2026, 13-Nov-2026 or an Excel date.
function dateOf(v) {
  const s = String(v ?? "").trim(); if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/); if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const d = new Date(s); return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

export async function importDeals(rows, { replace, kind: fileKind, sqm, source }) {
  if (replace) await q("delete from market_deals");
  const recs = []; let skipped = 0;
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const all = Object.values(r).join(" ");
    // Only the Peninsula: the building column, or anywhere in the row.
    const where = [r.building, r.project, all].map(x => String(x || "")).find(x => /peninsula/i.test(x)) || "";
    const b = buildingNum(where.match(/peninsula[^,;|/]*/i)?.[0] || "");
    const price = num(r.price);
    if (!b || !price) { skipped++; continue; }
    const k = /rent|lease/i.test(r.kind || "") ? "rent" : /sale|sold|sell/i.test(r.kind || "") ? "sale" : fileKind === "rent" ? "rent" : "sale";
    let size = num(r.size); if (size && sqm) size = Math.round(size * 10.7639);
    const tw = (String(r.building || "") + " " + String(r.project || "") + " " + String(r.unit || "")).match(/tower\s*([ab])\b/i);
    recs.push({ kind: k, deal_date: dateOf(r.date), building: b, tower: b === 4 && tw ? tw[1].toUpperCase() : "", beds: bedsNum(r.type), layout: layoutOf(r.type + " " + (r.unit || "")), size, price, floor: t(r.floor, 20), source: t(source, 60) });
  }
  if (recs.length) await q(
    `insert into market_deals (kind, deal_date, building, tower, beds, layout, size, price, floor, source)
     select kind, deal_date, building, tower, beds, layout, size, price, floor, source
     from jsonb_to_recordset($1::jsonb) as x(kind text, deal_date date, building int, tower text, beds int, layout text, size numeric, price numeric, floor text, source text)`, [JSON.stringify(recs)]);
  return { imported: recs.length, skipped };
}

export async function dealStats() {
  const { rows: [r] } = await q(`select count(*)::int as n, count(*) filter (where kind = 'sale')::int as sales, count(*) filter (where kind = 'rent')::int as rents,
    min(deal_date) as first, max(deal_date) as last, max(imported_at) as at from market_deals`);
  return { count: r.n, sales: r.sales, rents: r.rents, first: r.first, last: r.last, importedAt: r.at };
}

const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
// Compares a unit with registered deals of the same type in the same building: the last 12 months
// (24 if there are fewer than 3), similar sizes first.
export async function compareUnit({ b, tower, beds, layout, size, price, deal }) {
  b = +b; const kind = deal === "rent" ? "rent" : "sale";
  if (!b) return { error: "Which building?" };
  const { rows: [{ n }] } = await q("select count(*)::int as n from market_deals");
  if (!n) return { noData: true, note: "No DXB Interact deals imported yet. The admin can import them in Admin, Market deals." };
  const pick = async months => (await q(
    `select kind, deal_date, building, tower, beds, layout, size::float8 as size, price::float8 as price, floor from market_deals
     where building = $1 and kind = $2 and ($3::int is null or beds = $3) and layout = $4 and (deal_date is null or deal_date >= current_date - ($5 || ' months')::interval)
     order by deal_date desc nulls last limit 400`, [b, kind, beds ?? null, layout || "", String(months)])).rows;
  let months = 12, l = await pick(12);
  if (l.length < 3) { months = 24; l = await pick(24); }
  const sz = num(size);
  const similar = sz ? l.filter(d => d.size && Math.abs(d.size - sz) / sz <= 0.25) : [];
  const set = similar.length >= 3 ? similar : l, psf = set.filter(d => d.size).map(d => d.price / d.size);
  const sameTower = b === 4 && tower ? set.filter(d => d.tower === tower) : [];
  const p = num(price), unitPsf = p && sz ? p / sz : null, aPsf = avg(psf), aPrice = avg(set.map(d => d.price));
  return {
    building: b, tower: tower || null, beds: beds ?? null, layout: layout || "", kind, months, deals: set.length, similarSize: set === similar,
    avgPrice: aPrice && Math.round(aPrice), medianPrice: set.length ? Math.round(med(set.map(d => d.price))) : null,
    minPrice: set.length ? Math.min(...set.map(d => d.price)) : null, maxPrice: set.length ? Math.max(...set.map(d => d.price)) : null,
    avgPsf: aPsf && Math.round(aPsf), minPsf: psf.length ? Math.round(Math.min(...psf)) : null, maxPsf: psf.length ? Math.round(Math.max(...psf)) : null,
    sameTowerDeals: sameTower.length || undefined,
    unit: { size: sz, price: p, psf: unitPsf && Math.round(unitPsf) },
    vsAverage: kind === "sale" && unitPsf && aPsf ? Math.round((unitPsf / aPsf - 1) * 1000) / 10 : kind === "rent" && p && aPrice ? Math.round((p / aPrice - 1) * 1000) / 10 : null,
    recent: set.slice(0, 8).map(d => ({ date: d.deal_date ? new Date(d.deal_date).toISOString().slice(0, 10) : null, size: d.size, price: d.price, psf: d.size ? Math.round(d.price / d.size) : null, floor: d.floor || undefined, tower: d.tower || undefined })),
    source: "DXB Interact (DLD registered deals), imported by the admin"
  };
}
