import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";

export type Db = pg.Pool;
export type Q = pg.Pool | pg.PoolClient;

// bigint and numeric come back as JS numbers: all values here are small cent counts.
const types = {
  getTypeParser: (oid: number, format?: "text" | "binary") =>
    oid === 20 || oid === 1700 ? (s: string) => Number(s) : pg.types.getTypeParser(oid, format as "text"),
} as pg.CustomTypesConfig;

/** `schema` pins search_path, so tests can isolate per file. */
export function createPool(connectionString: string, schema?: string): Db {
  return new pg.Pool({
    connectionString,
    types,
    max: 20,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });
}

export async function tx<T>(db: Db, fn: (c: pg.PoolClient) => Promise<T>, isolation?: string): Promise<T> {
  const c = await db.connect();
  try {
    await c.query(isolation ? `begin isolation level ${isolation}` : "begin");
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string })?.code === "23505";
}

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

export async function migrate(db: Db): Promise<string[]> {
  await db.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const done = new Set((await db.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const f of readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    await tx(db, async (c) => {
      await c.query("select pg_advisory_xact_lock(hashtext('mint_migrate'))");
      if ((await c.query("select 1 from schema_migrations where name = $1", [f])).rowCount) return;
      await c.query(readFileSync(new URL(f, MIGRATIONS_DIR), "utf8"));
      await c.query("insert into schema_migrations (name) values ($1)", [f]);
    });
    applied.push(f);
  }
  return applied;
}
