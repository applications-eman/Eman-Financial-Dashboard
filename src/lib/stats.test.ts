import { fmtDate, fmtMoney, riyadhDay } from "./format.ts";
import { byCategory, bySupplier, dailySeries, kpis } from "./stats.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const row = (d: string, total: number, vat: number, seller = "A", category: string | null = null) => ({
  seller_name: seller,
  invoice_date: d,
  total_amount: total,
  vat_amount: vat,
  category,
});

describe("Riyadh time handling", () => {
  it("21:30Z is already the next day in Riyadh (UTC+3)", () => {
    assert.equal(riyadhDay("2026-08-11T21:30:00Z"), "2026-08-12");
    assert.equal(fmtDate("2026-08-11T12:19:20Z"), "11/08/2026");
    assert.equal(fmtMoney(145.5), "145.50");
  });
});
describe("dashboard stats", () => {
  const now = new Date("2026-08-11T12:00:00Z");
  const bakery = [
    row("2026-08-11T12:19:20Z", 145.52, 18.98, "Mill", "Flour"),
    row("2026-08-01T10:00:00Z", 100, 13.04, "Mill", "Flour"),
  ];
  const grocery = [row("2026-08-10T08:00:00Z", 50, 6.52, "Shop"), row("2026-07-31T20:59:00Z", 999, 130, "Old")];
  it("computes today / month KPIs per section", () => {
    const k = kpis(bakery, now);
    assert.deepEqual(k.today, { count: 1, total: 145.52, vat: 18.98 });
    assert.equal(k.month.count, 2);
    assert.equal(k.month.total, 245.52);
    assert.equal(kpis(grocery, now).month.total, 50); // July invoice excluded
  });
  it("daily series covers the window with zero-filled days", () => {
    const s = dailySeries(bakery, grocery, 14, now);
    assert.equal(s.length, 14);
    assert.equal(s.at(-1)?.day, "2026-08-11");
    assert.equal(s.at(-1)?.bakery, 145.52);
    assert.equal(s.find((p) => p.day === "2026-08-10")?.grocery, 50);
    assert.equal(s.find((p) => p.day === "2026-08-05")?.bakery, 0);
  });
  it("ranks categories and suppliers", () => {
    assert.deepEqual(byCategory([...bakery, ...grocery])[0], { name: "", value: 1049 });
    assert.equal(bySupplier(bakery)[0].name, "Mill");
    assert.equal(bySupplier(bakery)[0].count, 2);
  });
});
