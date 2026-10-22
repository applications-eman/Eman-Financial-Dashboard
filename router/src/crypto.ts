import { createHmac, timingSafeEqual } from "node:crypto";

export const hmacHex = (secret: string, data: string | Uint8Array) =>
  createHmac("sha256", secret).update(data).digest("hex");

/** Meta signs the RAW body: header "X-Hub-Signature-256: sha256=<hex>". */
export function verifyMetaSignature(raw: Uint8Array, header: string | null | undefined, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const [scheme, sig] = header.split("=");
  if (scheme !== "sha256" || !sig) return false;
  const a = Buffer.from(sig.toLowerCase());
  const b = Buffer.from(hmacHex(appSecret, raw));
  return a.length === b.length && timingSafeEqual(a, b);
}

export const signBody = (raw: Uint8Array | string, appSecret: string) => `sha256=${hmacHex(appSecret, raw)}`;
