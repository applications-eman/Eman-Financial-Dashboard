// Fixed-window in-memory limiter (per isolate). Good enough to blunt token brute force and webhook floods;
// Supabase constraints + idempotency keys remain the real guarantee.
const buckets = new Map<string, { n: number; reset: number }>();

export function rateLimit(key: string, max: number, windowMs: number, now = Date.now()): { ok: boolean; retryAfterSec: number } {
  if (buckets.size > 5000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
  const b = buckets.get(key);
  if (!b || b.reset < now) {
    buckets.set(key, { n: 1, reset: now + windowMs });
    return { ok: true, retryAfterSec: 0 };
  }
  b.n++;
  return { ok: b.n <= max, retryAfterSec: Math.ceil((b.reset - now) / 1000) };
}
export const resetRateLimits = () => buckets.clear();
