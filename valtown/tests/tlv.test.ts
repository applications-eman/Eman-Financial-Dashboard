import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { base64ToBytes, bytesToBase64, encodeZatcaQr, normalizeTimestamp, parseAmount, parseZatcaQr, QrParseError } from "../lib/tlv.ts";

const SAMPLE = {
  1: "شركة مخابز ايمان جدة للخبز",
  2: "312028501300003",
  3: "2026-08-11T15:19:20",
  4: "145.52",
  5: "18.98",
};

describe("ZATCA TLV parser", () => {
  const qr = encodeZatcaQr(SAMPLE);
  it("parses the Arabic bakery sample (UTF-8 safe)", () => {
    const p = parseZatcaQr(qr);
    assert.equal(p.seller_name, "شركة مخابز ايمان جدة للخبز");
    assert.equal(p.vat_number, "312028501300003");
    assert.equal(p.invoice_date, "2026-08-11T15:19:20+03:00");
    assert.equal(p.total_amount, 145.52);
    assert.equal(p.vat_amount, 18.98);
    assert.equal(p.phase, 1);
    assert.equal(p.raw_qr, qr);
  });
  it("the same instant is produced for naive and Z timestamps (Riyadh local)", () => {
    assert.equal(normalizeTimestamp("2026-08-11T15:19:20Z"), "2026-08-11T15:19:20+03:00");
    assert.equal(normalizeTimestamp("2026-08-11T15:19:20+0100"), "2026-08-11T15:19:20+01:00");
  });
  it("tolerates Phase 2 tags 6-9 including long binary values", () => {
    const sig = new Uint8Array(70).fill(7);
    const key = new Uint8Array(88).fill(9);
    const p = parseZatcaQr(encodeZatcaQr({ ...SAMPLE, 6: "aGFzaA==", 7: sig, 8: key, 9: new Uint8Array(64).fill(1) }));
    assert.equal(p.phase, 2);
    assert.deepEqual(p.extra_tags, [6, 7, 8, 9]);
    assert.equal(p.total_amount, 145.52);
  });
  it("handles DER-style multi-byte lengths (0x81 / 0x82)", () => {
    const enc = new TextEncoder();
    const parts: number[] = [];
    const push = (tag: number, b: Uint8Array) => {
      parts.push(tag);
      if (b.length < 128) parts.push(b.length);
      else if (b.length < 256) parts.push(0x81, b.length);
      else parts.push(0x82, b.length >> 8, b.length & 255);
      parts.push(...b);
    };
    for (const [k, v] of Object.entries(SAMPLE)) push(Number(k), enc.encode(v));
    push(8, new Uint8Array(300).fill(5));
    const p = parseZatcaQr(bytesToBase64(Uint8Array.from(parts)));
    assert.equal(p.vat_amount, 18.98);
  });
  it("tolerates url-safe base64, whitespace, missing padding", () => {
    const messy = ` ${qr.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}\n`;
    assert.equal(parseZatcaQr(messy).vat_number, "312028501300003");
    assert.ok(base64ToBytes(messy).length > 20);
  });
  it("accepts Arabic-Indic digits and thousands separators", () => {
    const p = parseZatcaQr(encodeZatcaQr({ ...SAMPLE, 2: "٣١٢٠٢٨٥٠١٣٠٠٠٠٣", 4: "1,145.52" }));
    assert.equal(p.vat_number, "312028501300003");
    assert.equal(p.total_amount, 1145.52);
    assert.equal(parseAmount("12,5"), 12.5);
  });
  it("rejects garbage, missing tags and bad VAT numbers", () => {
    assert.throws(() => parseZatcaQr("not base64 !!"), QrParseError);
    assert.throws(() => parseZatcaQr(encodeZatcaQr({ 1: "x", 2: "312028501300003" })), /Missing TLV tags/);
    assert.throws(() => parseZatcaQr(encodeZatcaQr({ ...SAMPLE, 2: "12345" })), /15 digits/);
    assert.throws(() => parseZatcaQr(encodeZatcaQr({ ...SAMPLE, 3: "yesterday" })), /timestamp/);
    assert.throws(() => parseZatcaQr("AAAA"), QrParseError);
  });
});
