// Day-to-day safety nets: a health report an alert can watch, and the sweep that gives stuck invoices another try.
import type { Db } from "../db.ts";
import { setting } from "./intake.ts";
import type { OdooPort } from "./odoo.ts";

export interface Health {
  ok: boolean;
  /** things a person must look at; empty when everything is fine */
  problems: string[];
  /** facts that are not problems */
  info: string[];
  counts: {
    queued: number;
    oldest_wait_minutes: number;
    failed_24h: number;
    rejected_24h: number;
    needs_attention: number;
  };
}

const DAY_MS = 86_400_000;

export async function queueHealth(
  db: Db,
  odoo: Pick<OdooPort, "ping" | "listUncleared">,
  o: { journalId?: number | null; now?: Date } = {},
): Promise<Health> {
  const now = o.now ?? new Date();
  const problems: string[] = [];
  const info: string[] = [];

  const [q] = await db.query<{ n: number; oldest: number | null }>(
    `select count(*)::int n, extract(epoch from (now() - min(coalesce(queued_at, created_at))))::float / 60 as oldest
       from invoice_requests where status in ('queued','processing')`,
  );
  const waitLimit = await setting(db, "queue_alert_wait_minutes", 10);
  const lenLimit = await setting(db, "queue_alert_length", 25);
  const oldest = Math.round(q.oldest ?? 0);
  if (q.n > 0 && oldest > waitLimit)
    problems.push(`The oldest invoice has waited ${oldest} minutes (limit ${waitLimit}).`);
  if (q.n > lenLimit) problems.push(`${q.n} invoices are waiting (limit ${lenLimit}).`);

  const [f] = await db.query<{ failed: number; rejected: number }>(
    `select count(*) filter (where status='failed')::int failed, count(*) filter (where status='rejected')::int rejected
       from invoice_requests where finished_at > now() - interval '24 hours'`,
  );
  // an invoice that exists in Odoo but is not cleared, and was given up on
  const [a] = await db.query<{ n: number }>(
    `select count(*)::int n from invoice_requests
      where status = 'failed' and odoo_move_id is not null and finished_at > now() - interval '7 days'`,
  );
  if (a.n > 0) problems.push(`${a.n} invoice(s) were created in Odoo but not completed. See the Invoices tab.`);

  if ((await setting(db, "kill_switch", false)) === true) problems.push("Invoicing is paused (emergency pause is on).");
  if ((await setting(db, "test_mode", true)) === true) info.push("Test mode is on: invoices go to the ZATCA sandbox.");

  try {
    await odoo.ping();
  } catch (e) {
    problems.push(`Odoo cannot be reached: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
  }

  const expires = await setting<string | null>(db, "odoo_key_expires_on", null);
  if (expires) {
    const days = Math.floor((Date.parse(`${expires}T00:00:00Z`) - now.getTime()) / DAY_MS);
    if (days < 0) problems.push(`The Odoo API key expired on ${expires}.`);
    else if (days <= 14) problems.push(`The Odoo API key expires in ${days} day(s) (${expires}). Create a new one.`);
  } else info.push("The Odoo API key expiry date is not entered (Settings), so no warning can be given.");

  if (o.journalId) {
    try {
      const open = await odoo.listUncleared(o.journalId, 30);
      if (open.length > 0)
        problems.push(
          `${open.length} invoice(s) in Odoo are posted but not cleared by ZATCA, e.g. ${open
            .slice(0, 3)
            .map((m) => m.name)
            .join(", ")}.`,
        );
    } catch {
      /* Odoo trouble is already reported above */
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    info,
    counts: {
      queued: q.n,
      oldest_wait_minutes: oldest,
      failed_24h: f.failed,
      rejected_24h: f.rejected,
      needs_attention: a.n,
    },
  };
}

/**
 * Gives invoices that were given up on for a reason that can pass (Odoo or ZATCA unreachable, answer not confirmed) another turn.
 * Each request is retried at most 3 times, at least 30 minutes apart. Rejections by ZATCA are never retried: a person decides.
 */
export async function sweepStuck(db: Db): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `select r.id from invoice_requests r
      where r.status = 'failed' and r.odoo_move_id is not null
        and r.error_code in ('clearance_unconfirmed', 'odoo_unreachable', 'odoo_error')
        and r.finished_at < now() - interval '30 minutes'
        and (select count(*) from invoice_request_events e where e.request_id = r.id and e.kind = 'swept') < 3
        and not exists (select 1 from invoice_request_events e where e.request_id = r.id and e.kind = 'swept' and e.at > now() - interval '30 minutes')
      limit 20`,
  );
  for (const r of rows) {
    await db.query(
      `update invoice_requests set status = 'queued', attempts = 0, lease_until = null, error_code = null, error_detail = null,
         finished_at = null, queued_at = now() where id = $1 and status = 'failed'`,
      [r.id],
    );
    await db.query(`insert into invoice_request_events (request_id, kind) values ($1, 'swept')`, [r.id]);
  }
  return rows.length;
}
