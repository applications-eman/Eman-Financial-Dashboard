// The invoice queue worker. One worker posts at a time (ZATCA invoices are hash-chained), always oldest first.
// Safety rules:
//  - before creating anything in Odoo it searches for an invoice carrying this request's reference;
//  - every step is recorded, so a crash or timeout resumes where it stopped and never creates a second invoice;
//  - the salesman is told "not issued" only when Odoo confirms no invoice exists.
import type { Db } from "../db.ts";
import { money, setting } from "./intake.ts";
import { msg } from "./messages.ts";
import type { OdooMove, OdooPort } from "./odoo.ts";
import { OdooError } from "./odoo.ts";
import type { WaPort } from "./wa.ts";

export interface WorkerDeps {
  db: Db;
  odoo: OdooPort;
  wa: WaPort;
  cashJournalId: number;
  /** sales journal for the invoices; empty = Odoo's default sales journal (a separate test journal while testing) */
  salesJournalId?: number | null;
  workerId: string;
  maxAttempts?: number;
  /** seconds until a request whose ZATCA answer is still pending is looked at again */
  pendingRetrySeconds?: number;
  today?: () => string;
}

interface Job {
  id: string;
  ref_code: string;
  salesman_id: string;
  customer_id: string;
  lines: { odoo_product_id: number; name: string; qty: number; price: number }[];
  subtotal: string;
  total: string;
  attempts: number;
  odoo_move_id: string | null;
}

const LOCK = "odoo-invoicing";
const cleared = (s: OdooMove["zatcaState"]) => s === "accepted" || s === "warning";
const riyadhToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Riyadh" });

async function event(db: Db, id: string, kind: string, detail?: unknown) {
  await db.query(`insert into invoice_request_events (request_id, kind, detail) values ($1,$2,$3)`, [
    id,
    kind,
    detail === undefined ? null : JSON.stringify(detail),
  ]);
}

/** Processes queued requests until none is left. Returns how many were handled. Safe to call from several places at once. */
export async function drain(d: WorkerDeps): Promise<number> {
  let handled = 0;
  let holding = false;
  try {
    for (;;) {
      // paused by the emergency switch: take nothing new
      if ((await setting(d.db, "kill_switch", false)) === true) return handled;
      const [{ ok }] = await d.db.query<{ ok: boolean }>(`select public.acquire_lock($1,$2,150) as ok`, [
        LOCK,
        d.workerId,
      ]);
      if (!ok) return handled;
      holding = true;
      const [job] = await d.db.query<Job>(`select * from public.claim_next_invoice_job($1, 120)`, [d.workerId]);
      if (!job) return handled;
      handled++;
      try {
        await processJob(d, job);
      } catch (e) {
        // never let one request stop the queue; it comes back when its lease ends
        console.error(
          JSON.stringify({ event: "job_crashed", id: job.id, error: e instanceof Error ? e.message : String(e) }),
        );
        await event(d.db, job.id, "crashed", { error: e instanceof Error ? e.message : String(e) }).catch(
          () => undefined,
        );
      }
    }
  } finally {
    if (holding)
      await d.db
        .query(`delete from worker_locks where name=$1 and holder=$2`, [LOCK, d.workerId])
        .catch(() => undefined);
  }
}

async function tell(d: WorkerDeps, salesmanId: string, text: string) {
  const [s] = await d.db.query<{ phone: string }>(`select phone from salesmen where id=$1`, [salesmanId]);
  if (s) await d.wa.sendText(s.phone, text);
}

async function finish(
  d: WorkerDeps,
  job: Job,
  status: "cleared" | "rejected" | "failed",
  f: Record<string, unknown> = {},
) {
  await d.db.query(
    `update invoice_requests set status=$2, lease_until=null, finished_at=now(), invoice_number=coalesce($3,invoice_number), zatca_status=coalesce($4,zatca_status),
       zatca_uuid=coalesce($5,zatca_uuid), error_code=$6, error_detail=$7 where id=$1`,
    [job.id, status, f.number ?? null, f.zatca ?? null, f.uuid ?? null, f.code ?? null, f.detail ?? null],
  );
  await event(d.db, job.id, status, f);
}

/** keep the request in "processing" and look at it again after `seconds` */
async function retryLater(d: WorkerDeps, job: Job, seconds: number, kind: string, detail?: unknown) {
  await d.db.query(`update invoice_requests set lease_until = now() + make_interval(secs => $2) where id=$1`, [
    job.id,
    seconds,
  ]);
  await event(d.db, job.id, kind, detail);
}

async function processJob(d: WorkerDeps, job: Job) {
  const maxAttempts = d.maxAttempts ?? 8;
  const ref = `WA-${job.ref_code}`;
  const [sm] = await d.db.query<{ code: string; odoo_analytic_id: string | null }>(
    `select code, odoo_analytic_id from salesmen where id=$1`,
    [job.salesman_id],
  );
  const [cust] = await d.db.query<{ odoo_partner_id: string }>(`select odoo_partner_id from customers where id=$1`, [
    job.customer_id,
  ]);
  const today = (d.today ?? riyadhToday)();

  try {
    let move: OdooMove | null = job.odoo_move_id
      ? await d.odoo.getMove(Number(job.odoo_move_id))
      : await d.odoo.findInvoiceByRef(ref);

    if (!move) {
      const id = await d.odoo.createDraftInvoice({
        partnerId: Number(cust.odoo_partner_id),
        ref,
        origin: `WA/${sm.code}/${job.ref_code}`,
        date: today,
        analyticId: sm.odoo_analytic_id ? Number(sm.odoo_analytic_id) : null,
        journalId: d.salesJournalId ?? null,
        lines: job.lines.map((l) => ({
          productId: l.odoo_product_id,
          name: l.name,
          quantity: l.qty,
          priceUnit: l.price,
        })),
      });
      await d.db.query(`update invoice_requests set odoo_move_id=$2 where id=$1`, [job.id, id]);
      await event(d.db, job.id, "odoo_created", { moveId: id });
      move = await d.odoo.getMove(id);
    } else if (!job.odoo_move_id) {
      await d.db.query(`update invoice_requests set odoo_move_id=$2 where id=$1`, [job.id, move.id]);
    }

    if (move.state === "cancel") {
      await finish(d, job, "failed", { code: "odoo_cancelled", detail: "The invoice was cancelled in Odoo" });
      await tell(d, job.salesman_id, msg("M18", { ref: job.ref_code }));
      return;
    }

    if (move.state === "draft") {
      // never post an invoice whose amount differs from what the salesman confirmed
      if (Math.abs(move.amountUntaxed - Number(job.subtotal)) > 0.01) {
        await finish(d, job, "failed", {
          code: "total_mismatch",
          detail: `Odoo ${money(move.amountUntaxed)} vs confirmed ${money(Number(job.subtotal))} (draft left in Odoo)`,
        });
        await tell(d, job.salesman_id, msg("M18", { ref: job.ref_code }));
        return;
      }
      await d.odoo.post(move.id);
      await event(d.db, job.id, "odoo_posted");
      move = await d.odoo.getMove(move.id);
    }

    if (!cleared(move.zatcaState) && move.zatcaState !== "rejected") {
      await d.odoo.sendToZatca(move.id);
      move = await d.odoo.getMove(move.id);
    }

    if (move.zatcaState === "rejected") {
      const reason = (await d.odoo.zatcaMessage(move.id).catch(() => "")) || "see the accounts team";
      await finish(d, job, "rejected", {
        number: move.name || null,
        zatca: "rejected",
        code: "zatca_rejected",
        detail: reason,
      });
      await tell(d, job.salesman_id, msg("M17", { reason, ref: job.ref_code }));
      return;
    }

    if (!cleared(move.zatcaState)) {
      if (job.attempts >= maxAttempts) {
        await finish(d, job, "failed", {
          number: move.name || null,
          code: "clearance_unconfirmed",
          detail: "ZATCA answer not confirmed in time",
        });
        await tell(d, job.salesman_id, msg("M27", { number: String(move.name || job.ref_code) }));
        return;
      }
      if (job.attempts === 1) await tell(d, job.salesman_id, msg("M27", { number: String(move.name || job.ref_code) }));
      await retryLater(d, job, d.pendingRetrySeconds ?? 60, "zatca_pending", { state: move.zatcaState });
      return;
    }

    // cleared: cash payment in full, then deliver the PDF
    let paymentNote: string | null = null;
    if (move.paymentState !== "paid" && move.paymentState !== "in_payment") {
      try {
        await d.odoo.registerPayment(move.id, d.cashJournalId, today);
        await event(d.db, job.id, "payment_registered");
      } catch (e) {
        paymentNote = e instanceof Error ? e.message : String(e);
        await event(d.db, job.id, "payment_failed", { error: paymentNote });
      }
    }
    await finish(d, job, "cleared", {
      number: move.name || null,
      zatca: String(move.zatcaState),
      uuid: move.zatcaUuid || null,
      code: paymentNote ? "payment_failed" : null,
      detail: paymentNote,
    });
    await deliverPdf(d, job.salesman_id, move, job.ref_code);
  } catch (e) {
    await handleError(d, job, ref, e, maxAttempts);
  }
}

export async function deliverPdf(
  d: Pick<WorkerDeps, "db" | "odoo" | "wa">,
  salesmanId: string,
  move: OdooMove,
  refCode: string,
) {
  const [s] = await d.db.query<{ phone: string }>(`select phone from salesmen where id=$1`, [salesmanId]);
  const [r] = await d.db.query<{ customer: string; total: string }>(
    `select c.name as customer, r.total from invoice_requests r join customers c on c.id=r.customer_id where r.ref_code=$1`,
    [refCode],
  );
  if (!s || !r) return;
  const pdf = move.pdfAttachmentId ? await d.odoo.pdf(move.pdfAttachmentId).catch(() => null) : null;
  const caption = msg("M13", { number: String(move.name), customer: r.customer, total: money(Number(r.total)) });
  const sent = pdf
    ? await d.wa.sendDocument(s.phone, {
        filename: `${String(move.name).replaceAll("/", "-")}.pdf`,
        base64: pdf.base64,
        caption,
      })
    : false;
  if (!sent) await d.wa.sendText(s.phone, `${caption}\n${msg("M26")}`);
}

async function handleError(d: WorkerDeps, job: Job, ref: string, e: unknown, maxAttempts: number) {
  const err = e instanceof OdooError ? e : new OdooError(e instanceof Error ? e.message : String(e), 0, false);
  if (err.transient && job.attempts < maxAttempts) {
    if (job.attempts === 1) await tell(d, job.salesman_id, msg("M16"));
    await retryLater(d, job, Math.min(30 * 2 ** (job.attempts - 1), 600), "retry", { error: err.message });
    return;
  }
  // permanent (or out of retries): say "not issued" only when Odoo confirms there is no posted invoice
  let existing: OdooMove | null = null;
  let known = true;
  try {
    existing = await d.odoo.findInvoiceByRef(ref);
  } catch {
    known = false;
  }
  let code = "odoo_error";
  if (err.status === 401 || err.status === 403) code = "odoo_auth";
  else if (err.transient) code = "odoo_unreachable";
  await finish(d, job, "failed", {
    number: existing && existing.state === "posted" ? existing.name || null : null,
    code,
    detail: err.message,
  });
  if (!known) await tell(d, job.salesman_id, msg("M16"));
  else if (existing && existing.state === "posted")
    await tell(d, job.salesman_id, msg("M27", { number: String(existing.name || job.ref_code) }));
  else await tell(d, job.salesman_id, msg("M18", { ref: job.ref_code }));
}
