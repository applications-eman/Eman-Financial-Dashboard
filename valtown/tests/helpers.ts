import { generateKeyPairSync, createHmac } from "node:crypto";
import { MemoryStore, setStore } from "../lib/store.ts";
import { generateToken } from "../lib/crypto.ts";
import { resetRateLimits } from "../lib/ratelimit.ts";
import { encodeZatcaQr } from "../lib/tlv.ts";

export const SAMPLE_QR = encodeZatcaQr({
  1: "شركة مخابز ايمان جدة للخبز", 2: "312028501300003", 3: "2026-08-11T15:19:20", 4: "145.52", 5: "18.98",
});

export const ENV = {
  SUPABASE_URL: "https://proj.supabase.co", SUPABASE_JWT_SECRET: "jwt-secret-for-tests-0123456789abcdef",
  WA_APP_SECRET: "app-secret", WA_VERIFY_TOKEN: "verify-me", ALLOWED_ORIGIN: "https://dash.example.run.app",
};

export function setup() {
  Object.assign(process.env, ENV);
  delete process.env.WA_TOKEN; delete process.env.WA_PHONE_NUMBER_ID; // never hit the real Graph API in tests
  resetRateLimits();
  const store = new MemoryStore();
  setStore(store);
  return store;
}

export async function seedUsers(store: MemoryStore) {
  const staff = generateToken();
  const admin = (await store.insert("app_users", { auth_user_id: "aaaaaaaa-0000-0000-0000-000000000001", name: "Admin", role: "admin", sections: ["bakery", "grocery"], active: true, phone_e164: "+966500000001" })) as any;
  const s = (await store.insert("app_users", { auth_user_id: "bbbbbbbb-0000-0000-0000-000000000002", name: "Ali", role: "staff", sections: ["bakery"], active: true, phone_e164: "+966500000002", token_hash: staff.hash })) as any;
  const inactive = generateToken();
  await store.insert("app_users", { name: "Gone", role: "staff", sections: ["bakery"], active: false, phone_e164: "+966500000003", token_hash: inactive.hash });
  return { staffToken: staff.token, inactiveToken: inactive.token, admin: admin.row, staff: s.row };
}

export const sign = (raw: string, secret = ENV.WA_APP_SECRET) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
export const rsaKey = (passphrase: string) => generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase },
});
