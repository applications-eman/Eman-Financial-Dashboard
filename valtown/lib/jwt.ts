// Verifies Supabase Auth access tokens. Supports HS256 (SUPABASE_JWT_SECRET) and asymmetric
// keys (ES256/RS256) via the project's JWKS endpoint. Returns claims or null; never throws.
import { createHmac, createPublicKey, verify as nodeVerify } from "node:crypto";
import { env } from "./env.ts";
import { safeEqual } from "./crypto.ts";

export interface Claims { sub: string; email?: string; role?: string; aud?: string | string[]; exp: number; iss?: string; [k: string]: unknown }

const b64u = (s: string) => Buffer.from(s, "base64url");
let jwksCache: { at: number; keys: any[] } | undefined;

async function jwks(f: typeof fetch): Promise<any[]> {
  if (jwksCache && Date.now() - jwksCache.at < 10 * 60_000) return jwksCache.keys;
  const url = `${env("SUPABASE_URL")?.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`;
  const r = await f(url);
  if (!r.ok) return [];
  const { keys } = (await r.json()) as { keys: any[] };
  jwksCache = { at: Date.now(), keys };
  return keys;
}
export const clearJwksCache = () => { jwksCache = undefined; };

export async function verifySupabaseJwt(token: string, opts: { secret?: string; f?: typeof fetch; now?: number } = {}): Promise<Claims | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = JSON.parse(b64u(parts[0]).toString());
    const signingInput = `${parts[0]}.${parts[1]}`;
    const sig = b64u(parts[2]);
    let valid = false;
    if (header.alg === "HS256") {
      const secret = opts.secret ?? env("SUPABASE_JWT_SECRET");
      if (!secret) return null;
      const expect = createHmac("sha256", secret).update(signingInput).digest();
      valid = safeEqual(expect.toString("hex"), sig.toString("hex"));
    } else if (header.alg === "ES256" || header.alg === "RS256") {
      const keys = await jwks(opts.f ?? fetch);
      const jwk = keys.find((k) => k.kid === header.kid) ?? (keys.length === 1 ? keys[0] : undefined);
      if (!jwk) return null;
      const key = createPublicKey({ key: jwk, format: "jwk" });
      valid = header.alg === "ES256"
        ? nodeVerify("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" }, sig)
        : nodeVerify("sha256", Buffer.from(signingInput), key, sig);
    } else return null;
    if (!valid) return null;
    const claims = JSON.parse(b64u(parts[1]).toString()) as Claims;
    const now = Math.floor((opts.now ?? Date.now()) / 1000);
    if (typeof claims.exp !== "number" || claims.exp < now) return null;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes("authenticated")) return null;
    const base = env("SUPABASE_URL")?.replace(/\/$/, "");
    if (base && claims.iss && claims.iss !== `${base}/auth/v1`) return null;
    if (!claims.sub) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Test helper */
export function signHs256(claims: Record<string, unknown>, secret: string): string {
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${h}.${p}.${createHmac("sha256", `${secret}`).update(`${h}.${p}`).digest("base64url")}`;
}
