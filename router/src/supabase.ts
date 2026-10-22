import type { NumberRoute, Registry, SeenStore, Target } from "./types.ts";

export interface SupabaseCfg {
  url: string; // https://<ref>.supabase.co
  serviceKey: string;
  fetch: typeof fetch;
}

// Older keys are JWTs (eyJ...) and are also sent as "Authorization: Bearer". Newer "secret" keys (sb_secret_...) are not JWTs:
// they go in the apikey header only.
const headers = (c: SupabaseCfg, extra: Record<string, string> = {}) => ({
  apikey: c.serviceKey,
  ...(c.serviceKey.startsWith("sb_") ? {} : { authorization: `Bearer ${c.serviceKey}` }),
  "content-type": "application/json",
  ...extra,
});

/**
 * Reads the two lists from the platform database. Keeps the last good copy: if the database is briefly
 * unreachable the router keeps routing with it (up to `maxStaleMs`) instead of dropping everybody.
 */
export class SupabaseRegistry implements Registry {
  private cfg: SupabaseCfg;
  private ttl: number;
  private maxStale: number;
  private cache: { at: number; targets: Target[]; routes: NumberRoute[] } | null = null;
  private inflight: Promise<void> | null = null;

  constructor(cfg: SupabaseCfg, ttlMs = 30_000, maxStaleMs = 24 * 3600_000) {
    this.cfg = cfg;
    this.ttl = ttlMs;
    this.maxStale = maxStaleMs;
  }

  private async load(): Promise<void> {
    const get = async (path: string) => {
      const r = await this.cfg.fetch(`${this.cfg.url}/rest/v1/${path}`, { headers: headers(this.cfg) });
      if (!r.ok) throw new Error(`registry read failed: ${r.status}`);
      return (await r.json()) as Record<string, unknown>[];
    };
    const [t, n] = await Promise.all([
      get("wa_targets?select=id,name,url,secret,enabled,is_default"),
      get("wa_numbers?select=phone,target_id,enabled"),
    ]);
    this.cache = {
      at: Date.now(),
      targets: t.map((x) => ({
        id: String(x.id),
        name: String(x.name),
        url: String(x.url),
        secret: x.secret ? String(x.secret) : undefined,
        enabled: x.enabled !== false,
        isDefault: x.is_default === true,
      })),
      routes: n.map((x) => ({ phone: String(x.phone), targetId: String(x.target_id), enabled: x.enabled !== false })),
    };
  }

  private async fresh(): Promise<NonNullable<SupabaseRegistry["cache"]>> {
    const age = this.cache ? Date.now() - this.cache.at : Infinity;
    if (age > this.ttl) {
      this.inflight ??= this.load().finally(() => {
        this.inflight = null;
      });
      try {
        await this.inflight;
      } catch (e) {
        if (!this.cache || Date.now() - this.cache.at > this.maxStale) throw e;
      }
    }
    return this.cache as NonNullable<SupabaseRegistry["cache"]>;
  }

  async targets() {
    return (await this.fresh()).targets;
  }
  async routes() {
    return (await this.fresh()).routes;
  }
}

/** Duplicate guard in the database, so it works across several router instances and restarts. */
export class SupabaseSeenStore implements SeenStore {
  private cfg: SupabaseCfg;
  constructor(cfg: SupabaseCfg) {
    this.cfg = cfg;
  }

  async seen(id: string): Promise<boolean> {
    // inserting an id that exists returns an empty list (ignore-duplicates) => it was seen before
    const r = await this.cfg.fetch(`${this.cfg.url}/rest/v1/wa_messages_seen?on_conflict=message_id`, {
      method: "POST",
      headers: headers(this.cfg, { prefer: "resolution=ignore-duplicates,return=representation" }),
      body: JSON.stringify({ message_id: id }),
    });
    if (!r.ok) throw new Error(`seen-store write failed: ${r.status}`);
    const rows = (await r.json()) as unknown[];
    return rows.length === 0;
  }

  async forget(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const list = ids.map((i) => `"${i.replace(/"/g, "")}"`).join(",");
    await this.cfg.fetch(`${this.cfg.url}/rest/v1/wa_messages_seen?message_id=in.(${encodeURIComponent(list)})`, {
      method: "DELETE",
      headers: headers(this.cfg),
    });
  }
}
