import { PGlite } from "@electric-sql/pglite";

import type { Db } from "./db.ts";
import { readFileSync } from "node:fs";

/** In-process Postgres running the real migration files. Tests only. */
export async function testDb(): Promise<Db> {
  const pg = new PGlite();
  for (const f of ["0001_core.sql", "0002_admins.sql"])
    await pg.exec(readFileSync(new URL(`../db/${f}`, import.meta.url), "utf8"));
  const wrap = (q: { query: PGlite["query"] }): Db => ({
    query: async (sql, params = []) => (await q.query(sql, params)).rows as any[],
    tx: async (fn) => pg.transaction((t) => fn(wrap(t as unknown as { query: PGlite["query"] }))),
  });
  return wrap(pg);
}
