// Trusts the dashboard sign-in (a Supabase Auth token from the EXISTING project) and decides what the person may do here.

import type { Db } from "./db.ts";
import { createHmac, createPublicKey, verify as nodeVerify, timingSafeEqual } from "node:crypto";

export interface Claims {
  sub: string;
  email?: string;
  exp: number;
  aud?: string | string[];
  iss?: string;
}
export type Role = "admin" | "supervisor" | "accountant";
export interface Actor {
  email: string;
  role: Role;
}

export interface AuthCfg {
  /** project URL of the dashboard's sign-in (used for the issuer check and its public keys) */
  issuerBase: string;
  /** only for projects that still sign tokens with a shared secret (HS256) */
  jwtSecret?: string;
  fetch: typeof fetch;
}

const b64u = (s: string) => Buffer.from(s, "base64url");
type Jwk = JsonWebKey & { kid?: string };
let jwksCache: { at: number; base: string; keys: Jwk[] } | undefined;

async function jwks(cfg: AuthCfg): Promise<Jwk[]> {
  if (jwksCache && jwksCache.base === cfg.issuerBase && Date.now() - jwksCache.at < 10 * 60_000) return jwksCache.keys;
  const r = await cfg.fetch(`${cfg.issuerBase}/auth/v1/.well-known/jwks.json`);
  if (!r.ok) return [];
  const { keys } = (await r.json()) as { keys: Jwk[] };
  jwksCache = { at: Date.now(), base: cfg.issuerBase, keys };
  return keys;
}

export async function verifyToken(token: string, cfg: AuthCfg, now = Date.now()): Promise<Claims | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = JSON.parse(b64u(parts[0]).toString());
    const input = `${parts[0]}.${parts[1]}`;
    const sig = b64u(parts[2]);
    let valid = false;
    if (header.alg === "HS256") {
      if (!cfg.jwtSecret) return null;
      const expect = createHmac("sha256", cfg.jwtSecret).update(input).digest();
      valid = expect.length === sig.length && timingSafeEqual(expect, sig);
    } else if (header.alg === "ES256" || header.alg === "RS256") {
      const keys = await jwks(cfg);
      const jwk = keys.find((k) => k.kid === header.kid) ?? (keys.length === 1 ? keys[0] : undefined);
      if (!jwk) return null;
      const key = createPublicKey({ key: jwk, format: "jwk" });
      valid =
        header.alg === "ES256"
          ? nodeVerify("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }, sig)
          : nodeVerify("sha256", Buffer.from(input), key, sig);
    } else return null;
    if (!valid) return null;
    const claims = JSON.parse(b64u(parts[1]).toString()) as Claims;
    if (typeof claims.exp !== "number" || claims.exp < Math.floor(now / 1000)) return null;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes("authenticated")) return null;
    if (claims.iss !== `${cfg.issuerBase}/auth/v1`) return null;
    return claims.sub ? claims : null;
  } catch {
    return null;
  }
}

/** The person must be listed (and active) in platform_admins. Matched by dashboard user id, else by e-mail. */
export async function actorFor(db: Db, claims: Claims): Promise<Actor | null> {
  const rows = await db.query<{ email: string; role: Role }>(
    `select email, role from platform_admins where active and (auth_user_id = $1 or ($2::text is not null and lower(email) = lower($2))) order by (auth_user_id = $1) desc nulls last limit 1`,
    [claims.sub, claims.email ?? null],
  );
  return rows[0] ?? null;
}

export const canWrite = (r: Role) => r === "admin";
export const canDecideApprovals = (r: Role) => r === "admin" || r === "supervisor";

/** test helper */
export function signHs256(claims: Record<string, unknown>, secret: string): string {
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${h}.${p}.${createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")}`;
}
