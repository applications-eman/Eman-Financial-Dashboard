// Remembers which section a person chose with the WhatsApp buttons ("pending" capture, 15 minutes).
// Stored in whatsapp_events (service-role only, no audit trigger) under wa_message_id = "pending:<phone>".
import type { Store } from "./store.ts";
import { isSection, type Section } from "./validate.ts";

const TTL_MS = 15 * 60_000;
const key = (phone: string) => `pending:${phone}`;

export async function setPending(store: Store, phone: string, section: Section, now = Date.now()): Promise<void> {
  await store.upsert("whatsapp_events", { wa_message_id: key(phone), payload: { section, exp: now + TTL_MS }, processed_at: new Date(now).toISOString() }, "wa_message_id");
}

export async function getPending(store: Store, phone: string, now = Date.now()): Promise<Section | null> {
  const { rows } = await store.select("whatsapp_events", { filters: [["wa_message_id", "eq", key(phone)]], limit: 1 });
  const p = rows[0]?.payload as { section?: string; exp?: number } | undefined;
  return p && isSection(p.section) && typeof p.exp === "number" && p.exp > now ? p.section : null;
}

export async function clearPending(store: Store, phone: string): Promise<void> {
  await store.remove("whatsapp_events", [["wa_message_id", "eq", key(phone)]]);
}
