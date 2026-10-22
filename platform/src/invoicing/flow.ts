// WhatsApp Flow data endpoint logic (already decrypted). Screens: CUSTOMER -> ITEMS (category chips, products, "Add to cart")
// -> REVIEW (the cart: change or remove a line, create the invoice) -> done.
// Meta limits the routing to forward steps, so "add to cart" re-answers the ITEMS screen with the updated cart.
// The Flow never waits for Odoo: confirming only writes a queued request; the worker does the rest.
import type { Db } from "../db.ts";
import { loadSession, money, priceLine, type Session, type SessionLine, submitRequest, totals } from "./intake.ts";
import { type MsgCode, msg } from "./messages.ts";

export interface FlowBody {
  version?: string;
  action?: string;
  screen?: string;
  flow_token?: string;
  data?: Record<string, unknown>;
}
export interface FlowResponse {
  screen?: string;
  data: Record<string, unknown>;
}

const MAX_OPTIONS = 200;
const cut = (s: string, n = 30) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const err = (code: MsgCode, vars?: Record<string, string | number>) => msg(code, vars);

/** "12", "12.5", "12,5" -> number; anything else -> NaN. At most two decimals. */
export function parseAmount(v: unknown): number {
  const s = String(v ?? "")
    .trim()
    .replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return Number.NaN;
  return Number(s);
}

interface Opt {
  id: string;
  title: string;
  description?: string;
}

/** Meta's lists must never be empty (the phone silently refuses the screen), so an empty list shows one placeholder row. */
export const PLACEHOLDER_ID = "none";
const orPlaceholder = (opts: { id: string; title: string; description?: string }[], title: string) =>
  opts.length > 0 ? opts : [{ id: PLACEHOLDER_ID, title }];

async function customerOptions(db: Db, salesmanId: string): Promise<Opt[]> {
  const rows = await db.query<{ id: string; name: string }>(
    `select c.id, c.name from salesman_customers sc join customers c on c.id = sc.customer_id
      where sc.salesman_id = $1 and c.status = 'active' and c.odoo_partner_id is not null order by lower(c.name) limit ${MAX_OPTIONS}`,
    [salesmanId],
  );
  return rows.map((r) => ({
    id: r.id,
    title: cut(r.name),
    ...(r.name.length > 30 ? { description: cut(r.name, 300) } : {}),
  }));
}

async function categoryOptions(db: Db): Promise<Opt[]> {
  const rows = await db.query<{ id: string; name: string }>(
    `select c.id, c.name from product_categories c where c.active and exists (
       select 1 from products p where p.category_id = c.id and p.status = 'active' and p.max_price is not null and p.odoo_product_id is not null)
     order by c.sort_order, lower(c.name) limit ${MAX_OPTIONS}`,
  );
  return rows.map((r) => ({ id: r.id, title: cut(r.name) }));
}

/** WhatsApp shows at most 20 round ticks in one list. */
const MAX_TICKS = 20;

/** Products of a category that are not in the cart yet (a product can be on the invoice only once). */
async function productOptions(db: Db, categoryId: string | null, inCart: string[] = []): Promise<Opt[]> {
  if (!categoryId) return [];
  const rows = await db.query<{ id: string; name: string; max_price: string }>(
    `select id, name, max_price from products where category_id = $1 and status = 'active' and max_price is not null and odoo_product_id is not null and not (id::text = any($2::text[])) order by lower(name) limit ${MAX_TICKS}`,
    [categoryId, inCart],
  );
  return rows.map((r) => ({
    id: r.id,
    title: cut(r.name),
    description: `Maximum ${money(Number(r.max_price))} before VAT`,
  }));
}

async function names(db: Db, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.query<{ id: string; name: string }>(
    `select id, name from products where id = any($1::uuid[])`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function cartText(db: Db, lines: SessionLine[]): Promise<string> {
  if (lines.length === 0) return "Your cart is empty. Choose a category, product, quantity and price.";
  const nm = await names(
    db,
    lines.map((l) => l.product_id),
  );
  const priced = lines.map((l) => ({ ...l, ...priceLine(l.qty, l.price) }));
  const t = totals(priced);
  const rows = priced.map(
    (l, i) => `${i + 1}. ${nm.get(l.product_id) ?? "Product"}: ${l.qty} x ${money(l.price)} = ${money(l.sub)}`,
  );
  return `${rows.join("\n")}\n\nBefore VAT ${money(t.subtotal)}. VAT ${money(t.vat)}. Total ${money(t.total)}.`;
}

async function customerScreen(db: Db, s: Session | null, error?: string): Promise<FlowResponse> {
  return {
    screen: "CUSTOMER",
    data: {
      customers: orPlaceholder(s ? await customerOptions(db, s.salesman_id) : [], "No customers available"),
      ...(error ? { error_message: error } : {}),
    },
  };
}

async function itemsScreen(
  db: Db,
  s: Session,
  o: { category?: string | null; error?: string } = {},
): Promise<FlowResponse> {
  const category = o.category ?? null;
  return {
    screen: "ITEMS",
    data: {
      categories: orPlaceholder(await categoryOptions(db), "No categories available"),
      products: orPlaceholder(
        await productOptions(
          db,
          category,
          s.lines.map((l) => l.product_id),
        ),
        category ? "All products here are in the cart" : "Choose a category first",
      ),
      cart_text: await cartText(db, s.lines),
      ...(o.error ? { error_message: o.error } : {}),
    },
  };
}

/** The cart as a receipt preview: customer, each product with quantity and price, then the totals. */
async function receiptText(db: Db, s: Session): Promise<string> {
  const [c] = await db.query<{ name: string }>(`select name from customers where id=$1`, [s.customer_id]);
  if (s.lines.length === 0)
    return `Customer: ${c?.name ?? ""}\n\nThe cart is empty. Tap the back arrow to add products.`;
  const nm = await names(
    db,
    s.lines.map((l) => l.product_id),
  );
  const priced = s.lines.map((l) => ({ ...l, ...priceLine(l.qty, l.price) }));
  const t = totals(priced);
  const rows = priced.map(
    (l, i) => `${i + 1}. ${nm.get(l.product_id) ?? "Product"}\n     ${l.qty} x ${money(l.price)} = ${money(l.sub)}`,
  );
  const line = "------------------------------";
  return [
    `Customer: ${c?.name ?? ""}`,
    line,
    rows.join("\n"),
    line,
    `Before VAT:  ${money(t.subtotal)}`,
    `VAT 15%:  ${money(t.vat)}`,
    `TOTAL:  ${money(t.total)} SAR`,
  ].join("\n");
}

async function reviewScreen(db: Db, s: Session, error?: string): Promise<FlowResponse> {
  return {
    screen: "REVIEW",
    data: { review_text: await receiptText(db, s), ...(error ? { error_message: error } : {}) },
  };
}

async function save(db: Db, token: string, patch: { customer_id?: string | null; lines?: SessionLine[] }) {
  await db.query(
    `update flow_sessions set customer_id = coalesce($2, customer_id), lines = coalesce($3::jsonb, lines), updated_at = now() where token = $1`,
    [token, patch.customer_id ?? null, patch.lines ? JSON.stringify(patch.lines) : null],
  );
}

/**
 * Which step the phone is asking for. Normally the Flow names it (`step`; `action` in the first version of the Flow).
 * If the name did not arrive, it is worked out from the screen and from which fields came with it, so a tap never
 * dead-ends silently.
 */
export function stepOf(screen: string | undefined, d: Record<string, unknown>): string {
  const named = String(d.step ?? d.action ?? "");
  if (named) return named;
  if (screen === "CUSTOMER") return "customer" in d ? "select_customer" : "";
  if (screen === "REVIEW") return "confirm";
  if (screen === "ITEMS") {
    if (["product", "qty", "price"].some((k) => k in d)) return "add_item";
    if ("category" in d) return "select_category";
  }
  return "";
}

/** Chips arrive as a list with the one chosen id; a plain value is accepted too. */
const firstOf = (v: unknown): string => String((Array.isArray(v) ? v[0] : v) ?? "");

export async function handleFlow(db: Db, body: FlowBody): Promise<FlowResponse> {
  if (body.action === "ping") return { data: { status: "active" } };
  // Meta reports a problem it saw on its side: acknowledge
  if (body.data && typeof body.data === "object" && "error" in body.data) return { data: { acknowledged: true } };

  const token = String(body.flow_token ?? "");
  const s = token ? await loadSession(db, token) : null;
  const d = body.data ?? {};

  if (body.action === "INIT" || body.action === "BACK") {
    if (!s) return customerScreen(db, null, err("M22"));
    if (s.request_id) return customerScreen(db, null, "This invoice was already submitted.");
    const options = await customerOptions(db, s.salesman_id);
    if (options.length === 0) return customerScreen(db, s, err("M04"));
    if (body.action === "BACK" && body.screen === "ITEMS") return itemsScreen(db, s);
    // back on the customer screen: the invoice starts again from zero (no customer, empty cart)
    if (body.action === "BACK") {
      await db.query(
        `update flow_sessions set customer_id = null, lines = '[]'::jsonb, updated_at = now() where token = $1`,
        [token],
      );
    }
    return customerScreen(db, s);
  }

  if (!s) {
    // the form expired: stay on the screen the person is on, with the message
    if (body.screen === "REVIEW") return { screen: "REVIEW", data: { review_text: "", error_message: err("M22") } };
    return customerScreen(db, null, err("M22"));
  }

  if (s.request_id) {
    // already confirmed (double tap): finish the Flow again, nothing new is created
    return { screen: "SUCCESS", data: { extension_message_response: { params: { flow_token: token } } } };
  }

  switch (stepOf(body.screen, d)) {
    case "select_customer": {
      const id = String(d.customer ?? "");
      const ok = (await customerOptions(db, s.salesman_id)).some((o) => o.id === id);
      if (!ok) return customerScreen(db, s, err("M20"));
      await save(db, token, { customer_id: id });
      return itemsScreen(db, { ...s, customer_id: id });
    }
    case "select_category":
      return itemsScreen(db, s, { category: firstOf(d.category) || null });
    case "add_item":
      return addItem(db, s, token, d);
    case "open_cart":
      return reviewScreen(db, s);
    case "remove_last":
      return removeLast(db, s, token);
    case "confirm": {
      const r = await submitRequest(db, token);
      if (!r.ok) return reviewScreen(db, s, err(r.code, r.vars));
      return { screen: "SUCCESS", data: { extension_message_response: { params: { flow_token: token } } } };
    }
    default: {
      // never stay silent: show a message on the screen the person is on
      const msgText = "That step could not be read. Please try again.";
      return s.customer_id ? itemsScreen(db, s, { error: msgText }) : customerScreen(db, s, msgText);
    }
  }
}

interface Checked {
  productId: string;
  qty: number;
  price: number;
}

/** The authoritative checks for one line (the same ones the invoice request repeats). */
async function checkLine(
  db: Db,
  d: Record<string, unknown>,
): Promise<{ ok: true; line: Checked } | { ok: false; error: string }> {
  const productId = firstOf(d.product);
  if (!productId) return { ok: false, error: "Please choose a product." };
  const qty = parseAmount(d.qty);
  if (!(qty > 0) || qty > 100000) return { ok: false, error: err("M05") };
  const price = parseAmount(d.price);
  if (!(price > 0) || price > 1_000_000) return { ok: false, error: err("M06") };
  const [p] = await db.query<{ id: string; name: string; max_price: string | null }>(
    `select id, name, max_price from products where id::text = $1 and status='active' and odoo_product_id is not null`,
    [productId],
  );
  if (!p) return { ok: false, error: "Please choose a product." };
  if (p.max_price === null) return { ok: false, error: err("M09", { product: p.name }) };
  if (Math.round(price * 100) > Math.round(Number(p.max_price) * 100))
    return {
      ok: false,
      error: err("M07", { product: p.name, entered: money(price), max: money(Number(p.max_price)) }),
    };
  return { ok: true, line: { productId: p.id, qty, price } };
}

async function addItem(db: Db, s: Session, token: string, d: Record<string, unknown>): Promise<FlowResponse> {
  const category = firstOf(d.category) || null;
  const bad = (error: string) => itemsScreen(db, s, { category, error });
  const checked = await checkLine(db, d);
  if (!checked.ok) return bad(checked.error);
  if (s.lines.some((l) => l.product_id === checked.line.productId))
    return bad("This product is already in the cart. Open the cart and remove it first if you need to change it.");
  const max =
    (await db.query<{ value: number }>(`select value from platform_settings where key='max_lines_per_invoice'`))[0]
      ?.value ?? 20;
  if (s.lines.length >= max) return bad(err("M28", { max }));
  const lines = [...s.lines, { product_id: checked.line.productId, qty: checked.line.qty, price: checked.line.price }];
  await save(db, token, { lines });
  return itemsScreen(db, { ...s, lines }, { category });
}

async function removeLast(db: Db, s: Session, token: string): Promise<FlowResponse> {
  const lines = s.lines.slice(0, -1);
  await save(db, token, { lines });
  return reviewScreen(db, { ...s, lines });
}
