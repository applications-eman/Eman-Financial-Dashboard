// WhatsApp Flows data-endpoint encryption (Meta contract):
//  request  = { encrypted_flow_data, encrypted_aes_key, initial_vector } (all base64)
//  AES key  = RSA-2048 OAEP (SHA-256 for hash and MGF1) unwrap with our private key
//  payload  = AES-128-GCM, 16-byte tag appended to the ciphertext
//  response = AES-128-GCM with the IV bit-flipped, returned as a base64 text body
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  type KeyObject,
  privateDecrypt,
} from "node:crypto";

export interface FlowEnvelope {
  encrypted_flow_data: string;
  encrypted_aes_key: string;
  initial_vector: string;
}
export interface DecryptedFlowRequest {
  body: Record<string, unknown>;
  aesKey: Buffer;
  iv: Buffer;
}
export class FlowDecryptError extends Error {}

/**
 * Reads a PEM private key however it was stored: real line breaks, or one line with "\n" typed out (also doubled,
 * as environment variable editors often do), with or without surrounding quotes, with or without a passphrase.
 */
export function normalizePem(raw: string): string {
  let s = raw.trim();
  if (s.length > 1 && (s.startsWith('"') || s.startsWith("'")) && s.endsWith(s[0])) s = s.slice(1, -1);
  return `${s
    .replace(/\\+r?\\*n/g, "\n")
    .replace(/\r\n/g, "\n")
    .trim()}\n`;
}

export function loadPrivateKey(pem: string, passphrase?: string): KeyObject {
  const pass = passphrase?.trim() ?? "";
  try {
    return createPrivateKey({ key: normalizePem(pem), ...(pass === "" ? {} : { passphrase: pass }) });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    // say what is actually wrong instead of an OpenSSL code
    if (/interrupted or cancelled/i.test(m))
      throw new Error(
        "the Flow key is protected by a passphrase, but none was given (FLOW_PRIVATE_KEY_PASSPHRASE is empty or missing)",
      );
    if (/bad decrypt/i.test(m))
      throw new Error(`the Flow key passphrase does not match the key (passphrase length ${pass.length})`);
    throw new Error(`the Flow key could not be read: ${m}`);
  }
}
