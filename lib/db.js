// PostgreSQL connection. Works with any Postgres: Neon (Vercel Storage), your own server, Railway, etc.
import pg from "pg";

export const dbUrl = () => process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
let pool;

export function db() {
  if (!pool) {
    const url = dbUrl();
    const local = /host=\/|@(localhost|127\.0\.0\.1)[:/]/.test(url);
    const opts = { connectionString: url, max: 3, idleTimeoutMillis: 10000 };
    // Hosted databases need TLS. When the URL names an sslmode, it decides.
    if (!local && !/sslmode=/.test(url)) opts.ssl = { rejectUnauthorized: true };
    pool = new pg.Pool(opts);
  }
  return pool;
}

export const q = (text, params) => db().query(text, params);

export async function closeDb() {
  if (pool) { await pool.end(); pool = null; }
}
