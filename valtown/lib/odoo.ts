// READ-ONLY Odoo client (JSON-RPC, Odoo 14-18). This file is the ONLY place that talks to Odoo.
// Safety by construction: only a fixed allow-list of read methods can be called. Anything that could create,
// change, delete, post or cancel a record (write, create, unlink, action_*, button_*, ...) throws before a request is made.
// Credentials (ODOO_URL, ODOO_DB, ODOO_LOGIN, ODOO_API_KEY or ODOO_PASSWORD) live only in Val Town's environment.
import { env, requireEnv } from "./env.ts";
import { errMsg, logger } from "./log.ts";

export const READ_ONLY_METHODS: ReadonlySet<string> = new Set(["search_read", "read", "search_count", "fields_get", "read_group", "search", "name_get"]);

export class OdooWriteBlockedError extends Error {
  constructor(method: string) {
    super(`Blocked: "${method}" is not a read-only Odoo method`);
    this.name = "OdooWriteBlockedError";
  }
}
export class OdooError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.retryable = retryable;
    this.name = "OdooError";
  }
}

export interface OdooConfig {
  url: string;
  db: string;
  login: string;
  secret: string; // API key (preferred) or password
}
export interface OdooDeps {
  f?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** minimum pause between two requests, to stay far below any hosting rate limit */
  minGapMs?: number;
  maxAttempts?: number;
}

export type Domain = (string | [string, string, unknown])[];
export interface SearchReadOpts { limit?: number; offset?: number; order?: string }

export interface OdooReader {
  searchRead(model: string, domain: Domain, fields: string[], opts?: SearchReadOpts): Promise<Record<string, any>[]>;
  searchCount(model: string, domain: Domain): Promise<number>;
  read(model: string, ids: number[], fields: string[]): Promise<Record<string, any>[]>;
  readGroup(model: string, domain: Domain, fields: string[], groupby: string[]): Promise<Record<string, any>[]>;
}

export function odooConfigFromEnv(): OdooConfig {
  return {
    url: requireEnv("ODOO_URL").replace(/\/+$/, ""),
    db: requireEnv("ODOO_DB"),
    login: env("ODOO_LOGIN") ?? requireEnv("ODOO_USER"),
    secret: env("ODOO_API_KEY") ?? requireEnv("ODOO_PASSWORD"),
  };
}
export const odooConfigured = () => Boolean(env("ODOO_URL") && env("ODOO_DB") && (env("ODOO_LOGIN") || env("ODOO_USER")) && (env("ODOO_API_KEY") || env("ODOO_PASSWORD")));

export class OdooClient implements OdooReader {
  private uid: number | undefined;
  private lastCall = 0;
  private f: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private minGap: number;
  private attempts: number;
  private cfg: OdooConfig;
  calls = 0;

  constructor(cfg: OdooConfig, deps: OdooDeps = {}) {
    this.cfg = cfg;
    this.f = deps.f ?? ((...a) => fetch(...a));
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.minGap = deps.minGapMs ?? 300;
    this.attempts = deps.maxAttempts ?? 4;
  }

  private async rpc(service: "common" | "object", method: string, args: unknown[]): Promise<any> {
    let last: unknown;
    for (let i = 0; i < this.attempts; i++) {
      const wait = this.minGap - (Date.now() - this.lastCall);
      if (wait > 0) await this.sleep(wait);
      this.lastCall = Date.now();
      this.calls++;
      try {
        const r = await this.f(`${this.cfg.url}/jsonrpc`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() }),
        });
        if (r.status === 429 || r.status >= 500) {
          const retryAfter = Number(r.headers.get("retry-after"));
          last = new OdooError(`HTTP ${r.status}`, true);
          await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 1000 * 2 ** i);
          continue;
        }
        if (!r.ok) throw new OdooError(`HTTP ${r.status}`);
        const j = (await r.json()) as { result?: unknown; error?: { data?: { message?: string }; message?: string } };
        if (j.error) throw new OdooError(j.error.data?.message ?? j.error.message ?? "Odoo error");
        return j.result;
      } catch (e) {
        if (e instanceof OdooError && !e.retryable) throw e;
        last = e;
        await this.sleep(1000 * 2 ** i);
      }
    }
    throw new OdooError(`Odoo request failed after ${this.attempts} attempts: ${errMsg(last)}`);
  }

  async authenticate(): Promise<number> {
    if (this.uid) return this.uid;
    const uid = await this.rpc("common", "authenticate", [this.cfg.db, this.cfg.login, this.cfg.secret, {}]);
    if (!uid || typeof uid !== "number") throw new OdooError("Odoo login failed (check ODOO_DB, ODOO_LOGIN and ODOO_API_KEY / ODOO_PASSWORD)");
    this.uid = uid;
    logger.info("odoo authenticated");
    return uid;
  }

  /** The single door to Odoo. Refuses anything that is not an allow-listed read. */
  async execute(model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}): Promise<any> {
    if (!READ_ONLY_METHODS.has(method)) throw new OdooWriteBlockedError(method);
    const uid = await this.authenticate();
    return this.rpc("object", "execute_kw", [this.cfg.db, uid, this.cfg.secret, model, method, args, kwargs]);
  }

  searchRead(model: string, domain: Domain, fields: string[], opts: SearchReadOpts = {}) {
    return this.execute(model, "search_read", [domain], { fields, limit: opts.limit ?? 200, offset: opts.offset ?? 0, order: opts.order ?? "id asc" });
  }
  searchCount(model: string, domain: Domain): Promise<number> {
    return this.execute(model, "search_count", [domain]);
  }
  read(model: string, ids: number[], fields: string[]) {
    return ids.length ? this.execute(model, "read", [ids], { fields }) : Promise.resolve([]);
  }
  readGroup(model: string, domain: Domain, fields: string[], groupby: string[]) {
    return this.execute(model, "read_group", [domain, fields, groupby], { lazy: false });
  }
}
