// The AI assistant for the Orla team. An agent types a unit number: the assistant finds the unit and its
// owner (only on the agent's own units; the admin sees all), then helps write the listing for Bayut and
// Property Finder. The lookups run here, on our server, with the same privacy rules as the rest of the app.
import Anthropic from "@anthropic-ai/sdk";
import { q } from "./db.js";
import { searchContacts } from "./contacts.js";
import { KNOWLEDGE } from "./knowledge.js";
import { compareUnit } from "./deals.js";
import { MORE_TOOLS, runMore } from "./aitools.js";
import { paceOf } from "./weekly.js";

const MODEL = "claude-opus-5-5";
const BLD = { 1: "Peninsula One", 2: "Peninsula Two", 3: "Peninsula Three", 4: "Peninsula Four (The Plaza)", 5: "Peninsula Five (Signature Collection)" };
const TYPE = ["Studio", "1 bedroom", "2 bedroom", "3 bedroom", "4 bedroom"];
const LAYOUT = { simplex: "simplex", duplex: "duplex", loft: "duplex loft", semipenthouse: "semi-penthouse" };
const typeOf = (beds, layout) => beds === null || beds === undefined || Number.isNaN(beds) ? null : (beds === 0 && layout ? "Studio" : TYPE[beds] || "") + (LAYOUT[layout] ? " " + LAYOUT[layout] : "");
const MAX_TURNS = 6;

const norm = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const num = v => { const n = Number(String(v ?? "").replace(/[^0-9.]/g, "")); return Number.isFinite(n) && n > 0 ? n : null; };
const txt = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const first = s => String(s || "").split(" ")[0];
// The admin and the CEO see every agent's units and owners.
const isAdmin = u => u.role === "admin" || u.role === "ceo";

export const aiEnabled = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

// ---------- what the agent may see ----------
function unitView(kind, id, d, extra) {
  const b = parseInt(d.b, 10) || null, beds = d.beds === undefined || d.beds === "" ? null : parseInt(d.beds, 10);
  const out = {
    kind, id, unit: txt(d.unit, 20), building: BLD[b] || null, b, beds, type: typeOf(beds, d.layout), layout: d.layout || null, deal: d.deal || "sale",
    price: d.deal === "rent" ? null : num(d.price), rent: d.deal === "rent" ? num(d.rent ?? d.price) : num(d.rent),
    size: num(d.size), tower: b === 4 && ["A", "B"].includes(d.tower) ? "Tower " + d.tower : null, floor: txt(d.floor, 40), view: txt(d.view, 80), status: txt(d.status, 40), furnishing: txt(d.furn, 40),
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
    unit: txt(i.unit, 20), b: int(i.building, 1, 5), tower: +i.building === 4 && ["A", "B"].includes(i.tower) ? i.tower : "", layout: LAYOUT[i.layout] ? i.layout : "", beds: int(i.beds, 0, 4), deal,
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

// ---------- the catalogue: every home the team has on offer ----------
const DONE = /sold|rented|reserved|let/i;
function offerView(id, d, user) {
  const own = isAdmin(user) || (user.agent_key && d.agent === user.agent_key);
  const b = parseInt(d.b, 10) || null, beds = parseInt(d.beds, 10);
  const o = { id, building: BLD[b] || null, b, tower: b === 4 && ["A", "B"].includes(d.tower) ? "Tower " + d.tower : undefined, type: typeOf(beds, d.layout), layout: d.layout || undefined, beds, deal: d.deal || "sale",
    title: txt(d.title, 120), price: d.deal === "rent" ? null : num(d.price), rent: num(d.rent ?? (d.deal === "rent" ? d.price : null)), size: num(d.size), balcony: num(d.balcony) || undefined,
    floor: txt(d.floor, 40), view: txt(d.view, 80), furnishing: txt(d.furn, 40), status: txt(d.status, 40), available: d.avail || "Available", cheques: d.cheques || undefined, deposit: d.deposit || undefined,
    agent: d.agent || "", highlight: txt(d.hl, 400), investor: d.inv || undefined, market: Array.isArray(d.market) ? d.market.slice(0, 5) : undefined, teamOnly: !!d.teamOnly || undefined };
  if (own && d.unit) o.unit = txt(d.unit, 20);
  for (const k of Object.keys(o)) if (o[k] === "" || o[k] === null || o[k] === undefined) delete o[k];
  return o;
}
async function catalogue(user) {
  const { rows } = await q("select id, data from offers");
  return rows.map(r => offerView(r.id, r.data, user));
}
const keyPrice = (o, deal) => deal === "rent" ? o.rent : o.price;
const fits = (o, deal) => deal === "rent" ? !!o.rent && o.deal !== "sale" : !!o.price && o.deal !== "rent";
async function searchOffers(user, i) {
  const deal = ["sale", "rent"].includes(i.deal) ? i.deal : null, words = String(i.text || "").toLowerCase().split(/\s+/).filter(w => w.length > 2);
  let l = (await catalogue(user)).filter(o => !DONE.test(o.available) || i.include_sold);
  if (i.building) l = l.filter(o => o.b === +i.building);
  if (i.beds !== null && i.beds !== undefined) l = l.filter(o => o.beds === +i.beds);
  if (deal) l = l.filter(o => fits(o, deal));
  if (i.max_price) l = l.filter(o => (keyPrice(o, deal || (o.price ? "sale" : "rent")) || 0) <= i.max_price);
  if (i.min_price) l = l.filter(o => (keyPrice(o, deal || (o.price ? "sale" : "rent")) || 0) >= i.min_price);
  if (words.length) l = l.filter(o => words.every(w => JSON.stringify(o).toLowerCase().includes(w)));
  return l.sort((a, b) => (keyPrice(a, deal || "sale") || a.rent || 0) - (keyPrice(b, deal || "sale") || b.rent || 0)).slice(0, 30);
}
// Premium, middle and value, with a big gap between the premium and the middle (Talal's rule).
async function threeOptions(user, i) {
  const deal = i.deal === "rent" ? "rent" : "sale";
  let l = (await catalogue(user)).filter(o => !DONE.test(o.available) && fits(o, deal) && (i.beds === null || i.beds === undefined || o.beds === +i.beds) && (!i.building || o.b === +i.building));
  if (i.budget_max) { const within = l.filter(o => keyPrice(o, deal) <= i.budget_max * 1.05); if (within.length >= 2) l = within; }
  l.sort((a, b) => keyPrice(b, deal) - keyPrice(a, deal));
  if (l.length <= 3) return { deal, options: l.map((o, k) => ({ label: ["Premium", "Middle", "Value"][l.length === 2 && k === 1 ? 2 : k], ...o })) };
  const top = l[0], low = l[l.length - 1], aim = keyPrice(low, deal) + (keyPrice(top, deal) - keyPrice(low, deal)) * 0.4;
  const mid = l.slice(1, -1).sort((a, b) => Math.abs(keyPrice(a, deal) - aim) - Math.abs(keyPrice(b, deal) - aim))[0];
  return { deal, options: [{ label: "Premium", ...top }, { label: "Middle", ...mid }, { label: "Value", ...low }], others: l.length - 3 };
}

// A unit to compare: an offer, the agent's own listing (the admin's: any), or the details given.
export async function compareFor(user, i) {
  let d = null, label = "";
  if (i.offer_id) { const { rows: [o] } = await q("select data from offers where id = $1", [String(i.offer_id)]); if (o) { d = o.data; label = txt(o.data.title, 80); } }
  if (!d && i.listing_id) { const { rows: [l] } = await q("select user_id, data from listings where id = $1", [String(i.listing_id)]); if (l && (isAdmin(user) || l.user_id === user.id)) { d = l.data; label = l.data.unit ? "Unit " + txt(l.data.unit, 20) : ""; } }
  const src = d ? { b: d.b, tower: d.tower, beds: d.beds === undefined || d.beds === "" ? null : +d.beds, layout: d.layout, size: d.size, deal: d.deal === "rent" ? "rent" : "sale", price: d.deal === "rent" ? (d.rent ?? d.price) : d.price }
    : { b: i.building, tower: i.tower, beds: i.beds, layout: i.layout, size: i.size, deal: i.deal, price: i.price };
  for (const k of ["building", "tower", "beds", "layout", "size", "price"]) if (i[k] !== undefined && i[k] !== null && i[k] !== "" && d) src[k === "building" ? "b" : k] = i[k];
  const r = await compareUnit(src);
  r.label = label || [BLD[+src.b], typeOf(src.beds, src.layout)].filter(Boolean).join(" · ");
  r.type = typeOf(src.beds, src.layout); r.buildingName = BLD[+src.b] || "";
  return r;
}

// ---------- the tools Claude can use ----------
const TOOLS_BASE = [
  { name: "compare_unit", description: "Compare a unit with registered Peninsula deals imported from DXB Interact (DLD data): same building, same type, last 12 months (24 if few), similar sizes first. Returns the average, median and range of prices and price per sq ft, the latest deals, and the unit's position against the average (for the agent only). Shows a comparison card the agent can copy for a client. Give offer_id (from search_offers) or listing_id (from find_unit, kind listing), or the details.",
    input_schema: { type: "object", additionalProperties: false, properties: {
      offer_id: { type: "string" }, listing_id: { type: "string" }, building: { type: "integer", minimum: 1, maximum: 5 }, tower: { type: "string", enum: ["A", "B"] },
      beds: { type: "integer", minimum: 0, maximum: 4 }, layout: { type: "string", enum: ["", "simplex", "duplex", "loft", "semipenthouse"] }, size: { type: "number" }, price: { type: "number", description: "Asking price, or annual rent for rent" }, deal: { type: "string", enum: ["sale", "rent"] } } } },
  { name: "search_offers", description: "Search every home the Orla team has on offer in the Peninsula (sale and rent), live from the app: building, tower, type, price or rent, size, floor, view, furnishing, status, the listing agent, highlights, investor figures and market rows. Unit numbers appear only on the agent's own offers. Use it for any question about what we have, prices, comparisons or picking homes for a client.",
    strict: true, input_schema: { type: "object", additionalProperties: false, required: ["building", "beds", "deal", "max_price", "min_price", "text", "include_sold"], properties: {
      building: { type: ["integer", "null"], description: "1 to 5, or null for all" }, beds: { type: ["integer", "null"], description: "0 studio, 1 to 3, or null" },
      deal: { type: ["string", "null"], description: "sale, rent, or null for both" }, max_price: { type: ["number", "null"], description: "AED; for rent, per year" }, min_price: { type: ["number", "null"] },
      text: { type: ["string", "null"], description: "Words to match, e.g. 'burj' or 'furnished'" }, include_sold: { type: "boolean" } } } },
  { name: "three_options", description: "Pick three homes for a client request: Premium, Middle and Value, with a big price gap between Premium and Middle (Talal's rule). Shows them to the agent as a card with a button to make one sales offer for all three. Use it whenever the agent describes what a client wants.",
    strict: true, input_schema: { type: "object", additionalProperties: false, required: ["beds", "deal", "budget_max", "building"], properties: {
      beds: { type: ["integer", "null"] }, deal: { type: "string", enum: ["sale", "rent"] }, budget_max: { type: ["number", "null"], description: "The client's top budget in AED (per year for rent), or null" }, building: { type: ["integer", "null"] } } } },
  { name: "sales_offer", description: "Prepare the one-page sales offer PDF (one page per home) for a client, by name, from offer ids returned by search_offers or three_options. Shows a button that opens the sales offer, ready to share on WhatsApp.",
    strict: true, input_schema: { type: "object", additionalProperties: false, required: ["offer_ids", "client_name"], properties: { offer_ids: { type: "array", items: { type: "string" } }, client_name: { type: "string", description: "The client's name for 'Prepared for', or empty" } } } },
  { name: "team_status", description: "The team's progress to the goal (15 listings each online on Bayut and Property Finder by 31 Dec 2026): per agent, listings, online on both, partly online, off market. Use it for team or leaderboard questions.",
    strict: true, input_schema: { type: "object", properties: {}, required: [], additionalProperties: false } },
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
      unit: { type: "string" }, building: { type: "integer", minimum: 1, maximum: 5 }, tower: { type: "string", enum: ["A", "B"], description: "Tower A or B: Peninsula Four only (the only building with two towers)" }, beds: { type: "integer", minimum: 0, maximum: 4 },
      layout: { type: "string", enum: ["simplex", "duplex", "loft", "semipenthouse"], description: "Leave out for an ordinary apartment. simplex: Peninsula One podium or waterfront; loft: Peninsula Four duplex lofts; duplex or semipenthouse: Peninsula Five" },
      deal: { type: "string", enum: ["sale", "rent", "both"] }, price: { type: "number", description: "Sale price in AED" }, rent: { type: "number", description: "Rent per year in AED" },
      size: { type: "number", description: "sq ft" }, floor: { type: "string" }, view: { type: "string" },
      status: { type: "string", enum: ["Ready", "Vacant", "Tenanted", "Off-plan"] }, furnishing: { type: "string", enum: ["Unfurnished", "Fully fitted", "Fully furnished"] },
      owner: { type: "string" }, owner_phone: { type: "string" },
      portal_title: { type: "string", description: "Listing title for Bayut and Property Finder, at most 60 characters, no unit number" },
      portal_description: { type: "string", description: "Listing description for Bayut and Property Finder: 120 to 250 words, short paragraphs and a bullet list of features, no unit number, no owner details, ends with a call to contact the agent" },
      missing: { type: "array", items: { type: "string" }, description: "What the agent still needs to confirm or collect before going live (e.g. Form A, title deed, Trakheesi permit, photos)" },
      tips: { type: "array", items: { type: "string" }, description: "Short tips to make the listing perform better" } } } }
];

const TOOLS = TOOLS_BASE.concat(MORE_TOOLS);

const SYSTEM = `You are the AI assistant inside Orla Properties' Peninsula app, for the five agents of the Orla team (Business Bay, Dubai; the Peninsula is five towers by Select Group on the Dubai Canal: Peninsula One, Two, Three, Four "The Plaza" and Five "Signature Collection").

Your job:
1. When the agent gives a phone number, call find_contact straight away. When they give a unit number, call find_unit and find_contact together. Show what you found: building, type, size, floor, view, price, status, and the owner's name and phone if the tool returned them. If the unit is a teammate's, say which teammate to talk to; never guess owner details. The contacts database is for the Orla agents. A client belongs to the first agent who listed their unit on the website: for anyone else find_contact returns only taken: true and who has it. Then say which agent has the client and that they can't contact them; never try to find their details another way. Every lookup is logged. A contact card on screen has buttons to call, to WhatsApp and to make a sales offer, so don't repeat every detail in chat.
2. Help the agent create or improve the listing in the best possible way: check what is missing, suggest a price range with market_snapshot when no price is set or the agent asks, then call prepare_listing with a strong portal title and description for Bayut and Property Finder.
3. Answer quick questions about their own units with list_my_units.
4. When the agent describes a client's request (type, budget, sale or rent), call three_options, explain the three picks in two or three lines, and offer the sales offer. For any question about our homes, use search_offers: never guess prices or availability.
5. When the agent asks for a sales offer, call sales_offer with the offer ids and the client's name.
6. When the agent asks to compare a unit or wants the market analysis for a listing, call compare_unit (find the unit first if needed). Explain it simply; if the unit is priced above the average, give the agent the honest position but suggest how to present it to the client (view, floor, layout, condition), never write "above market" for the client.
7. You can look things up across the whole database with your tools: homes (search_offers), units and owners (find_unit, list_my_units), contacts (find_contact, contacts_browse), the agents' client lists (clients_list), client requests (requests_list), app accounts (users_list), tasks (tasks_list), website visitors (visitors_summary), registered deals (deals_list, compare_unit), documents (documents_list) and the team (team_status). Use them instead of guessing, and combine them: e.g. match a client's budget and type with search_offers, or list follow-ups due today. You only get what the person asking may see: the admin and the CEO see everything; an agent sees their own clients, owners, requests and tasks. If a tool says something isn't allowed, say so plainly.
8. Answer market, building, fee and investment questions from what you know below (DLD figures, comparable sales, fees, Talal's decks), and say where a figure comes from. Work out total costs, yields and returns the way Talal's decks do.

Listing rules for Dubai portals: the agent needs Form A signed with the owner, the title deed and the owner's ID, and a DLD/Trakheesi permit number on every advert; photos must be real and recent; the price must be the real asking price. Titles: no unit numbers, no ALL CAPS, no emoji, under 60 characters. Descriptions: lead with the strongest selling point (view, layout, canal, Burj Khalifa, Dubai Mall walking distance, Plaza retail at Peninsula Four), then short paragraphs and a bullet list, then a call to contact the agent. Never include the unit number, the owner's name or phone in portal text. Peninsula Four has Tower A and Tower B: always say which tower when you know it, and if a Peninsula Four unit has no tower, ask the agent which one.

Privacy: owner details are for the listing agent and the admin only. Only repeat owner details that a tool returned for this agent. Never reveal another agent's owners.

Write in plain, friendly English (or the agent's language if they write in another one). Keep chat replies short: a few lines, simple words, no tables. Prices in AED with thousands separators. Don't say a unit is above market; talk about what makes it attractive.`;

async function logLookup(user, query, n) {
  await q("insert into activity (by_user, by_email, text) values ($1, $2, $3)", [user.id, user.email, `Contacts lookup (assistant): ${String(query).slice(0, 80)} (${n} found)`]);
}

// ---------- the conversation ----------
export async function assist(user, history, agentsMap, extra = {}) {
  const client = new Anthropic();
  const cards = [];
  const messages = history.map(m => ({ role: m.role, content: m.text }));
  const who = `The agent you're helping: ${user.name || user.email}${user.agent_key && agentsMap[user.agent_key] ? ` (${agentsMap[user.agent_key].name}, phone ${agentsMap[user.agent_key].phone || "not set"})` : ""}${user.role === "ceo" ? ", the CEO of Orla Properties (always address him as Mr " + first(user.name) + ", never by his first name alone): the most experienced person on the team; they see every agent's units and owners, and they don't create listings themselves" : user.role === "admin" ? ", the admin (Talal): they can see every agent's units and owners" : ""}. Today is ${new Date().toISOString().slice(0, 10)}.`;
  const run = async (name, input) => {
    if (name === "find_unit") { const r = await findUnit(user, input.unit); for (const u of r.found || []) cards.push({ type: "unit", unit: u }); if (!(r.found || []).length) cards.push({ type: "notfound", query: r.query, teammates: r.listedByTeammates }); return r; }
    if (name === "find_contact") { const found = await searchContacts(input.query, user); await logLookup(user, input.query, found.length); for (const ct of found.slice(0, 8)) cards.push({ type: "contact", contact: ct }); return { found: found.slice(0, 8), more: Math.max(0, found.length - 8) }; }
    if (name === "list_my_units") return listMyUnits(user);
    { const more = await runMore(name, input, user, extra.appUrl || ""); if (more) { if (/^(clients_list|requests_list|users_list|contacts_browse)$/.test(name)) await logLookup(user, name + " " + JSON.stringify(input).slice(0, 60), (more.total ?? (more.requests || more.contacts || []).length) || 0); return more; } }
    if (name === "compare_unit") { const r = await compareFor(user, input); if (!r.error && !r.noData) cards.push({ type: "compare", r }); return r; }
    if (name === "search_offers") { const l = await searchOffers(user, input); if (l.length && l.length <= 8) cards.push({ type: "offers", items: l }); return { count: l.length, offers: l }; }
    if (name === "three_options") { const r = await threeOptions(user, input); if (r.options.length) cards.push({ type: "offers", three: true, items: r.options }); return r; }
    if (name === "sales_offer") { const ids = (input.offer_ids || []).map(String).slice(0, 6); const all = await catalogue(user); const items = ids.map(id => all.find(o => o.id === id)).filter(Boolean);
      if (!items.length) return { error: "None of those offer ids exist. Use search_offers first." };
      cards.push({ type: "salesoffer", ids: items.map(o => o.id), client: txt(input.client_name, 80), items }); return { shown: true, homes: items.length, note: "The agent taps the button to open the sales offer, checks it and shares it." }; }
    if (name === "team_status") { if (!extra.teamStats) return { error: "Not available." }; const t = await extra.teamStats();
      return { goal: { target: t.goal.target, deadline: t.goal.deadline, platforms: t.goal.platforms.map(p => p.n) }, agents: t.agents.map(a => ({ name: a.name, pace: paceOf(a.online, t.goal), listings: a.listings, onlineEverywhere: a.online, partlyOnline: a.partly, offMarket: a.offMarket, forSale: a.forSale, forRent: a.forRent })) }; }
    if (name === "market_snapshot") return marketSnapshot(input.building, input.beds, input.deal);
    if (name === "prepare_listing") {
      const draft = cleanDraft(input, user);
      // Only the agent's own listing can be updated from a draft (the admin can update any).
      if (draft.listingId) { const { rows: [l] } = await q("select user_id from listings where id = $1", [draft.listingId]); if (!l || (!isAdmin(user) && l.user_id !== user.id)) draft.listingId = null; }
      cards.push({ type: "draft", draft }); return { shown: true, note: "The draft is on the agent's screen with a button to put it into the My units form. Don't repeat the description in chat; say what to check." }; }
    return { error: "Unknown tool." };
  };
  // What the CEO and the admin taught the assistant: after the fixed knowledge, cached too.
  const { rows: notes } = await q("select kind, title, text, by_name from ai_notes where active and kind <> 'quick' order by kind desc, id");
  const taught = notes.length ? "# Guidance from Orla's leadership (the CEO and Talal). Follow it; it overrides the general knowledge above when they differ.\n\n" +
    notes.map(n => `## ${n.kind === "rule" ? "Rule" : "Knowledge"}${n.title ? ": " + n.title : ""} (from ${n.by_name})\n${n.text}`).join("\n\n") : "";
  let text = "";
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await client.beta.messages.create({
      model: MODEL, max_tokens: 16000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      output_config: { effort: "medium" }, tools: TOOLS, messages,
      // The instructions and what it knows stay the same on every call, so they are cached; who's asking comes after.
      system: [{ type: "text", text: SYSTEM + "\n\n" + KNOWLEDGE, cache_control: { type: "ephemeral" } },
        ...(taught ? [{ type: "text", text: taught, cache_control: { type: "ephemeral" } }] : []), { type: "text", text: who }]
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
  if (/compar|analysis|dxb/i.test(last)) {
    const lid = last.match(/\b(l-[a-z0-9]+)\b/i), oid = last.match(/\b(p[1-5]-[a-z0-9-]+|s-[a-z0-9_-]+)/i), un = last.match(/\bunit\s*([a-z]?\d{2,5}[a-z]?)\b/i);
    let input = lid ? { listing_id: lid[1] } : oid ? { offer_id: oid[1] } : null;
    if (!input && un) { const f = await findUnit(user, un[1]); const u = (f.found || [])[0]; if (u) input = u.kind === "listing" ? { listing_id: u.id } : { offer_id: u.id }; }
    if (input) { const r = await compareFor(user, input);
      if (r.noData) return { reply: r.note, cards: [], offline: true };
      return { reply: `${r.label}: ${r.deals} registered ${r.kind === "rent" ? "leases" : "sales"} in the last ${r.months} months.`, cards: [{ type: "compare", r }], offline: true }; }
  }
  const req = last.toLowerCase().match(/\b(studio|[1-3]\s*-?\s*(?:bed|br|bedroom)s?)\b/);
  if (req && !/^\s*(unit|phone)\b/i.test(last)) {
    const beds = /studio/.test(req[1]) ? 0 : +req[1].match(/[1-3]/)[0], deal = /\brent|lease|tenant/i.test(last) ? "rent" : "sale";
    const mm = last.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*(m|million|k)?\b/gi) || [];
    let budget = null; for (const t of mm) { const x = t.match(/(\d+(?:\.\d+)?)\s*(m|million|k)?/i); let v = +x[1]; if (/m/i.test(x[2] || "")) v *= 1e6; else if (/k/i.test(x[2] || "")) v *= 1e3; if (v >= 20000) budget = v; }
    const r = await threeOptions(user, { beds, deal, budget_max: budget, building: null });
    if (r.options.length) return { reply: `Three ${TYPE[beds].toLowerCase()} options for ${deal === "rent" ? "rent" : "sale"}${budget ? " up to AED " + budget.toLocaleString("en-US") : ""}: premium, middle and value.`, cards: [{ type: "offers", three: true, items: r.options }], offline: true };
  }
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
    cards.push({ type: "draft", draft: { listingId: u.kind === "listing" ? u.id : null, unit: u.unit, b: u.b, beds: u.beds, deal: u.deal, price: u.price, rent: u.rent, size: u.size, floor: u.floor, view: u.view, status: u.status, furn: u.furnishing, tower: u.tower ? u.tower.slice(-1) : "", owner: u.owner, phone: u.ownerPhone, agent: user.agent_key || "", adTitle: t, adText: body,
      missing: ["Form A signed with the owner", "Title deed and owner's ID", "Trakheesi permit number", "Recent photos"], tips: [] } });
  }
  if (!u && people.length) return { reply: `Unit ${r.query} in the Peninsula contacts:`, cards, offline: true };
  return { reply: u ? `Found unit ${u.unit}. A starter listing is below. (The full AI writing turns on once the admin adds the AI key.)` : (r.note || "Not found."), cards, offline: true };
}
