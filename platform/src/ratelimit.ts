// A small per-caller request limit (fixed window, kept in memory of one instance). It stops a runaway script or a stolen
// token from hammering the admin API; normal use of the screens stays far below it.
export function makeLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key: string): boolean => {
    const t = now();
    const h = hits.get(key);
    if (!h || h.resetAt <= t) {
      if (hits.size > 5000) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
      hits.set(key, { count: 1, resetAt: t + windowMs });
      return true;
    }
    h.count += 1;
    return h.count <= max;
  };
}
