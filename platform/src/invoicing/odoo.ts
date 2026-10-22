// The ONLY place that talks to Odoo (JSON-2 API, Odoo 19+). Everything else uses the OdooPort interface.
// JSON-2: POST {url}/json/2/{model}/{method}, "Authorization: bearer <key>", optional X-Odoo-Database,
// body = { ids?, context?, <named method arguments> }. Every call is its own transaction.

export interface OdooLine {
  productId: number;
  name: string;
  quantity: number;
  priceUnit: number;
}
export interface OdooMove {
  id: number;
  name: string | false;
  state: "draft" | "posted" | "cancel";
  paymentState: string;
  amountUntaxed: number;
  amountTotal: number;
  zatcaState: string | false; // l10n_sa_edi_state of the invoice's ZATCA document
  zatcaUuid: string | false;
  pdfAttachmentId: number | null;
}

export interface OdooPort {
  /** the invoice we created for this request, found by its reference (survives a crash or a timeout) */
  findInvoiceByRef(ref: string): Promise<OdooMove | null>;
  createDraftInvoice(i: {
    partnerId: number;
    ref: string;
    origin: string;
    date: string;
    lines: OdooLine[];
    analyticId?: number | null;
  }): Promise<number>;
  post(moveId: number): Promise<void>;
  /** submit to ZATCA through Odoo's own "Send & Print" (production or testing, as the company is set) */
  sendToZatca(moveId: number): Promise<void>;
  /** ZATCA error text of the invoice, if any */
  zatcaMessage(moveId: number): Promise<string>;
  registerPayment(moveId: number, journalId: number, date: string): Promise<void>;
  getMove(moveId: number): Promise<OdooMove>;
  pdf(attachmentId: number): Promise<{ filename: string; base64: string } | null>;
  findPartner(i: { vat?: string | null; name: string }): Promise<number | null>;
  findProduct(name: string): Promise<number | null>;
  ping(): Promise<string>;
}

export class OdooError extends Error {
  status: number;
  /** true when retrying later can help (network, 5xx, timeout) */
  transient: boolean;
  constructor(message: string, status: number, transient: boolean) {
    super(message);
    this.status = status;
    this.transient = transient;
  }
}

export interface Json2Cfg {
  url: string;
  db?: string;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const MOVE_FIELDS = [
  "name",
  "state",
  "payment_state",
  "amount_untaxed",
  "amount_total",
  "l10n_sa_edi_state",
  "l10n_sa_uuid",
  "invoice_pdf_report_id",
];

type Ctx = Record<string, unknown>;

/** Odoo sends `false` for an empty text field */
const text = (v: unknown): string | false => (typeof v === "string" && v !== "" ? v : false);

/** a many2one comes back as [id, "name"] */
function attachmentId(v: unknown): number | null {
  if (Array.isArray(v) && typeof v[0] === "number") return v[0];
  return typeof v === "number" ? v : null;
}

export class Json2Odoo implements OdooPort {
  private cfg: Json2Cfg;
  constructor(cfg: Json2Cfg) {
    this.cfg = cfg;
  }

  async call<T>(
    model: string,
    method: string,
    args: { ids?: number[]; context?: Ctx } & Record<string, unknown> = {},
  ): Promise<T> {
    let res: Response;
    try {
      res = await (this.cfg.fetch ?? fetch)(`${this.cfg.url.replace(/\/$/, "")}/json/2/${model}/${method}`, {
        method: "POST",
        headers: {
          Authorization: `bearer ${this.cfg.apiKey}`,
          "Content-Type": "application/json; charset=utf-8",
          "User-Agent": "eman-platform/1.0",
          ...(this.cfg.db ? { "X-Odoo-Database": this.cfg.db } : {}),
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 60_000),
      });
    } catch (e) {
      throw new OdooError(`Odoo not reachable: ${e instanceof Error ? e.message : String(e)}`, 0, true);
    }
    const text = await res.text();
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text) as { message?: string; name?: string };
        message = j.message ? `${j.name ?? "Error"}: ${j.message}` : message;
      } catch {
        // keep status text
      }
      throw new OdooError(message, res.status, res.status >= 500 || res.status === 429);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  private async searchRead<T>(model: string, domain: unknown[], fields: string[], limit = 5): Promise<T[]> {
    return this.call<T[]>(model, "search_read", { domain, fields, limit });
  }

  private toMove(r: Record<string, unknown>): OdooMove {
    const att = r.invoice_pdf_report_id;
    return {
      id: r.id as number,
      name: r.name as string | false,
      state: r.state as OdooMove["state"],
      paymentState: String(r.payment_state ?? ""),
      amountUntaxed: Number(r.amount_untaxed ?? 0),
      amountTotal: Number(r.amount_total ?? 0),
      zatcaState: text(r.l10n_sa_edi_state),
      zatcaUuid: text(r.l10n_sa_uuid),
      pdfAttachmentId: attachmentId(att),
    };
  }

  async findInvoiceByRef(ref: string): Promise<OdooMove | null> {
    const rows = await this.searchRead<Record<string, unknown>>(
      "account.move",
      [
        ["ref", "=", ref],
        ["move_type", "=", "out_invoice"],
      ],
      ["id", ...MOVE_FIELDS],
      2,
    );
    return rows[0] ? this.toMove(rows[0]) : null;
  }

  async getMove(moveId: number): Promise<OdooMove> {
    const rows = await this.call<Record<string, unknown>[]>("account.move", "read", {
      ids: [moveId],
      fields: ["id", ...MOVE_FIELDS],
    });
    if (!rows[0]) throw new OdooError(`invoice ${moveId} not found`, 404, false);
    return this.toMove(rows[0]);
  }

  async createDraftInvoice(i: Parameters<OdooPort["createDraftInvoice"]>[0]): Promise<number> {
    const ids = await this.call<number[]>("account.move", "create", {
      vals_list: [
        {
          move_type: "out_invoice",
          partner_id: i.partnerId,
          ref: i.ref,
          invoice_origin: i.origin,
          invoice_date: i.date,
          invoice_line_ids: i.lines.map((l) => [
            0,
            0,
            {
              product_id: l.productId,
              name: l.name,
              quantity: l.quantity,
              price_unit: l.priceUnit,
              ...(i.analyticId ? { analytic_distribution: { [String(i.analyticId)]: 100 } } : {}),
            },
          ]),
        },
      ],
    });
    return ids[0];
  }

  async post(moveId: number): Promise<void> {
    await this.call("account.move", "action_post", { ids: [moveId] });
  }

  /** Same steps as the "Send & Print" button: open the wizard, tick "To ZATCA", send nothing by e-mail, confirm. */
  async sendToZatca(moveId: number): Promise<void> {
    const context: Ctx = { active_model: "account.move", active_ids: [moveId], active_id: moveId };
    const [wizardId] = await this.call<number[]>("account.move.send.wizard", "create", {
      context,
      vals_list: [{ move_id: moveId }],
    });
    const [w] = await this.call<
      {
        extra_edi_checkboxes: Record<string, { checked?: boolean }> | false;
        sending_method_checkboxes: Record<string, { checked?: boolean }> | false;
      }[]
    >("account.move.send.wizard", "read", {
      ids: [wizardId],
      context,
      fields: ["extra_edi_checkboxes", "sending_method_checkboxes"],
    });
    const edi = { ...(w.extra_edi_checkboxes || {}) };
    const keys = Object.keys(edi).filter((k) => k === "sa_edi" || k === "sa_edi_test");
    if (keys.length === 0)
      throw new OdooError(
        "ZATCA is not available for this invoice (journal not onboarded or company not set for ZATCA).",
        422,
        false,
      );
    for (const k of keys) edi[k] = { ...edi[k], checked: true };
    const methods = Object.fromEntries(
      Object.entries(w.sending_method_checkboxes || {}).map(([k, v]) => [k, { ...v, checked: false }]),
    );
    await this.call("account.move.send.wizard", "write", {
      ids: [wizardId],
      context,
      vals: { extra_edi_checkboxes: edi, sending_method_checkboxes: methods },
    });
    await this.call("account.move.send.wizard", "action_send_and_print", { ids: [wizardId], context });
  }

  async zatcaMessage(moveId: number): Promise<string> {
    const [m] = await this.call<{ l10n_sa_edi_document_id: [number, string] | false }[]>("account.move", "read", {
      ids: [moveId],
      fields: ["l10n_sa_edi_document_id"],
    });
    if (!m?.l10n_sa_edi_document_id) return "";
    const [d] = await this.call<{ message: string | false }[]>("l10n_sa_edi.document", "read", {
      ids: [m.l10n_sa_edi_document_id[0]],
      fields: ["message"],
    });
    return String(d?.message || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
  }

  async registerPayment(moveId: number, journalId: number, date: string): Promise<void> {
    const context: Ctx = { active_model: "account.move", active_ids: [moveId] };
    const [wizardId] = await this.call<number[]>("account.payment.register", "create", {
      context,
      vals_list: [{ journal_id: journalId, payment_date: date }],
    });
    await this.call("account.payment.register", "action_create_payments", { ids: [wizardId], context });
  }

  async pdf(attachmentId: number): Promise<{ filename: string; base64: string } | null> {
    const [a] = await this.call<{ name: string; datas: string | false }[]>("ir.attachment", "read", {
      ids: [attachmentId],
      fields: ["name", "datas"],
    });
    return a?.datas ? { filename: a.name, base64: a.datas } : null;
  }

  async findPartner(i: { vat?: string | null; name: string }): Promise<number | null> {
    if (i.vat) {
      const byVat = await this.searchRead<{ id: number }>("res.partner", [["vat", "=", i.vat]], ["id"], 2);
      if (byVat.length === 1) return byVat[0].id;
      if (byVat.length > 1) return null; // ambiguous: a person decides
    }
    const byName = await this.searchRead<{ id: number }>("res.partner", [["name", "=ilike", i.name]], ["id"], 2);
    return byName.length === 1 ? byName[0].id : null;
  }

  async findProduct(name: string): Promise<number | null> {
    const rows = await this.searchRead<{ id: number }>(
      "product.product",
      [
        ["name", "=ilike", name],
        ["sale_ok", "=", true],
      ],
      ["id"],
      2,
    );
    return rows.length === 1 ? rows[0].id : null;
  }

  async ping(): Promise<string> {
    const rows = await this.searchRead<{ name: string }>("res.company", [], ["name"], 1);
    return rows[0]?.name ?? "";
  }
}
