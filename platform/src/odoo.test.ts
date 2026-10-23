import { Json2Odoo, OdooError } from "./invoicing/odoo.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function scripted(replies: (unknown | Error | { status: number; body: unknown })[]) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const r = replies.shift();
    if (r instanceof Error) throw r;
    if (r && typeof r === "object" && "status" in r && "body" in r)
      return new Response(JSON.stringify(r.body), { status: Number(r.status) });
    return new Response(JSON.stringify(r), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, odoo: new Json2Odoo({ url: "https://eman.odoo.com/", db: "eman", apiKey: "KEY", fetch: f }) };
}

test("requests follow the JSON-2 contract", async () => {
  const { calls, odoo } = scripted([[{ id: 70, name: "SHAMI", taxes_id: [5] }], [501]]);
  const id = await odoo.createDraftInvoice({
    partnerId: 7,
    ref: "WA-ABC",
    origin: "WA/F/ABC",
    date: "2026-10-22",
    analyticId: 3,
    journalId: 31,
    lines: [{ productId: "70" as unknown as number, name: "SHAMI", quantity: 2, priceUnit: 4.5 }], // ids can come from the database as text
  });
  assert.equal(id, 501);
  assert.equal(calls[0].url, "https://eman.odoo.com/json/2/product.product/read");
  assert.equal(calls[1].url, "https://eman.odoo.com/json/2/account.move/create");
  assert.equal(calls[0].headers.Authorization, "bearer KEY");
  assert.equal(calls[0].headers["X-Odoo-Database"], "eman");
  const vals = (calls[1].body.vals_list as Record<string, unknown>[])[0];
  assert.equal(vals.move_type, "out_invoice");
  assert.equal(vals.ref, "WA-ABC");
  assert.equal(vals.journal_id, 31);
  assert.deepEqual(vals.invoice_line_ids, [
    [
      0,
      0,
      {
        product_id: 70,
        name: "SHAMI",
        quantity: 2,
        price_unit: 4.5,
        tax_ids: [[6, 0, [5]]],
        analytic_distribution: { "3": 100 },
      },
    ],
  ]);
});

test("errors: wrong key is permanent, server trouble and timeouts can be retried", async () => {
  const run = async (reply: unknown) => {
    const { odoo } = scripted([reply]);
    return odoo.post(1).then(
      () => null,
      (e: OdooError) => e,
    );
  };
  const auth = await run({
    status: 401,
    body: { name: "werkzeug.exceptions.Unauthorized", message: "Invalid apikey" },
  });
  assert.ok(auth instanceof OdooError);
  assert.deepEqual([auth.status, auth.transient], [401, false]);
  assert.match(auth.message, /Invalid apikey/);
  assert.equal(((await run({ status: 502, body: {} })) as OdooError).transient, true);
  assert.equal(((await run({ status: 422, body: { message: "bad" } })) as OdooError).transient, false);
  assert.equal(((await run(new Error("socket hang up"))) as OdooError).transient, true);
});

test("send to ZATCA = the Send & Print wizard with 'To ZATCA' ticked and nothing e-mailed", async () => {
  const { calls, odoo } = scripted([
    [11],
    [
      {
        extra_edi_checkboxes: { sa_edi_test: { checked: false, label: "To ZATCA (Testing)" } },
        sending_method_checkboxes: { email: { checked: true, label: "Email" } },
      },
    ],
    true,
    { type: "ir.actions.act_window_close" },
  ]);
  await odoo.sendToZatca(500);
  assert.deepEqual(
    calls.map((c) => c.url.split("/json/2/")[1]),
    [
      "account.move.send.wizard/create",
      "account.move.send.wizard/read",
      "account.move.send.wizard/write",
      "account.move.send.wizard/action_send_and_print",
    ],
  );
  const write = calls[2].body as {
    ids: number[];
    vals: {
      extra_edi_checkboxes: Record<string, { checked: boolean }>;
      sending_method_checkboxes: Record<string, { checked: boolean }>;
    };
  };
  assert.deepEqual(write.ids, [11]);
  assert.equal(write.vals.extra_edi_checkboxes.sa_edi_test.checked, true);
  assert.equal(write.vals.sending_method_checkboxes.email.checked, false);
  assert.deepEqual((calls[0].body.context as { active_ids: number[] }).active_ids, [500]);

  const none = scripted([[12], [{ extra_edi_checkboxes: {}, sending_method_checkboxes: {} }]]);
  await assert.rejects(() => none.odoo.sendToZatca(1), /ZATCA is not available/);
});

test("cash payment, partner and product lookup, PDF", async () => {
  const pay = scripted([[21], true]);
  await pay.odoo.registerPayment(500, 9, "2026-10-22");
  assert.deepEqual(
    pay.calls.map((c) => c.url.split("/json/2/")[1]),
    ["account.payment.register/create", "account.payment.register/action_create_payments"],
  );
  assert.deepEqual((pay.calls[0].body.vals_list as unknown[])[0], { journal_id: 9, payment_date: "2026-10-22" });
  assert.deepEqual(pay.calls[1].body.ids, [21]);

  assert.equal(await scripted([[{ id: 5 }]]).odoo.findPartner({ vat: "300000000000003", name: "x" }), 5);
  assert.equal(
    await scripted([
      [{ id: 5 }, { id: 6 }],
      [{ id: 9 }, { id: 10 }],
    ]).odoo.findPartner({ vat: "300000000000003", name: "x" }),
    null,
    "two matches: a person decides",
  );
  assert.equal(await scripted([[{ id: 70 }]]).odoo.findProduct("SHAMI - 5"), 70);
  assert.equal(await scripted([[]]).odoo.findProduct("Nothing"), null);

  const m = scripted([
    [
      {
        id: 500,
        name: "INV/1",
        state: "posted",
        payment_state: "paid",
        amount_untaxed: 87,
        amount_total: 100.05,
        l10n_sa_edi_state: "accepted",
        l10n_sa_uuid: "u",
        invoice_pdf_report_id: [88, "x.pdf"],
      },
    ],
  ]);
  const mv = await m.odoo.findInvoiceByRef("WA-ABC");
  assert.deepEqual([mv?.pdfAttachmentId, mv?.zatcaState, mv?.amountTotal], [88, "accepted", 100.05]);
  assert.deepEqual(m.calls[0].body.domain, [
    ["ref", "=", "WA-ABC"],
    ["move_type", "=", "out_invoice"],
  ]);
  assert.equal((await scripted([[{ name: "a.pdf", datas: "QUJD" }]]).odoo.pdf(88))?.base64, "QUJD");
});

test("PDF: a PDF older than the accepted ZATCA file is deleted and Odoo makes a new one", async () => {
  const stale = scripted([
    [{ invoice_pdf_report_id: [241, "old.pdf"], l10n_sa_edi_document_id: [1, ""] }],
    [{ attachment_id: [247, "x.xml"] }],
    [
      { id: 241, create_date: "2026-10-22 06:07:24" },
      { id: 247, create_date: "2026-10-22 06:09:34" },
    ],
    true,
    [31],
    [{ sending_method_checkboxes: { email: { checked: true, label: "by Email" } } }],
    true,
    { type: "ir.actions.act_window_close" },
    [{ invoice_pdf_report_id: [249, "new.pdf"] }],
  ]);
  assert.equal(await stale.odoo.renderFreshPdf(1), 249);
  assert.deepEqual(
    stale.calls.map((c) => c.url.split("/json/2/")[1]),
    [
      "account.move/read",
      "l10n_sa_edi.document/read",
      "ir.attachment/read",
      "ir.attachment/unlink",
      "account.move.send.wizard/create",
      "account.move.send.wizard/read",
      "account.move.send.wizard/write",
      "account.move.send.wizard/action_send_and_print",
      "account.move/read",
    ],
  );
  assert.equal(
    (stale.calls[6].body.vals as { sending_method_checkboxes: { email: { checked: boolean } } })
      .sending_method_checkboxes.email.checked,
    false,
  );

  const fresh = scripted([
    [{ invoice_pdf_report_id: [250, "pdf"], l10n_sa_edi_document_id: [1, ""] }],
    [{ attachment_id: [247, "x.xml"] }],
    [
      { id: 250, create_date: "2026-10-22 06:09:40" },
      { id: 247, create_date: "2026-10-22 06:09:34" },
    ],
  ]);
  assert.equal(await fresh.odoo.renderFreshPdf(1), 250);
  assert.equal(fresh.calls.length, 3, "nothing is deleted or re-made when the PDF is already newer");
});
