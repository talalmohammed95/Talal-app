// The AI assistant for the Orla team. An agent types a unit number: the assistant finds the unit and its
// owner (only on the agent's own units; the admin sees all), then helps write the listing for Bayut and
// Property Finder. The lookups run here, on our server, with the same privacy rules as the rest of the app.
import Anthropic from "@anthropic-ai/sdk";
import { q } from "./db.js";
import { searchContacts } from "./contacts.js";

const MODEL = "claude-opus-5-5";
const BLD = { 1: "Peninsula One", 2: "Peninsula Two", 3: "Peninsula Three", 4: "Peninsula Four (The Plaza)", 5: "Peninsula Five (Signature Collection)" };
const TYPE = ["Studio", "1 bedroom", "2 bedroom", "3 bedroom"];
const MAX_TURNS = 6;

const norm = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const num = v => { const n = Number(String(v ?? "").replace(/[^0-9.]/g, "")); return Number.isFinite(n) && n > 0 ? n : null; };
const txt = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const first = s => String(s || "").split(" ")[0];
const isAdmin = u => u.role === "admin";

export const aiEnabled = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

// ---------- what the agent may see ----------
function unitView(kind, id, d, extra) {
  const b = parseInt(d.b, 10) || null, beds = d.beds === undefined || d.beds === "" ? null : parseInt(d.beds, 10);
  const out = {
    kind, id, unit: txt(d.unit, 20), building: BLD[b] || null, b, beds, type: TYPE[beds] || null, deal: d.deal || "sale",
    price: d.deal === "rent" ? null : num(d.price), rent: d.deal === "rent" ? num(d.rent ?? d.price) : num(d.rent),
    size: num(d.size), floor: txt(d.floor, 40), view: txt(d.view, 80), status: txt(d.status, 40), furnishing: txt(d.furn, 40),
    owner: txt(d.owner, 100), ownerPhone: txt(d.phone ?? d.ownerPhone, 40), ownerNote: txt(d.ownerNote, 300), notes: txt(d.notes, 600),
    portalTitle: txt(d.adTitle, 120), portalDescription: String(d.adText || "").slice(0, 3000),
    online: d.online || {}, future: !!d.future, availableFrom: d.availableFrom || null, ...extra
  };
  for (const k of Object.keys(out)) if (out[k] === "" || out[k] === null) delete out[k];
  return out;
}

async function myRows(user) {
  const admin = isAdmin(user);
  const [{ rows: L }, { rows: O }] = await Promise.all([
    q(`select l.id, l.user_id, l.data, u.name, u.agent_key from listings l join users u on u.id = l.user_id ${admin ? "" : "where l.user_id = $1"}`, admin ? [] : [user.id]),
    q(`select id, data from offers ${admin ? "" : "where data->>'agent' = $1"}`, admin ? [] : [user.agent_key || "-"])]);
  return { L, O };
}

async function findUnit(user, query) {
  const n = norm(query);
  if (!n) return { error: "Give a unit number." };
  const admin = isAdmin(user);
  const [{ rows: L }, { rows: O }] = await Promise.all([
    q(`select l.id, l.user_id, l.data, u.name, u.agent_key from listings l join users u on u.id = l.user_id where coalesce(l.data->>'unit', '') <> ''`),
    q(`select id, data from offers where coalesce(data->>'unit', '') <> ''`)]);
  const hit = d => { const u = norm(d.unit); return u === n || (n.length >= 3 && u.length >= 3 && (u.endsWith(n) || n.endsWith(u))); };
  const found = [], others = new Set();
  for (const r of L) if (hit(r.data)) {
    if (admin || r.user_id === user.id) found.push(unitView("listing", r.id, r.data, { listedBy: r.name || r.agent_key, mine: r.user_id === user.id }));
    else others.add(first(r.name) || "another agent");
  }
  for (const r of O) if (hit(r.data)) {
    if (admin || (user.agent_key && r.data.agent === user.agent_key)) found.push(unitView("offer", r.id, r.data, { listedBy: r.data.agent || "", title: txt(r.data.title, 120) }));
    else others.add("another agent");
  }
  // Another agent's unit: only who to talk to, never the owner or the details.
  return { query: String(query).slice(0, 20), found, listedByTeammates: [...others],
    note: found.length ? undefined : others.size ? "This unit is listed by a teammate. Only they and the admin can see the owner." : "No unit with this number in your units yet. You can add it as a new listing." };
}

async function listMyUnits(user) {
  const { L, O } = await myRows(user);
  const units = L.map(r => unitView("listing", r.id, r.data, isAdmin(user) ? { listedBy: r.name } : {}))
    .concat(O.filter(r => r.data.agent && (isAdmin(user) ? r.data.unit : true)).map(r => unitView("offer", r.id, r.data, { title: txt(r.data.title, 120), listedBy: r.data.agent })))
    .map(u => { delete u.portalDescription; delete u.notes; delete u.ownerNote; return u; });
  return { count: units.length, units: units.slice(0, 80) };
}

async function marketSnapshot(b, beds, deal) {
  const { rows } = await q("select data from offers");
  const pick = rows.map(r => r.data).filter(d => (beds == null || +d.beds === +beds) && d.avail !== "Sold" && d.avail !== "Rented");
  const sum = list => {
    const sale = list.filter(d => d.deal !== "rent" && num(d.price)), rent = list.filter(d => num(d.rent ?? (d.deal === "rent" ? d.price : null)));
    const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.floor(s.length / 2)]); };
    const psf = sale.filter(d => num(d.size)).map(d => num(d.price) / num(d.size));
    return {
      forSale: sale.length, salePriceMin: sale.length ? Math.min(...sale.map(d => num(d.price))) : null, salePriceMax: sale.length ? Math.max(...sale.map(d => num(d.price))) : null,
      medianSalePricePerSqft: med(psf), forRent: rent.length, medianRentPerYear: med(rent.map(d => num(d.rent ?? d.price))),
      sizes: [...new Set(list.map(d => num(d.size)).filter(Boolean))].sort((x, y) => x - y).slice(0, 12)
    };
  };
  const same = pick.filter(d => b == null || +d.b === +b);
  const research = same.map(d => d.market).find(m => Array.isArray(m) && m.length);
  return {
    building: BLD[b] || "all towers", type: TYPE[beds] || "all types", deal: deal || "any",
    sameBuilding: sum(same), allTowers: sum(pick),
    marketResearch: research ? Object.fromEntries(research.slice(0, 8).map(([k, v]) => [k, v])) : undefined,
    note: "Asking prices of the units the team has today, plus the registered-sales research saved in the app. Use them to suggest a price range; never quote them to clients as a comparison."
  };
}

// The draft goes back to the app as a card; the agent checks it and saves it in My units.
function cleanDraft(i, user) {
  const int = (v, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
  const deal = ["sale", "rent", "both"].includes(i.deal) ? i.deal : "sale";
  const d = {
    listingId: /^[A-Za-z0-9_-]{1,64}$/.test(i.listing_id || "") ? i.listing_id : null,
    unit: txt(i.unit, 20), b: int(i.building, 1, 5), beds: int(i.beds, 0, 3), deal,
    price: num(i.price), rent: num(i.rent), size: num(i.size), floor: txt(i.floor, 40), view: txt(i.view, 80),
    status: ["Ready", "Vacant", "Tenanted", "Off-plan"].includes(i.status) ? i.status : "",
    furn: ["Unfurnished", "Fully fitted", "Fully furnished"].includes(i.furnishing) ? i.furnishing : "",
    owner: txt(i.owner, 100), phone: txt(i.owner_phone, 40), agent: user.agent_key || "",
    adTitle: txt(i.portal_title, 120), adText: String(i.portal_description || "").slice(0, 3000),
    missing: (Array.isArray(i.missing) ? i.missing : []).map(s => txt(s, 160)).filter(Boolean).slice(0, 10),
    tips: (Array.isArray(i.tips) ? i.tips : []).map(s => txt(s, 200)).filter(Boolean).slice(0, 8)
  };
  return d;
}

// ---------- the tools Claude can use ----------
const TOOLS = [
  { name: "find_contact", description: "Search the Peninsula contacts database (owners, tenants and buyers across the five towers) by phone number, unit number or name. Returns each person's name, phones, email, building, unit, type, size and notes. Call it whenever the agent types a phone number, and together with find_unit when they type a unit number.",
    strict: true, input_schema: { type: "object", properties: { query: { type: "string", description: "A phone number (any format), a unit number, or part of a name" } }, required: ["query"], additionalProperties: false } },
  { name: "find_unit", description: "Find a unit in the Peninsula by its unit number, among the agent's own listings and offers (the admin sees every agent's). Returns the unit's details and the owner's name and phone when the unit belongs to the agent. For a teammate's unit it returns only that a teammate has it. Call this whenever the agent mentions a unit number.",
    strict: true, input_schema: { type: "object", properties: { unit: { type: "string", description: "The unit number as the agent typed it, e.g. 1203 or P3-1203" } }, required: ["unit"], additionalProperties: false } },
  { name: "list_my_units", description: "List the agent's own units (listings and offers under their name) with building, type, price, platforms it is online on, and whether it is a future listing. Use it for questions like 'which of my units are not online yet'.",
    strict: true, input_schema: { type: "object", properties: {}, required: [], additionalProperties: false } },
  { name: "market_snapshot", description: "Asking-price ranges, median price per sq ft and median rents of the team's current Peninsula units of the same type, in the same building and across the five towers, plus saved registered-sales research. Use it to suggest a listing price.",
    strict: true, input_schema: { type: "object", properties: { building: { type: ["integer", "null"], description: "1 to 5, or null for all towers" }, beds: { type: ["integer", "null"], description: "0 for studio, 1 to 3 bedrooms, or null" }, deal: { type: "string", enum: ["sale", "rent", "both"] } }, required: ["building", "beds", "deal"], additionalProperties: false } },
  { name: "prepare_listing", description: "Show the agent a ready listing draft as a card in the app, with a button that puts it into the My units form for them to check and save. Use it once you have the unit's details (from find_unit or from the agent). Include a portal title and a portal description written for Bayut and Property Finder. Use listing_id when updating an existing listing from find_unit (kind 'listing'). Only include owner details that came from find_unit or from the agent.",
    input_schema: { type: "object", additionalProperties: false, required: ["building", "beds", "deal", "portal_title", "portal_description"], properties: {
      listing_id: { type: "string", description: "id of the existing listing (kind 'listing') to update; omit for a new one" },
      unit: { type: "string" }, building: { type: "integer", minimum: 1, maximum: 5 }, beds: { type: "integer", minimum: 0, maximum: 3 },
      deal: { type: "string", enum: ["sale", "rent", "both"] }, price: { type: "number", description: "Sale price in AED" }, rent: { type: "number", description: "Rent per year in AED" },
      size: { type: "number", description: "sq ft" }, floor: { type: "string" }, view: { type: "string" },
      status: { type: "string", enum: ["Ready", "Vacant", "Tenanted", "Off-plan"] }, furnishing: { type: "string", enum: ["Unfurnished", "Fully fitted", "Fully furnished"] },
      owner: { type: "string" }, owner_phone: { type: "string" },
      portal_title: { type: "string", description: "Listing title for Bayut and Property Finder, at most 60 characters, no unit number" },
      portal_description: { type: "string", description: "Listing description for Bayut and Property Finder: 120 to 250 words, short paragraphs and a bullet list of features, no unit number, no owner details, ends with a call to contact the agent" },
      missing: { type: "array", items: { type: "string" }, description: "What the agent still needs to confirm or collect before going live (e.g. Form A, title deed, Trakheesi permit, photos)" },
      tips: { type: "array", items: { type: "string" }, description: "Short tips to make the listing perform better" } } } }
];

const SYSTEM = `You are the AI assistant inside Orla Properties' Peninsula app, for the five agents of the Orla team (Business Bay, Dubai; the Peninsula is five towers by Select Group on the Dubai Canal: Peninsula One, Two, Three, Four "The Plaza" and Five "Signature Collection").

Your job:
1. When the agent gives a phone number, call find_contact straight away. When they give a unit number, call find_unit and find_contact together. Show what you found: building, type, size, floor, view, price, status, and the owner's name and phone if the tool returned them. If the unit is a teammate's, say which teammate to talk to; never guess owner details. The contacts database is for the Orla agents. A client belongs to the first agent who listed their unit on the website: for anyone else find_contact returns only taken: true and who has it. Then say which agent has the client and that they can't contact them; never try to find their details another way. Every lookup is logged. A contact card on screen has buttons to call, to WhatsApp and to make a sales offer, so don't repeat every detail in chat.
2. Help the agent create or improve the listing in the best possible way: check what is missing, suggest a price range with market_snapshot when no price is set or the agent asks, then call prepare_listing with a strong portal title and description for Bayut and Property Finder.
3. Answer quick questions about their own units with list_my_units.

Listing rules for Dubai portals: the agent needs Form A signed with the owner, the title deed and the owner's ID, and a DLD/Trakheesi permit number on every advert; photos must be real and recent; the price must be the real asking price. Titles: no unit numbers, no ALL CAPS, no emoji, under 60 characters. Descriptions: lead with the strongest selling point (view, layout, canal, Burj Khalifa, Dubai Mall walking distance, Plaza retail at Peninsula Four), then short paragraphs and a bullet list, then a call to contact the agent. Never include the unit number, the owner's name or phone in portal text.

Privacy: owner details are for the listing agent and the admin only. Only repeat owner details that a tool returned for this agent. Never reveal another agent's owners.

Write in plain, friendly English (or the agent's language if they write in another one). Keep chat replies short: a few lines, simple words, no tables. Prices in AED with thousands separators. Don't say a unit is above market; talk about what makes it attractive.`;

async function logLookup(user, query, n) {
  await q("insert into activity (by_user, by_email, text) values ($1, $2, $3)", [user.id, user.email, `Contacts lookup (assistant): ${String(query).slice(0, 80)} (${n} found)`]);
}

// ---------- the conversation ----------
export async function assist(user, history, agentsMap) {
  const client = new Anthropic();
  const cards = [];
  const messages = history.map(m => ({ role: m.role, content: m.text }));
  const who = `The agent you're helping: ${user.name || user.email}${user.agent_key && agentsMap[user.agent_key] ? ` (${agentsMap[user.agent_key].name}, phone ${agentsMap[user.agent_key].phone || "not set"})` : ""}${isAdmin(user) ? ", the admin: they can see every agent's units and owners" : ""}. Today is ${new Date().toISOString().slice(0, 10)}.`;
  const run = async (name, input) => {
    if (name === "find_unit") { const r = await findUnit(user, input.unit); for (const u of r.found || []) cards.push({ type: "unit", unit: u }); if (!(r.found || []).length) cards.push({ type: "notfound", query: r.query, teammates: r.listedByTeammates }); return r; }
    if (name === "find_contact") { const found = await searchContacts(input.query, user); await logLookup(user, input.query, found.length); for (const ct of found.slice(0, 8)) cards.push({ type: "contact", contact: ct }); return { found: found.slice(0, 8), more: Math.max(0, found.length - 8) }; }
    if (name === "list_my_units") return listMyUnits(user);
    if (name === "market_snapshot") return marketSnapshot(input.building, input.beds, input.deal);
    if (name === "prepare_listing") {
      const draft = cleanDraft(input, user);
      // Only the agent's own listing can be updated from a draft (the admin can update any).
      if (draft.listingId) { const { rows: [l] } = await q("select user_id from listings where id = $1", [draft.listingId]); if (!l || (!isAdmin(user) && l.user_id !== user.id)) draft.listingId = null; }
      cards.push({ type: "draft", draft }); return { shown: true, note: "The draft is on the agent's screen with a button to put it into the My units form. Don't repeat the description in chat; say what to check." }; }
    return { error: "Unknown tool." };
  };
  let text = "";
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await client.beta.messages.create({
      model: MODEL, max_tokens: 16000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      output_config: { effort: "medium" }, system: SYSTEM + "\n\n" + who, tools: TOOLS, messages
    });
    if (res.stop_reason === "refusal") { text = "Sorry, I can't help with that one. Try asking about a unit or a listing."; break; }
    text = res.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim() || text;
    const uses = res.content.filter(b => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || !uses.length) break;
    messages.push({ role: "assistant", content: res.content });
    const results = await Promise.all(uses.map(async b => {
      try { return { type: "tool_result", tool_use_id: b.id, content: JSON.stringify(await run(b.name, b.input || {})) }; }
      catch (e) { console.error("assistant tool", b.name, e); return { type: "tool_result", tool_use_id: b.id, is_error: true, content: "The lookup failed. Try again." }; }
    }));
    messages.push({ role: "user", content: results });
  }
  return { reply: text || "Done.", cards };
}

// Without an API key the assistant still finds the unit and fills a starter listing, so the team can use it today.
export async function assistOffline(user, history) {
  const last = String((history[history.length - 1] || {}).text || "");
  const phone = last.match(/\+?\d[\d\s-]{6,}\d/);
  if (phone && phone[0].replace(/\D/g, "").length >= 7) {
    const found = await searchContacts(phone[0], user); await logLookup(user, phone[0], found.length);
    return { reply: found.length ? `Found ${found.length === 1 ? "this contact" : found.length + " contacts"} for ${phone[0].trim()}.` : `No contact with ${phone[0].trim()} in the Peninsula contacts.`, cards: found.slice(0, 8).map(ct => ({ type: "contact", contact: ct })), offline: true };
  }
  const m = last.match(/\b(?:p\s*[1-5]\s*[-\s]?)?\d{2,5}[a-z]?\b/i);
  const nm = !m && last.replace(/^(?:find|search|look ?up|who is)\s+/i, "").trim();
  if (nm && /[a-z]{3,}/i.test(nm) && nm.length <= 60) {
    const found = await searchContacts(nm, user); await logLookup(user, nm, found.length);
    if (found.length) return { reply: `Found ${found.length === 1 ? "this contact" : found.length + " contacts"} for "${nm}".`, cards: found.slice(0, 8).map(ct => ({ type: "contact", contact: ct })), offline: true };
  }
  if (!m) return { reply: "Type a phone number, a unit number or a name. For example 050 123 4567 or 1203.", cards: [], offline: true };
  const r = await findUnit(user, m[0]);
  const cards = r.found.map(u => ({ type: "unit", unit: u }));
  const people = await searchContacts(m[0], user); await logLookup(user, m[0], people.length);
  if (!r.found.length && !people.length) cards.push({ type: "notfound", query: r.query, teammates: r.listedByTeammates });
  for (const ct of people.slice(0, 8)) cards.push({ type: "contact", contact: ct });
  const u = r.found[0];
  if (u) {
    const t = `${u.type || "Apartment"}${u.view ? " with " + u.view + " view" : ""} | ${(u.building || "Peninsula").replace(/ \(.*\)/, "")}`.slice(0, 60);
    const body = `${u.type || "Apartment"} in ${u.building || "the Peninsula"}, Business Bay, on the Dubai Canal.\n\n` +
      [u.size && `• ${u.size.toLocaleString("en-US")} sq ft`, u.floor && `• ${u.floor}`, u.view && `• ${u.view} view`, u.furnishing && `• ${u.furnishing}`, u.status && `• ${u.status}`, "• Pool, gym, kids' area and 24/7 security", "• Minutes from Dubai Mall and Downtown"].filter(Boolean).join("\n") +
      "\n\nCall or WhatsApp us today to arrange a viewing.";
    cards.push({ type: "draft", draft: { listingId: u.kind === "listing" ? u.id : null, unit: u.unit, b: u.b, beds: u.beds, deal: u.deal, price: u.price, rent: u.rent, size: u.size, floor: u.floor, view: u.view, status: u.status, furn: u.furnishing, owner: u.owner, phone: u.ownerPhone, agent: user.agent_key || "", adTitle: t, adText: body,
      missing: ["Form A signed with the owner", "Title deed and owner's ID", "Trakheesi permit number", "Recent photos"], tips: [] } });
  }
  if (!u && people.length) return { reply: `Unit ${r.query} in the Peninsula contacts:`, cards, offline: true };
  return { reply: u ? `Found unit ${u.unit}. A starter listing is below. (The full AI writing turns on once the admin adds the AI key.)` : (r.note || "Not found."), cards, offline: true };
}
