import pg from "pg";

/** The only way the service talks to Postgres. Production: a pooled connection. Tests: an in-process Postgres. */
export interface Db {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** all-or-nothing group of statements */
  tx<T>(fn: (t: Db) => Promise<T>): Promise<T>;
}

export class PgDb implements Db {
  private pool: pg.Pool;
  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 20_000,
      ssl: { rejectUnauthorized: false },
    });
  }
  async query<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query(sql, params as any[])).rows as T[];
  }
  async tx<T>(fn: (t: Db) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    const inner: Db = {
      query: async <R = Record<string, any>>(sql: string, params: unknown[] = []) =>
        (await c.query(sql, params as any[])).rows as R[],
      tx: (f) => f(inner), // already inside a transaction
    };
    try {
      await c.query("begin");
      const out = await fn(inner);
      await c.query("commit");
      return out;
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
}
