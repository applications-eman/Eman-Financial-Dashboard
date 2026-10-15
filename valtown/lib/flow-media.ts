// Decrypts media uploaded through a Flow PhotoPicker (WhatsApp media encryption):
// file = AES-256-CBC(ciphertext) || 10-byte HMAC-SHA256(iv || ciphertext, hmac_key); key material comes
// from the data-exchange payload's encryption_metadata.
import { createDecipheriv, createHash, createHmac, createCipheriv, randomBytes } from "node:crypto";
import { safeEqual } from "./crypto.ts";

export interface FlowMedia {
  cdn_url: string;
  file_name?: string;
  mime_type?: string;
  encryption_metadata: { encryption_key: string; hmac_key?: string; hmac?: string; iv: string; plaintext_hash: string; encrypted_hash: string };
}

export function decryptFlowMedia(encrypted: Uint8Array, meta: FlowMedia["encryption_metadata"]): Uint8Array {
  const buf = Buffer.from(encrypted);
  if (createHash("sha256").update(buf).digest("base64") !== meta.encrypted_hash) throw new Error("encrypted hash mismatch");
  const key = Buffer.from(meta.encryption_key, "base64");
  const iv = Buffer.from(meta.iv, "base64");
  const cipherText = buf.subarray(0, buf.length - 10);
  const mac = buf.subarray(buf.length - 10);
  const hmacKey = Buffer.from(meta.hmac_key ?? meta.encryption_key, "base64");
  const expected = createHmac("sha256", hmacKey).update(iv).update(cipherText).digest().subarray(0, 10);
  if (!safeEqual(expected.toString("hex"), mac.toString("hex"))) throw new Error("media HMAC mismatch");
  const d = createDecipheriv("aes-256-cbc", key, iv);
  const plain = Buffer.concat([d.update(cipherText), d.final()]);
  if (createHash("sha256").update(plain).digest("base64") !== meta.plaintext_hash) throw new Error("plaintext hash mismatch");
  return plain;
}

/** Test helper: produce encrypted media + metadata the same way WhatsApp does. */
export function encryptFlowMediaForTest(plain: Uint8Array): { data: Uint8Array; meta: FlowMedia["encryption_metadata"] } {
  const key = randomBytes(32), hmacKey = randomBytes(32), iv = randomBytes(16);
  const c = createCipheriv("aes-256-cbc", key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const mac = createHmac("sha256", hmacKey).update(iv).update(ct).digest().subarray(0, 10);
  const data = Buffer.concat([ct, mac]);
  return {
    data,
    meta: {
      encryption_key: key.toString("base64"), hmac_key: hmacKey.toString("base64"), iv: iv.toString("base64"),
      plaintext_hash: createHash("sha256").update(plain).digest("base64"),
      encrypted_hash: createHash("sha256").update(data).digest("base64"),
    },
  };
}
