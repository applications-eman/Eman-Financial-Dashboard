import { createHash, createHmac, randomBytes, timingSafeEqual as nodeTse } from "node:crypto";

export const sha256Hex = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
export const hmacHex = (key: string, data: string | Uint8Array) => createHmac("sha256", key).update(data).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && nodeTse(ba, bb);
}

/** Meta webhooks: header "X-Hub-Signature-256: sha256=<hex>" over the RAW request body. */
export function verifyMetaSignature(rawBody: string | Uint8Array, header: string | null | undefined, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const [scheme, sig] = header.split("=");
  if (scheme !== "sha256" || !sig) return false;
  return safeEqual(sig.toLowerCase(), hmacHex(appSecret, rawBody));
}

/** Shortcut tokens: 256-bit random, only the SHA-256 hash is stored. */
export function generateToken(): { token: string; hash: string } {
  const token = `eb_${randomBytes(32).toString("base64url")}`;
  return { token, hash: sha256Hex(token) };
}
export const hashToken = (t: string) => sha256Hex(t);

/** Signed, expiring flow tokens bind a WhatsApp Flow session to a phone number. */
export function makeFlowToken(phone: string, secret: string, ttlSec = 3600, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + ttlSec;
  const body = `${phone.replace(/\D/g, "")}.${exp}`;
  return `${body}.${hmacHex(secret, `flow:${body}`).slice(0, 32)}`;
}
export function readFlowToken(token: string, secret: string, now = Date.now()): { phone: string } | null {
  const [phone, exp, sig] = (token ?? "").split(".");
  if (!phone || !exp || !sig) return null;
  if (!safeEqual(sig, hmacHex(secret, `flow:${phone}.${exp}`).slice(0, 32))) return null;
  if (Number(exp) * 1000 < now) return null;
  return { phone: `+${phone}` };
}
