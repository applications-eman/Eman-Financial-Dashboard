import { type AlertRow, totalsOf } from "./alerts-types.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const row = (over: Partial<AlertRow> & { detail?: Record<string, unknown> }): AlertRow => ({
  id: 1,
  rule_key: "credit_any",
  severity: "warning",
  title: "t",
  detail: {},
  section: "bakery",
  salesman_name: "A",
  amount: 0,
  status: "open",
  note: null,
  handled_by: null,
  handled_at: null,
  created_at: "2026-10-17T10:00:00Z",
  ...over,
});

describe("totalsOf", () => {
  it("counts each invoice once even when several alerts point to it", () => {
    const list = [
      row({ id: 1, rule_key: "unusual_amount", amount: 1000, detail: { number: "INV/1", kind: "invoice" } }),
      row({ id: 2, rule_key: "zero_tax_invoice", amount: 1000, detail: { number: "INV/1", kind: "invoice" } }),
      row({ id: 3, rule_key: "credit_any", amount: 200, detail: { number: "RINV/1", kind: "credit_note" } }),
      row({ id: 4, rule_key: "credit_amount", amount: 200, detail: { number: "RINV/1", kind: "credit_note" } }),
    ];
    const t = totalsOf(list);
    assert.equal(t.alerts, 4);
    assert.deepEqual([t.invoiceCount, t.invoiceTotal], [1, 1000]);
    assert.deepEqual([t.creditCount, t.creditTotal], [1, 200]);
  });

  it("a repeated-invoice alert counts every invoice in it and reports the value of the extra copies", () => {
    const dup = row({
      id: 5,
      rule_key: "duplicate_burst",
      amount: 50,
      detail: {
        number: "INV/3",
        kind: "invoice",
        invoices: [{ number: "INV/1" }, { number: "INV/2" }, { number: "INV/3" }],
      },
    });
    const t = totalsOf([dup]);
    assert.deepEqual([t.invoiceCount, t.invoiceTotal], [3, 150]);
    assert.equal(t.repeatedExtra, 100);
  });

  it("an invoice that is both in a repeat cluster and flagged on its own is not counted twice", () => {
    const dup = row({
      id: 5,
      rule_key: "duplicate_burst",
      amount: 50,
      detail: { number: "INV/2", invoices: [{ number: "INV/1" }, { number: "INV/2" }] },
    });
    const big = row({ id: 6, rule_key: "unusual_amount", amount: 50, detail: { number: "INV/2", kind: "invoice" } });
    assert.equal(totalsOf([dup, big]).invoiceCount, 2);
  });

  it("an empty list is all zeros", () => {
    assert.deepEqual(totalsOf([]), {
      alerts: 0,
      invoiceCount: 0,
      invoiceTotal: 0,
      creditCount: 0,
      creditTotal: 0,
      repeatedExtra: 0,
    });
  });
});
