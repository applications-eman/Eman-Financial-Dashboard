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

export function loadPrivateKey(pem: string, passphrase?: string): KeyObject {
  const normalized = pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
  return createPrivateKey({ key: normalized, ...(passphrase ? { passphrase } : {}) });
}

export function decryptFlowRequest(env: FlowEnvelope, privateKey: KeyObject): DecryptedFlowRequest {
  try {
    const aesKey = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(env.encrypted_aes_key, "base64"),
    );
    if (aesKey.length !== 16) throw new Error("unexpected AES key length");
    const iv = Buffer.from(env.initial_vector, "base64");
    const data = Buffer.from(env.encrypted_flow_data, "base64");
    if (data.length < 17 || iv.length !== 16) throw new Error("malformed payload");
    const tag = data.subarray(data.length - 16);
    const decipher = createDecipheriv("aes-128-gcm", aesKey, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
    return { body: JSON.parse(plain.toString("utf8")), aesKey, iv };
  } catch (e) {
    throw new FlowDecryptError(e instanceof Error ? e.message : "decrypt failed");
  }
}

export function encryptFlowResponse(response: unknown, aesKey: Buffer, iv: Buffer): string {
  const flipped = Buffer.from(iv.map((b) => ~b & 0xff));
  const cipher = createCipheriv("aes-128-gcm", aesKey, flipped);
  const enc = Buffer.concat([cipher.update(JSON.stringify(response), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return enc.toString("base64");
}
