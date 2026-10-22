import { PGlite } from "@electric-sql/pglite";

import type { Db, Row } from "./db.ts";
import { readFileSync } from "node:fs";

/** In-process Postgres running the real migration files. Tests only. */
export async function testDb(): Promise<Db> {
  const pg = new PGlite();
  for (const f of ["0001_core.sql", "0002_admins.sql", "0003_invoicing.sql", "0004_default_service.sql"])
    await pg.exec(readFileSync(new URL(`../db/${f}`, import.meta.url), "utf8"));
  const wrap = (q: { query: PGlite["query"] }): Db => ({
    query: async <T = Row>(sql: string, params: unknown[] = []) => (await q.query(sql, params)).rows as T[],
    tx: async (fn) => pg.transaction((t) => fn(wrap(t as unknown as { query: PGlite["query"] }))),
  });
  return wrap(pg);
}
