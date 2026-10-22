import type { WaEvent } from "./types.ts";

const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");

/** Pulls every message sender and status recipient out of a Meta webhook body. Never throws. */
export function extractEvents(body: unknown): WaEvent[] {
  const out: WaEvent[] = [];
  const entries = (body as { entry?: unknown[] } | null)?.entry;
  if (!Array.isArray(entries)) return out;
  for (const e of entries) {
    const changes = (e as { changes?: unknown[] })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const c of changes) {
      const v = (c as { value?: { messages?: unknown[]; statuses?: unknown[] } })?.value;
      for (const m of v?.messages ?? []) {
        const msg = m as { from?: unknown; id?: unknown };
        const phone = digits(msg.from);
        if (phone) out.push({ phone, id: String(msg.id ?? ""), kind: "message" });
      }
      for (const s of v?.statuses ?? []) {
        const st = s as { recipient_id?: unknown; id?: unknown };
        const phone = digits(st.recipient_id);
        if (phone) out.push({ phone, id: String(st.id ?? ""), kind: "status" });
      }
    }
  }
  return out;
}

/** The body keeping only the events the predicate accepts (used when one POST holds several services' people). */
export function filterBody(body: unknown, keep: (ev: Omit<WaEvent, "id"> & { id: string }) => boolean): unknown {
  const copy = structuredClone(body) as {
    entry?: {
      changes?: {
        value?: {
          messages?: { from?: unknown; id?: unknown }[];
          statuses?: { recipient_id?: unknown; id?: unknown }[];
        };
      }[];
    }[];
  };
  for (const e of copy.entry ?? []) {
    for (const c of e.changes ?? []) {
      const v = c.value;
      if (!v) continue;
      if (v.messages)
        v.messages = v.messages.filter((m) => keep({ kind: "message", phone: digits(m.from), id: String(m.id ?? "") }));
      if (v.statuses)
        v.statuses = v.statuses.filter((s) =>
          keep({ kind: "status", phone: digits(s.recipient_id), id: String(s.id ?? "") }),
        );
    }
  }
  return copy;
}
