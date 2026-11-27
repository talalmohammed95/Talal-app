// The unit guide: what the developer brochures say about each unit (type, size, view, floor plan page),
// read by Claude from the brochures in the team's documents library. Dubai unit numbers are the floor
// followed by a two-digit stack: 1203 is floor 12, stack 03. So floor comes from the unit number, and the
// rest comes from the stack in the brochure's key plans.
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { q } from "./db.js";
import { BROCHURE_UNITS } from "./brochure-units.js";

const MODEL = "claude-opus-5-5";
const BLD = { 1: "Peninsula One", 2: "Peninsula Two", 3: "Peninsula Three", 4: "Peninsula Four", 5: "Peninsula Five" };

export function splitUnit(u) {
  const d = String(u || "").replace(/\D/g, "");
  if (d.length < 3 || d.length > 5) return null;
  const floor = +d.slice(0, -2), stack = d.slice(-2);
  return floor >= 0 && floor <= 99 ? { digits: d, floor, stack } : null;
}

const nInt = { type: ["integer", "null"] }, nNum = { type: ["number", "null"] };
const SCHEMA = {
  type: "object", additionalProperties: false, required: ["building", "rows", "notes"],
  properties: {
    building: { type: ["integer", "null"], description: "1 to 5 if the brochure is about one Peninsula building" },
    notes: { type: "string", description: "One or two short sentences on what the brochure covers and anything you couldn't read." },
    rows: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["building", "tower", "units", "stack", "floor_from", "floor_to", "type", "beds", "layout", "size_sqft", "balcony_sqft", "view", "plan_page"],
        properties: {
          building: { type: "integer", enum: [1, 2, 3, 4, 5] },
          tower: { type: "string", enum: ["", "A", "B"] },
          units: { type: "array", items: { type: "string" }, description: "Unit numbers printed for this layout, if the brochure lists them (e.g. 1203, 1303). Empty if it gives stacks or floor ranges instead." },
          stack: { type: "string", description: "Two-digit stack (the last two digits of the unit number, e.g. \"03\"), or \"\" if not shown." },
          floor_from: nInt, floor_to: nInt,
          type: { type: "string", description: "The brochure's name for the layout, e.g. \"1 Bedroom Type D\"" },
          beds: { type: "integer", description: "0 for a studio" },
          layout: { type: "string", enum: ["apartment", "simplex", "duplex", "duplex loft", "semi-penthouse", "penthouse"] },
          size_sqft: nNum, balcony_sqft: nNum,
          view: { type: "string", description: "Short view, e.g. \"Burj Khalifa & canal\", \"Dubai Canal\", \"Business Bay skyline\". \"\" if the brochure gives no way to tell." },
          plan_page: { type: ["integer", "null"], description: "PDF page number (1 = first page) of this layout's floor plan" }
        }
      }
    }
  }
};

const PROMPT = `This is a Select Group brochure or floor plan book for The Peninsula, Business Bay, Dubai (Peninsula One to Five). Read every page and give one row per layout and stack (or per unit where unit numbers are printed).

How units work: a unit number is the floor followed by a two-digit stack, so 1203 is floor 12, stack 03, and 3407 is floor 34, stack 07. Key plans (typical floor plates) show where each stack sits. Use them, the compass and the site plan to give each stack its view: which side faces the Burj Khalifa and Downtown, the Dubai Canal, the Business Bay skyline, the community park or the inner Peninsula. Keep views short. If a layout repeats on a range of floors, give floor_from and floor_to.

Only Peninsula Four has Tower A and Tower B; for the other buildings tower is "". Sizes in sq ft (convert from m² if needed: 1 m² = 10.764 sq ft). plan_page is the PDF page number of that layout's floor plan. Don't invent anything: leave a field empty or null when the brochure doesn't show it.`;

async function docBuffer(id) {
  const { rows } = await q("select data from doc_parts where doc_id = $1 order by idx", [id]);
  return Buffer.concat(rows.map(r => r.data));
}

export async function readBrochure(id) {
  const { rows: [d] } = await q("select id, title, building, mime, parts, url, (select count(*)::int from doc_parts p where p.doc_id = docs.id) as have from docs where id = $1", [id]);
  if (!d) return { error: "Document not found." };
  if (d.mime !== "application/pdf" || d.url) return { error: "Only uploaded PDF files can be read." };
  if (d.have !== d.parts) return { error: "This file didn't finish uploading. Upload it again." };
  const client = new Anthropic();
  const buf = await docBuffer(id);
  const file = await client.files.upload({ file: await toFile(buf, (d.title || "brochure").replace(/[^\w .-]/g, "") + ".pdf", { type: "application/pdf" }), expires_in_seconds: 3600 });
  let out;
  try {
    const msg = await client.beta.messages.stream({
      model: MODEL, max_tokens: 64000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content: [
        { type: "document", source: { type: "file", file_id: file.id }, title: d.title },
        { type: "text", text: PROMPT + (d.building ? `\n\nThe team filed this under ${BLD[d.building]}.` : "") }] }]
    }).finalMessage();
    if (msg.stop_reason === "max_tokens") return { error: "The brochure is too long to read in one go. Split it into smaller PDFs." };
    if (msg.stop_reason === "refusal") return { error: "This file couldn't be read." };
    const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
    out = JSON.parse(text);
  } finally { client.files.delete(file.id).catch(() => {}); }
  return saveRows(d, out);
}

// Stores what was read, replacing what this document gave before.
export async function saveRows(d, out) {
  const rows = Array.isArray(out && out.rows) ? out.rows : [];
  const ins = [];
  const clean = (v, n) => String(v ?? "").trim().slice(0, n);
  const int = v => Number.isFinite(+v) && v !== null && v !== "" ? Math.round(+v) : null;
  for (const r of rows) {
    const b = [1, 2, 3, 4, 5].includes(+r.building) ? +r.building : (d.building || null);
    if (!b) continue;
    const base = { b, tower: b === 4 && ["A", "B"].includes(r.tower) ? r.tower : "", type: clean(r.type, 80), beds: int(r.beds), layout: clean(r.layout, 30),
      size: int(r.size_sqft), balcony: int(r.balcony_sqft), view: clean(r.view, 80), page: int(r.plan_page), from: int(r.floor_from), to: int(r.floor_to) };
    const units = (Array.isArray(r.units) ? r.units : []).map(splitUnit).filter(Boolean);
    if (units.length) for (const u of units.slice(0, 400)) ins.push({ ...base, unit: u.digits, stack: u.stack, from: u.floor, to: u.floor });
    else { const s = String(r.stack || "").replace(/\D/g, "").slice(-2).padStart(2, "0"); ins.push({ ...base, unit: "", stack: /\d/.test(String(r.stack || "")) ? s : "" }); }
  }
  await q("delete from unit_guide where doc_id = $1", [d.id]);
  for (let i = 0; i < ins.length; i += 200) {
    const part = ins.slice(i, i + 200), vals = [], args = [];
    part.forEach((r, j) => { const k = j * 14; vals.push(`(${Array.from({ length: 14 }, (_, x) => "$" + (k + x + 1)).join(",")})`);
      args.push(r.b, r.tower, r.unit, r.stack, r.from, r.to, r.type, r.beds, r.layout, r.size, r.balcony, r.view, d.id, r.page); });
    await q(`insert into unit_guide (building, tower, unit, stack, floor_from, floor_to, type, beds, layout, size, balcony, view, doc_id, page) values ${vals.join(",")}`, args);
  }
  const note = clean(out && out.notes, 400);
  await q("update docs set read_at = now(), read_rows = $2, read_note = $3 where id = $1", [d.id, ins.length, note]);
  const pages = [...new Set(ins.map(r => r.page).filter(p => p > 0))].sort((a, b) => a - b);
  return { rows: ins.length, pages, note };
}

export async function guideRows() {
  const { rows } = await q(`select g.building as b, g.tower, g.unit, g.stack, g.floor_from as "from", g.floor_to as "to", g.type, g.beds, g.layout, g.size, g.balcony, g.view,
    g.doc_id as doc, g.page, (p.doc_id is not null) as img from unit_guide g left join guide_plans p on p.doc_id = g.doc_id and p.page = g.page order by g.building, g.tower, g.stack, g.floor_from nulls last`);
  // The brochures built into the app (Peninsula One, Two and Four) come first; brochures read later add to them.
  return BROCHURE_UNITS.concat(rows);
}

// Best brochure match for a unit: its own number first, then its stack on that floor, then the stack anywhere.
export function matchGuide(rows, b, tower, unit) {
  const u = splitUnit(unit);
  if (!u) return null;
  const inB = rows.filter(r => +r.b === +b && (+b !== 4 || !tower || !r.tower || r.tower === tower));
  const exact = inB.find(r => r.unit === u.digits);
  if (exact) return { ...exact, floor: u.floor };
  // The stack on that floor (the narrowest floor range first), else the same stack within 2 floors.
  const st = inB.filter(r => !r.unit && r.stack === u.stack);
  const dist = r => r.from == null && r.to == null ? 1 : u.floor < (r.from ?? -1) ? r.from - u.floor : u.floor > (r.to ?? 999) ? u.floor - r.to : 0;
  const span = r => (r.to ?? 99) - (r.from ?? 0);
  const best = st.map(r => [dist(r), span(r), r]).sort((x, y) => x[0] - y[0] || x[1] - y[1])[0];
  const r = best && best[0] <= 2 ? best[2] : null;
  return r ? { ...r, floor: u.floor } : { floor: u.floor };
}

export async function guideFor(unit, b = null) {
  const rows = await guideRows();
  const bs = b ? [+b] : [1, 2, 3, 4, 5];
  return bs.map(x => { const m = matchGuide(rows, x, "", unit); return m && m.type ? { building: BLD[x], tower: m.tower || undefined, floor: m.floor, type: m.type, layout: m.layout, size: m.size, balcony: m.balcony, view: m.view || undefined, floorPlanPage: m.src ? undefined : m.page || undefined, floorPlanImage: m.src || undefined } : null; }).filter(Boolean);
}
