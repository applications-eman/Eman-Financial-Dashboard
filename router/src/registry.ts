import { isSafeTargetUrl } from "./ssrf.ts";
import type { NumberRoute, Registry, SeenStore, Target } from "./types.ts";

export class MemoryRegistry implements Registry {
  private t: Target[];
  private r: NumberRoute[];
  constructor(t: Target[], r: NumberRoute[]) {
    this.t = t;
    this.r = r;
  }
  async targets() {
    return this.t;
  }
  async routes() {
    return this.r;
  }
}

/**
 * First version: the list comes from one secret (ROUTER_REGISTRY_JSON). Later the admin screen manages the same
 * two lists in a database and this class is replaced; the router code does not change.
 *   {"targets":[{"id":"expense","name":"Expense capture","url":"https://...","secret":"...","enabled":true}],
 *    "numbers":[{"phone":"966501234567","target":"expense"}]}
 */
export function registryFromJson(json: string): Registry {
  const raw = JSON.parse(json) as {
    targets?: (Partial<Target> & { default?: boolean })[];
    numbers?: { phone?: string; target?: string }[];
  };
  const targets: Target[] = (raw.targets ?? []).map((t) => {
    if (!t.id || !t.url || !isSafeTargetUrl(t.url)) throw new Error(`unsafe or incomplete target: ${t.id ?? "?"}`);
    return {
      id: t.id,
      name: t.name ?? t.id,
      url: t.url,
      secret: t.secret,
      enabled: t.enabled !== false,
      isDefault: t.default === true || t.isDefault === true,
    };
  });
  const ids = new Set(targets.map((t) => t.id));
  const seen = new Set<string>();
  const routes: NumberRoute[] = (raw.numbers ?? []).map((n) => {
    const phone = String(n.phone ?? "").replace(/\D/g, "");
    if (!phone || !n.target || !ids.has(n.target)) throw new Error(`bad number entry: ${n.phone ?? "?"}`);
    if (seen.has(phone)) throw new Error(`number listed twice (one number can belong to one service only): ${phone}`);
    seen.add(phone);
    return { phone, targetId: n.target };
  });
  return new MemoryRegistry(targets, routes);
}

/** In-memory duplicate guard. A database-backed one replaces it for several instances. */
export class MemorySeenStore implements SeenStore {
  private m = new Map<string, number>();
  private ttl: number;
  constructor(ttlMs = 10 * 60_000) {
    this.ttl = ttlMs;
  }
  async seen(id: string) {
    const now = Date.now();
    for (const [k, t] of this.m) if (now - t > this.ttl) this.m.delete(k);
    if (this.m.has(id)) return true;
    this.m.set(id, now);
    return false;
  }
  async forget(ids: string[]) {
    for (const id of ids) this.m.delete(id);
  }
}
