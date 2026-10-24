// The ONLY place that talks to Odoo (JSON-2 API, Odoo 19+). Everything else uses the OdooPort interface.
// JSON-2: POST {url}/json/2/{model}/{method}, "Authorization: bearer <key>", optional X-Odoo-Database,
// body = { ids?, context?, <named method arguments> }. Every call is its own transaction.

export interface OdooLine {
  productId: number;
  name: string;
  quantity: number;
  priceUnit: number;
}
export interface PartnerInput {
  name: string;
  vat?: string | null;
  phone?: string | null;
  street?: string | null;
  district?: string | null;
  city?: string | null;
  zip?: string | null;
  buildingNumber?: string | null;
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
    journalId?: number | null;
    /** text printed on the invoice (Odoo "Terms and conditions" area), e.g. the TEST marking */
    note?: string | null;
  }): Promise<number>;
  post(moveId: number): Promise<void>;
  /** submit to ZATCA through Odoo's own "Send & Print" (production or testing, as the company is set) */
  sendToZatca(moveId: number): Promise<void>;
  /** ZATCA error text of the invoice, if any */
  zatcaMessage(moveId: number): Promise<string>;
  /**
   * Odoo keeps the PDF made at the FIRST send attempt, even a rejected one. After a retry that PDF is outdated,
   * so: if it is older than the accepted ZATCA file, it is deleted and Odoo makes a new one. Returns the PDF attachment id.
   */
  renderFreshPdf(moveId: number): Promise<number | null>;
  registerPayment(moveId: number, journalId: number, date: string): Promise<void>;
  getMove(moveId: number): Promise<OdooMove>;
  /** the invoice PDF; when the move id is given it is read from the invoice itself (the attachment alone is not readable by every user) */
  pdf(attachmentId: number, moveId?: number): Promise<{ filename: string; base64: string } | null>;
  findPartner(i: { vat?: string | null; name: string }): Promise<number | null>;
  findProduct(name: string): Promise<number | null>;
  ping(): Promise<string>;

  // ---- master data: the platform is where people add and change these; Odoo receives them at once
  /** the customer's address fields are only needed for a company with a VAT number (a standard invoice) */
  createPartner(i: PartnerInput): Promise<number>;
  updatePartner(id: number, i: Partial<PartnerInput>): Promise<void>;
  /** Odoo keeps a customer that has invoices, so it is archived, never deleted */
  archivePartner(id: number): Promise<void>;
  /** a goods product that can be sold, with the company's standard VAT and the price as its sales price */
  createProduct(i: { name: string; price: number; category?: string | null }): Promise<number>;
  updateProduct(id: number, i: { name?: string; price?: number; category?: string | null }): Promise<void>;
  archiveProduct(id: number): Promise<void>;
  listCustomers(): Promise<{ id: number; name: string; vat: string | null }[]>;
  listProducts(): Promise<{ id: number; name: string; price: number; category: string | null }[]>;
  /** invoices of this journal that are posted but not cleared by ZATCA and older than the given minutes */
  listUncleared(journalId: number, olderThanMinutes: number): Promise<{ name: string; ref: string }[]>;
}

/**
 * Odoo 20 returns a file field as { filename, content (base64 text), size }; older versions return the base64 text itself.
 * Returns the base64 text, or null when there is no file.
 */
export function binaryContent(v: unknown): string | null {
  if (typeof v === "string") return v === "" ? null : v;
  if (v && typeof v === "object" && "content" in v && typeof v.content === "string") return v.content || null;
  return null;
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
    // Odoo does not fill in the product's VAT when an invoice is created through the API, so it is set on each line here
    // ids can arrive as text from the database, so they are made numbers before they are compared
    const productIds = [...new Set(i.lines.map((l) => Number(l.productId)))];
    const products = await this.call<{ id: number; name: string; taxes_id: number[] }[]>("product.product", "read", {
      ids: productIds,
      fields: ["name", "taxes_id"],
    });
    const taxOf = new Map(products.map((p) => [p.id, p]));
    for (const id of productIds) {
      const p = taxOf.get(id);
      if (!p || p.taxes_id.length === 0)
        throw new OdooError(
          `"${p?.name ?? id}" has no VAT set in Odoo (customer taxes). Set it, then retry.`,
          422,
          false,
        );
    }
    const ids = await this.call<number[]>("account.move", "create", {
      vals_list: [
        {
          move_type: "out_invoice",
          partner_id: i.partnerId,
          ...(i.journalId ? { journal_id: i.journalId } : {}),
          ...(i.note ? { narration: `<p>${i.note}</p>` } : {}),
          ref: i.ref,
          invoice_origin: i.origin,
          invoice_date: i.date,
          invoice_line_ids: i.lines.map((l) => [
            0,
            0,
            {
              product_id: Number(l.productId),
              name: l.name,
              quantity: l.quantity,
              price_unit: l.priceUnit,
              tax_ids: [[6, 0, taxOf.get(Number(l.productId))?.taxes_id ?? []]],
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

  async renderFreshPdf(moveId: number): Promise<number | null> {
    const [m] = await this.call<{ invoice_pdf_report_id: unknown; l10n_sa_edi_document_id: unknown }[]>(
      "account.move",
      "read",
      {
        ids: [moveId],
        fields: ["invoice_pdf_report_id", "l10n_sa_edi_document_id"],
      },
    );
    const pdfId = attachmentId(m?.invoice_pdf_report_id);
    let stale = pdfId === null;
    const docId = attachmentId(m?.l10n_sa_edi_document_id);
    if (pdfId !== null && docId !== null) {
      const [d] = await this.call<{ attachment_id: unknown }[]>("l10n_sa_edi.document", "read", {
        ids: [docId],
        fields: ["attachment_id"],
      });
      const xmlId = attachmentId(d?.attachment_id);
      if (xmlId !== null) {
        const atts = await this.call<{ id: number; create_date: string }[]>("ir.attachment", "read", {
          ids: [pdfId, xmlId],
          fields: ["create_date"],
        });
        const pdfAt = atts.find((a) => a.id === pdfId)?.create_date ?? "";
        const xmlAt = atts.find((a) => a.id === xmlId)?.create_date ?? "";
        stale = pdfAt !== "" && xmlAt !== "" && pdfAt < xmlAt;
      }
    }
    if (!stale) return pdfId;
    if (pdfId !== null) await this.call("ir.attachment", "unlink", { ids: [pdfId] });
    // Send & Print again with nothing ticked: Odoo only renders the PDF
    const context: Ctx = { active_model: "account.move", active_ids: [moveId], active_id: moveId };
    const [wizardId] = await this.call<number[]>("account.move.send.wizard", "create", {
      context,
      vals_list: [{ move_id: moveId }],
    });
    const [w] = await this.call<{ sending_method_checkboxes: Record<string, { checked?: boolean }> | false }[]>(
      "account.move.send.wizard",
      "read",
      {
        ids: [wizardId],
        context,
        fields: ["sending_method_checkboxes"],
      },
    );
    const methods = Object.fromEntries(
      Object.entries(w?.sending_method_checkboxes || {}).map(([k, v]) => [k, { ...v, checked: false }]),
    );
    await this.call("account.move.send.wizard", "write", {
      ids: [wizardId],
      context,
      vals: { sending_method_checkboxes: methods },
    });
    await this.call("account.move.send.wizard", "action_send_and_print", { ids: [wizardId], context });
    const [after] = await this.call<{ invoice_pdf_report_id: unknown }[]>("account.move", "read", {
      ids: [moveId],
      fields: ["invoice_pdf_report_id"],
    });
    return attachmentId(after?.invoice_pdf_report_id);
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

  async pdf(attachmentId: number, moveId?: number): Promise<{ filename: string; base64: string } | null> {
    if (moveId) {
      const [m] = await this.call<{ invoice_pdf_report_id: unknown; invoice_pdf_report_file: unknown }[]>(
        "account.move",
        "read",
        { ids: [moveId], fields: ["invoice_pdf_report_id", "invoice_pdf_report_file"] },
      );
      const content = binaryContent(m?.invoice_pdf_report_file);
      if (content) {
        const name = Array.isArray(m?.invoice_pdf_report_id)
          ? String(m.invoice_pdf_report_id[1])
          : `invoice-${moveId}.pdf`;
        return { filename: name, base64: content };
      }
    }
    const [a] = await this.call<{ name: string; datas: unknown }[]>("ir.attachment", "read", {
      ids: [attachmentId],
      fields: ["name", "datas"],
    });
    const content = binaryContent(a?.datas);
    return content ? { filename: a.name, base64: content } : null;
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

  private defaultsCache: { country: number | false; state: number | false; tax: number | false } | null = null;
  /** the company's country, region and standard sales VAT: these are what every new record gets, so nobody has to type them */
  private async defaults() {
    if (!this.defaultsCache) {
      const [c] = await this.searchRead<{
        country_id: [number, string] | false;
        state_id: [number, string] | false;
        account_sale_tax_id: [number, string] | false;
      }>("res.company", [], ["country_id", "state_id", "account_sale_tax_id"], 1);
      this.defaultsCache = {
        country: c?.country_id ? c.country_id[0] : false,
        state: c?.state_id ? c.state_id[0] : false,
        tax: c?.account_sale_tax_id ? c.account_sale_tax_id[0] : false,
      };
    }
    return this.defaultsCache;
  }

  private partnerVals(i: Partial<PartnerInput>): Record<string, unknown> {
    // an empty value clears the field in Odoo (Odoo's way to say "nothing" is false)
    const text = (x: string | null | undefined) => (x === null || x === "" ? false : x);
    const fields: Record<string, string | null | undefined> = {
      name: i.name,
      vat: i.vat,
      phone: i.phone,
      street: i.street,
      street2: i.district,
      city: i.city,
      zip: i.zip,
      l10n_sa_edi_building_number: i.buildingNumber,
    };
    const v: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(fields)) if (x !== undefined) v[k] = text(x);
    return v;
  }

  async createPartner(i: PartnerInput): Promise<number> {
    const d = await this.defaults();
    const [id] = await this.call<number[]>("res.partner", "create", {
      vals_list: [
        {
          ...this.partnerVals(i),
          is_company: Boolean(i.vat),
          ...(d.country ? { country_id: d.country } : {}),
          ...(d.state ? { state_id: d.state } : {}),
        },
      ],
    });
    return id;
  }

  async updatePartner(id: number, i: Partial<PartnerInput>): Promise<void> {
    const vals = this.partnerVals(i);
    if (Object.keys(vals).length > 0) await this.call("res.partner", "write", { ids: [id], vals });
  }

  async archivePartner(id: number): Promise<void> {
    await this.call("res.partner", "write", { ids: [id], vals: { active: false } });
  }

  /** finds the product category by name, creating it when it is new */
  private async categoryId(name: string): Promise<number> {
    const found = await this.searchRead<{ id: number }>("product.category", [["name", "=ilike", name]], ["id"], 1);
    if (found[0]) return found[0].id;
    const [id] = await this.call<number[]>("product.category", "create", { vals_list: [{ name }] });
    return id;
  }

  async createProduct(i: { name: string; price: number; category?: string | null }): Promise<number> {
    const d = await this.defaults();
    const [tmpl] = await this.call<number[]>("product.template", "create", {
      vals_list: [
        {
          name: i.name,
          type: "consu",
          sale_ok: true,
          list_price: i.price,
          ...(i.category ? { categ_id: await this.categoryId(i.category) } : {}),
          ...(d.tax ? { taxes_id: [[6, 0, [d.tax]]] } : {}),
        },
      ],
    });
    const variants = await this.searchRead<{ id: number }>(
      "product.product",
      [["product_tmpl_id", "=", tmpl]],
      ["id"],
      1,
    );
    if (!variants[0]) throw new OdooError("Odoo created the product but returned no variant.", 500, false);
    return variants[0].id;
  }

  private async templateOf(productId: number): Promise<number> {
    const [p] = await this.call<{ product_tmpl_id: [number, string] }[]>("product.product", "read", {
      ids: [productId],
      fields: ["product_tmpl_id"],
    });
    if (!p) throw new OdooError(`Product ${productId} not found in Odoo.`, 404, false);
    return p.product_tmpl_id[0];
  }

  async updateProduct(id: number, i: { name?: string; price?: number; category?: string | null }): Promise<void> {
    const vals: Record<string, unknown> = {};
    if (i.name !== undefined) vals.name = i.name;
    if (i.price !== undefined) vals.list_price = i.price;
    if (i.category !== undefined) vals.categ_id = i.category ? await this.categoryId(i.category) : false;
    if (Object.keys(vals).length > 0)
      await this.call("product.template", "write", { ids: [await this.templateOf(id)], vals });
  }

  async archiveProduct(id: number): Promise<void> {
    await this.call("product.template", "write", { ids: [await this.templateOf(id)], vals: { active: false } });
  }

  async listCustomers() {
    const rows = await this.searchRead<{ id: number; name: string; vat: string | false }>(
      "res.partner",
      [
        ["customer_rank", ">", 0],
        ["active", "=", true],
        ["parent_id", "=", false],
      ],
      ["id", "name", "vat"],
      2000,
    );
    return rows.map((r) => ({ id: r.id, name: r.name, vat: r.vat || null }));
  }

  async listProducts() {
    const rows = await this.searchRead<{
      id: number;
      name: string;
      list_price: number;
      categ_id: [number, string] | false;
    }>(
      "product.product",
      [
        ["sale_ok", "=", true],
        ["active", "=", true],
      ],
      ["id", "name", "list_price", "categ_id"],
      2000,
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      price: Number(r.list_price),
      category: r.categ_id ? r.categ_id[1] : null,
    }));
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

  async listUncleared(journalId: number, olderThanMinutes: number): Promise<{ name: string; ref: string }[]> {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString().replace("T", " ").slice(0, 19);
    const rows = await this.searchRead<{ name: string | false; ref: string | false }>(
      "account.move",
      [
        ["journal_id", "=", journalId],
        ["move_type", "=", "out_invoice"],
        ["state", "=", "posted"],
        ["l10n_sa_edi_state", "not in", ["accepted", "warning"]],
        ["create_date", "<", cutoff],
      ],
      ["name", "ref"],
      50,
    );
    return rows.map((r) => ({ name: String(r.name || ""), ref: String(r.ref || "") }));
  }

  async ping(): Promise<string> {
    const rows = await this.searchRead<{ name: string }>("res.company", [], ["name"], 1);
    return rows[0]?.name ?? "";
  }
}
