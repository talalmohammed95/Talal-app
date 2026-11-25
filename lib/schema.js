// Creates the tables if they don't exist yet and loads the starting offers into an empty database.
// Runs during every Vercel build and once per server start. Safe to run again.
import { q } from "./db.js";
import { OFFERS, SETTINGS } from "./seed.js";

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
-- Who an account belongs to: admin, agent (Orla team), broker (agent at another agency), client (buyer or tenant).
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'users_role_check' and pg_get_constraintdef(oid) like '%broker%') then
    alter table users drop constraint if exists users_role_check;
    alter table users add constraint users_role_check check (role in ('admin', 'agent', 'broker', 'client'));
  end if;
end $$;
alter table users add column if not exists company text not null default '';
alter table users add column if not exists phone text not null default '';
-- Which agent name on the offers (settings.agents key) this account is. Owner contacts are shown only to that agent.
alter table users add column if not exists agent_key text not null default '';
-- Photos and floor plans the admin uploads for offers.
create table if not exists media (
  id uuid primary key default gen_random_uuid(),
  mime text not null,
  data bytea not null,
  by_user uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
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
  const { rows } = await q("select count(*)::int as n from offers");
  let seeded = 0;
  if (rows[0].n === 0) {
    for (const o of OFFERS) {
      const { id, ...data } = o;
      await q("insert into offers (id, data) values ($1, $2) on conflict (id) do nothing", [id, data]);
      seeded++;
    }
  }
  await q(HOUSEKEEPING);
  return { seeded };
}

let ready = null;
export function ensureSchema() {
  if (!ready) ready = migrate().catch(e => { ready = null; throw e; });
  return ready;
}
