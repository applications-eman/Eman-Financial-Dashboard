import type { OdooLine, OdooMove, OdooPort } from "./invoicing/odoo.ts";
import { OdooError } from "./invoicing/odoo.ts";

interface FakeMove extends OdooMove {
  ref: string;
  partnerId: number;
  lines: OdooLine[];
  paid: boolean;
  note: string | null;
  journalId: number | null;
}

/** Simulated Odoo for tests. `zatca` decides what ZATCA answers; `failNext` makes the next call of a kind fail. */
export class FakeOdoo implements OdooPort {
  moves: FakeMove[] = [];
  nextId = 100;
  zatca: "accepted" | "rejected" | "pending" = "accepted";
  zatcaText = "";
  failNext: Partial<Record<"create" | "post" | "send" | "pay", OdooError>> = {};
  calls: string[] = [];
  /** total Odoo will compute (default: honest 15% VAT) */
  vat = 0.15;
  skew = 0; // added to the untaxed amount to simulate a pricing difference

  private take(kind: "create" | "post" | "send" | "pay") {
    const e = this.failNext[kind];
    if (e) {
      delete this.failNext[kind];
      throw e;
    }
  }

  uncleared: { name: string; ref: string }[] = [];
  masterPartners: {
    id: number;
    name: string;
    vat: string | null;
    active: boolean;
    address?: Record<string, unknown>;
  }[] = [];
  masterProducts: { id: number; name: string; price: number; category: string | null; active: boolean }[] = [];
  private nextMaster = 5000;
  async createPartner(i: import("./invoicing/odoo.ts").PartnerInput) {
    const id = this.nextMaster++;
    this.masterPartners.push({ id, name: i.name, vat: i.vat ?? null, active: true, address: { ...i } });
    this.partners.set(i.name.toLowerCase(), id);
    return id;
  }
  async updatePartner(id: number, i: Partial<import("./invoicing/odoo.ts").PartnerInput>) {
    const p = this.masterPartners.find((x) => x.id === id);
    if (!p) throw new OdooError("not found", 404, false);
    if (i.name !== undefined) p.name = i.name;
    if (i.vat !== undefined) p.vat = i.vat ?? null;
  }
  async archivePartner(id: number) {
    const p = this.masterPartners.find((x) => x.id === id);
    if (p) p.active = false;
  }
  async createProduct(i: { name: string; price: number; category?: string | null }) {
    const id = this.nextMaster++;
    this.masterProducts.push({ id, name: i.name, price: i.price, category: i.category ?? null, active: true });
    this.products.set(i.name.toLowerCase(), id);
    return id;
  }
  async updateProduct(id: number, i: { name?: string; price?: number; category?: string | null }) {
    const p = this.masterProducts.find((x) => x.id === id);
    if (!p) throw new OdooError("not found", 404, false);
    if (i.name !== undefined) p.name = i.name;
    if (i.price !== undefined) p.price = i.price;
    if (i.category !== undefined) p.category = i.category;
  }
  async archiveProduct(id: number) {
    const p = this.masterProducts.find((x) => x.id === id);
    if (p) p.active = false;
  }
  async listCustomers() {
    return this.masterPartners.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name, vat: p.vat }));
  }
  async listProducts() {
    return this.masterProducts
      .filter((p) => p.active)
      .map((p) => ({ id: p.id, name: p.name, price: p.price, category: p.category }));
  }
  async listUncleared() {
    return this.uncleared;
  }
  async findInvoiceByRef(ref: string) {
    return this.moves.find((m) => m.ref === ref) ?? null;
  }
  async createDraftInvoice(i: Parameters<OdooPort["createDraftInvoice"]>[0]) {
    this.calls.push("create");
    this.take("create");
    const untaxed = Math.round(i.lines.reduce((s, l) => s + l.quantity * l.priceUnit, 0) * 100) / 100 + this.skew;
    const m: FakeMove = {
      id: this.nextId++,
      name: false,
      state: "draft",
      paymentState: "not_paid",
      amountUntaxed: untaxed,
      amountTotal: Math.round(untaxed * (1 + this.vat) * 100) / 100,
      zatcaState: false,
      zatcaUuid: false,
      pdfAttachmentId: null,
      ref: i.ref,
      partnerId: i.partnerId,
      lines: i.lines,
      paid: false,
      note: i.note ?? null,
      journalId: i.journalId ?? null,
    };
    this.moves.push(m);
    return m.id;
  }
  private get(id: number) {
    const m = this.moves.find((x) => x.id === id);
    if (!m) throw new OdooError("not found", 404, false);
    return m;
  }
  async post(id: number) {
    this.calls.push("post");
    this.take("post");
    const m = this.get(id);
    m.state = "posted";
    m.name = `INV/2026/${String(id).padStart(5, "0")}`;
  }
  async sendToZatca(id: number) {
    this.calls.push("send");
    this.take("send");
    const m = this.get(id);
    if (this.zatca === "accepted") {
      m.zatcaState = "accepted";
      m.zatcaUuid = `uuid-${id}`;
      m.pdfAttachmentId = id * 10;
    } else if (this.zatca === "rejected") m.zatcaState = "rejected";
    else m.zatcaState = "unknown";
  }
  async zatcaMessage() {
    return this.zatcaText;
  }
  stalePdf = false as boolean;
  async renderFreshPdf(id: number) {
    this.calls.push("pdf");
    const m = this.get(id);
    if (this.stalePdf) m.pdfAttachmentId = (m.pdfAttachmentId ?? id * 10) + 1;
    return m.pdfAttachmentId;
  }
  async registerPayment(id: number) {
    this.calls.push("pay");
    this.take("pay");
    const m = this.get(id);
    m.paid = true;
    m.paymentState = "paid";
  }
  async getMove(id: number) {
    return this.get(id);
  }
  async pdf(att: number) {
    return { filename: `INV-${att}.pdf`, base64: Buffer.from(`PDF-${att}`).toString("base64") };
  }
  partners = new Map<string, number>();
  products = new Map<string, number>();
  async findPartner(i: { vat?: string | null; name: string }) {
    return this.partners.get(i.vat ?? "") ?? this.partners.get(i.name.toLowerCase()) ?? null;
  }
  async findProduct(name: string) {
    return this.products.get(name.toLowerCase()) ?? null;
  }
  async ping() {
    return "Eman Bakery (test)";
  }
}
