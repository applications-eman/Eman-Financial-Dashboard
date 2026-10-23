// Messages from salesmen (forwarded by the router). Only registered, active salesmen get anything.

import type { Db } from "../db.ts";
import { setting } from "./intake.ts";
import { msg } from "./messages.ts";
import type { OdooPort } from "./odoo.ts";
import type { WaPort } from "./wa.ts";
import { deliverPdf } from "./worker.ts";
import { randomBytes } from "node:crypto";

export interface WebhookDeps {
  db: Db;
  wa: WaPort;
  odoo: OdooPort;
  sessionMinutes?: number;
}

interface WaMessage {
  from?: string;
  id?: string;
  type?: string;
  interactive?: { type?: string; nfm_reply?: { response_json?: string }; button_reply?: { id?: string } };
}

interface WebhookBody {
  entry?: { changes?: { value?: { messages?: WaMessage[] } }[] }[];
}

function messagesOf(body: unknown): WaMessage[] {
  const out: WaMessage[] = [];
  for (const e of (body as WebhookBody | null)?.entry ?? []) {
    for (const c of e.changes ?? []) out.push(...(c.value?.messages ?? []));
  }
  return out;
}

export async function handleInvoicingWebhook(d: WebhookDeps, body: unknown): Promise<void> {
  for (const m of messagesOf(body)) {
    const phone = String(m.from ?? "").replace(/\D/g, "");
    if (!phone) continue;
    try {
      await handleMessage(d, phone, m);
    } catch (e) {
      console.error(
        JSON.stringify({ event: "invoicing_message_failed", error: e instanceof Error ? e.message : String(e) }),
      );
    }
  }
}

async function handleMessage(d: WebhookDeps, phone: string, m: WaMessage) {
  const [s] = await d.db.query<{ id: string; name: string; status: string }>(
    `select id, name, status from salesmen where phone=$1`,
    [phone],
  );
  if (!s) return void (await d.wa.sendText(phone, msg("M01")));
  if (s.status !== "active") return void (await d.wa.sendText(phone, msg("M02")));

  // the Flow was confirmed: tell the salesman what happened to the request
  if (m.interactive?.nfm_reply?.response_json)
    return acknowledge(d, s.id, phone, m.interactive.nfm_reply.response_json);

  const buttonId = m.interactive?.button_reply?.id;
  if (buttonId?.startsWith("pdf:")) return resendPdf(d, s.id, phone, buttonId.slice(4));

  if (m.type !== "text") return void (await d.wa.sendText(phone, msg("M24")));

  if ((await setting(d.db, "kill_switch", false)) === true) return void (await d.wa.sendText(phone, msg("M31")));
  const token = randomBytes(24).toString("hex");
  await d.db.query(
    `insert into flow_sessions (token, salesman_id, expires_at) values ($1,$2, now() + make_interval(mins => $3::int))`,
    [token, s.id, d.sessionMinutes ?? 30],
  );
  await d.wa.sendFlow(phone, { body: msg("M03", { name: s.name }), token });
}

async function acknowledge(d: WebhookDeps, salesmanId: string, phone: string, responseJson: string) {
  let token = "";
  try {
    token = String((JSON.parse(responseJson) as { flow_token?: string }).flow_token ?? "");
  } catch {
    return;
  }
  const [r] = await d.db.query<{
    ref_code: string;
    status: string;
    id: string;
    invoice_number: string | null;
    created_at: Date;
  }>(
    `select r.id, r.ref_code, r.status, r.invoice_number, r.created_at from flow_sessions f join invoice_requests r on r.id = f.request_id where f.token=$1 and f.salesman_id=$2`,
    [token, salesmanId],
  );
  if (!r) return;
  if (r.status === "awaiting_approval") {
    const [a] = await d.db.query<{ reason: string }>(`select reason from approvals where request_id=$1`, [r.id]);
    const similar = /as (\S+) within/.exec(a?.reason ?? "")?.[1] ?? "";
    return void (await d.wa.sendText(
      phone,
      msg("M15", {
        time: new Date(r.created_at).toLocaleTimeString("en-GB", {
          timeZone: "Asia/Riyadh",
          hour: "2-digit",
          minute: "2-digit",
        }),
        number: similar,
      }),
    ));
  }
  // the worker may already have finished and sent the real result: then there is nothing true left to acknowledge
  if (r.status !== "queued" && r.status !== "processing") return;
  const [{ n }] = await d.db.query<{ n: number }>(
    `select count(*)::int as n from invoice_requests where status in ('queued','processing') and created_at < $1`,
    [r.created_at],
  );
  const ahead = n > 0 ? ` There ${n === 1 ? "is 1 invoice" : `are ${n} invoices`} ahead of yours.` : "";
  await d.wa.sendText(phone, `${msg("M11")}${ahead} Reference: ${r.ref_code}`);
}

async function resendPdf(d: WebhookDeps, salesmanId: string, phone: string, ref: string) {
  const [r] = await d.db.query<{ status: string; odoo_move_id: string | null }>(
    `select status, odoo_move_id from invoice_requests where ref_code=$1 and salesman_id=$2`,
    [ref, salesmanId],
  );
  if (r?.status !== "cleared" || !r.odoo_move_id) return void (await d.wa.sendText(phone, msg("M16")));
  await deliverPdf({ db: d.db, odoo: d.odoo, wa: d.wa }, salesmanId, await d.odoo.getMove(Number(r.odoo_move_id)), ref);
}
