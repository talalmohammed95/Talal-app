// Creates the tables if they don't exist yet and loads the starting offers into an empty database.
// Runs during every Vercel build and once per server start. Safe to run again.
import { q } from "./db.js";
import { OFFERS, SETTINGS } from "./seed.js";
import { UPDATES, NEW, PHONES, PLATFORMS } from "./teamsplit.js";

const SCHEMA = `
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null default '',
  pass_hash text not null,
  role text not null default 'agent' check (role in ('admin', 'agent')),
  status text not null default 'pending' check (status in ('pending', 'active', 'blocked')),
  email_verified boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists users_only_one_admin on users (role) where role = 'admin';

create table if not exists sessions (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists sessions_user on sessions (user_id);

create table if not exists tokens (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('verify', 'reset')),
  expires_at timestamptz not null,
  used boolean not null default false
);

create table if not exists offers (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null
);
create table if not exists settings (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists activity (
  id bigserial primary key,
  at timestamptz not null default now(),
  by_user uuid references users(id) on delete set null,
  by_email text,
  text text not null
);
create table if not exists user_state (
  user_id uuid primary key references users(id) on delete cascade,
  data jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
alter table offers add column if not exists created_at timestamptz not null default now();
create table if not exists offer_history (
  id bigserial primary key,
  offer_id text not null,
  at timestamptz not null default now(),
  by_email text,
  kind text not null,
  old_value text,
  new_value text,
  title text
);
create index if not exists offer_history_recent on offer_history (at desc);
-- Who an account belongs to: admin, agent (Orla team), ceo (sees the team, can't change anything), broker (agent at another agency), client (buyer or tenant).
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'users_role_check' and pg_get_constraintdef(oid) like '%ceo%') then
    alter table users drop constraint if exists users_role_check;
    alter table users add constraint users_role_check check (role in ('admin', 'agent', 'ceo', 'broker', 'client'));
  end if;
end $$;
alter table users add column if not exists company text not null default '';
alter table users add column if not exists phone text not null default '';
-- Which agent name on the offers (settings.agents key) this account is. Owner contacts are shown only to that agent.
alter table users add column if not exists agent_key text not null default '';
alter table users add column if not exists invited_by uuid references users(id) on delete set null;
-- Photos and floor plans the admin uploads for offers.
create table if not exists media (
  id uuid primary key default gen_random_uuid(),
  mime text not null,
  data bytea not null,
  by_user uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
-- Agents' own units, with owners' details: only the agent who added one and the admin can read it.
create table if not exists listings (
  id text primary key,
  user_id uuid not null references users(id) on delete cascade,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists listings_user on listings (user_id);
-- Viewing and information requests from clients and external agents, for the listing agent.
create table if not exists leads (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id uuid references users(id) on delete cascade,
  offer_id text not null,
  agent_key text not null default '',
  kind text not null check (kind in ('viewing', 'details')),
  title text,
  done boolean not null default false
);
create index if not exists leads_agent on leads (agent_key, at desc);
-- The team's documents library: brochures, floor plans, price lists. Files are stored in 2 MB parts.
create table if not exists docs (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  building int,
  kind text not null default 'other',
  beds int,
  mime text,
  size bigint not null default 0,
  parts int not null default 0,
  url text,
  by_user uuid references users(id) on delete set null,
  by_name text,
  created_at timestamptz not null default now()
);
create table if not exists doc_parts (
  doc_id uuid not null references docs(id) on delete cascade,
  idx int not null,
  data bytea not null,
  primary key (doc_id, idx)
);
-- The Peninsula contacts database (owners, tenants, buyers), imported by the admin from Excel or CSV.
-- phone_keys holds the last 9 digits of each phone, so 050…, +971 50… and 97150… all match.
create table if not exists contacts (
  id bigserial primary key,
  name text not null default '',
  phones text[] not null default '{}',
  phone_keys text[] not null default '{}',
  email text not null default '',
  building int,
  unit text not null default '',
  unit_key text not null default '',
  data jsonb not null default '{}',
  imported_at timestamptz not null default now()
);
create index if not exists contacts_phone_keys on contacts using gin (phone_keys);
create index if not exists contacts_unit_key on contacts (unit_key);
-- Registered deals in the Peninsula (sales and rents), imported by the admin from DXB Interact or DLD exports.
create table if not exists market_deals (
  id bigserial primary key,
  kind text not null check (kind in ('sale', 'rent')),
  deal_date date,
  building int not null,
  tower text not null default '',
  beds int,
  layout text not null default '',
  size numeric,
  price numeric not null,
  floor text not null default '',
  source text not null default '',
  imported_at timestamptz not null default now()
);
create index if not exists market_deals_find on market_deals (building, kind, beds, deal_date desc);
-- The team chat: the admin, the agents and the CEO.
create table if not exists team_chat (
  id bigserial primary key,
  user_id uuid references users(id) on delete set null,
  name text not null default '',
  role text not null default '',
  text text not null,
  at timestamptz not null default now(),
  deleted boolean not null default false
);
create table if not exists throttle (
  key text primary key,
  count int not null,
  reset_at timestamptz not null
);
`;

// Expired sessions, sign-up links and rate-limit counters are cleared out.
const HOUSEKEEPING = [
  "sessions where expires_at < now()",
  "tokens where expires_at < now()",
  "throttle where reset_at < now()"
].map(t => "DELETE FROM " + t).join(";\n");

export async function migrate() {
  await q(SCHEMA);
  await q("insert into settings (id, data) values ('app', $1) on conflict (id) do nothing", [SETTINGS]);
  // Once: add Derya and Love to an agent list saved before they joined, keeping every agent already there.
  await q(`update settings set data = jsonb_set(data, '{agents}', $1::jsonb || coalesce(data->'agents', '{}'::jsonb)) || '{"agentsAddedDeryaLove": true}'::jsonb
           where id = 'app' and not (data ? 'agentsAddedDeryaLove')`,
    [JSON.stringify({ derya: SETTINGS.agents.derya, love: SETTINGS.agents.love })]);
  const { rows } = await q("select count(*)::int as n from offers");
  let seeded = 0;
  if (rows[0].n === 0) {
    for (const o of OFFERS) {
      const { id, ...data } = o;
      await q("insert into offers (id, data) values ($1, $2) on conflict (id) do nothing", [id, data]);
      seeded++;
    }
  }
  // Once: the Peninsula Four 2 bed (canal view) is Blendjana's listing (her flyer), not Talal's.
  await q(`update offers set data = jsonb_set(data, '{agent}', '"blendjana"') where id = 'p4-2bed-1453' and data->>'agent' = 'talal'
           and not exists (select 1 from settings where id = 'app' and data ? 'movedP4ToBlendjana')`);
  await q(`update settings set data = data || '{"movedP4ToBlendjana": true}'::jsonb where id = 'app' and not (data ? 'movedP4ToBlendjana')`);
  // Once: the team's units from the 20–26 Nov performance report. They count in team performance (teamUnit);
  // other offers stay on the site but don't count. Platforms become Bayut and Property Finder.
  const { rows: [done] } = await q("select (data ? 'teamSplit20Nov') as d from settings where id = 'app'");
  if (done && !done.d) {
    for (const [id, patch] of Object.entries(UPDATES))
      await q("update offers set data = data || $2::jsonb where id = $1", [id, JSON.stringify({ ...patch, teamUnit: true })]);
    for (const [id, data] of Object.entries(NEW))
      await q("insert into offers (id, data, created_at) values ($1, $2, '2026-11-20') on conflict (id) do nothing", [id, { ...data, teamUnit: true }]);
    await q(`update settings set data = jsonb_set(jsonb_set(data, '{goal}', coalesce(data->'goal', $1::jsonb) || jsonb_build_object('platforms', $2::jsonb, 'start', '2026-11-20')),
             '{agents}', coalesce(data->'agents', '{}'::jsonb)) || '{"teamSplit20Nov": true}'::jsonb where id = 'app'`,
      [JSON.stringify(SETTINGS.goal), JSON.stringify(PLATFORMS)]);
    for (const [k, phone] of Object.entries(PHONES))
      await q(`update settings set data = jsonb_set(data, array['agents', $1, 'phone'], to_jsonb($2::text)) where id = 'app' and data->'agents' ? $1 and coalesce(data->'agents'->$1->>'phone', '') = ''`, [k, phone]);
  }
  // Tower A / B: units whose floor says "· Tower A" get it as its own field (the floor keeps just the floor).
  for (const t of ["offers", "listings"])
    await q(`update ${t} set data = data || jsonb_build_object('tower', upper(substring(lower(data->>'floor') from 'tower\\s*([ab])\\M')),
               'floor', btrim(regexp_replace(data->>'floor', '\\s*[·,-]?\\s*tower\\s*[ab]\\M', '', 'i')))
             where not (data ? 'tower') and data->>'floor' ~* 'tower\\s*[ab]\\M'`);
  // Only Peninsula Four has two towers: a tower set on another building is removed.
  for (const t of ["offers", "listings"]) await q(`update ${t} set data = data - 'tower' where data ? 'tower' and coalesce(data->>'b', '') <> '4'`);
  // Peninsula One's podium homes are simplexes.
  await q(`update offers set data = data || '{"layout": "simplex"}'::jsonb where data->>'b' = '1' and data->>'floor' ilike '%podium%' and not (data ? 'layout')`);
  await q(HOUSEKEEPING);
  return { seeded };
}

let ready = null;
export function ensureSchema() {
  if (!ready) ready = migrate().catch(e => { ready = null; throw e; });
  return ready;
}
