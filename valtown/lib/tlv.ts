// ZATCA (Saudi e-invoice) QR parser: Base64 -> bytes -> TLV.
// Phase 1 tags: 1 seller, 2 VAT no, 3 timestamp, 4 total (incl. VAT), 5 VAT amount.
// Phase 2 adds 6 hash, 7 ECDSA signature, 8 public key, 9 certificate signature (tolerated, kept raw).

export interface ParsedInvoice {
  seller_name: string;
  vat_number: string;
  invoice_date: string; // ISO-8601 with offset, e.g. 2026-08-11T15:19:20+03:00
  total_amount: number;
  vat_amount: number;
  raw_qr: string;
  phase: 1 | 2;
  extra_tags: number[];
}

export class QrParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QrParseError";
  }
}

const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

export function normalizeDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (c) => {
    const i = ARABIC_DIGITS.indexOf(c);
    return String(i >= 0 ? i : PERSIAN_DIGITS.indexOf(c));
  });
}

export function base64ToBytes(input: string): Uint8Array {
  let s = input.trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+=*$/.test(s)) throw new QrParseError("Not valid Base64");
  s = s.replace(/=+$/, "");
  if (s.length % 4 === 1) throw new QrParseError("Not valid Base64 length");
  s += "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

type Tlv = Map<number, Uint8Array>;
type LengthMode = "single" | "der";

/** Reads TLV records. "single": 1-byte length (ZATCA standard). "der": 0x81/0x82 multi-byte lengths. */
function readTlv(bytes: Uint8Array, mode: LengthMode): { tags: Tlv; consumed: number } | null {
  const tags: Tlv = new Map();
  let i = 0;
  while (i < bytes.length) {
    const tag = bytes[i++];
    if (i >= bytes.length) return null;
    let len = bytes[i++];
    if (mode === "der" && len >= 0x80) {
      const n = len & 0x7f;
      if (n < 1 || n > 2 || i + n > bytes.length) return null;
      len = 0;
      for (let k = 0; k < n; k++) len = (len << 8) | bytes[i++];
    }
    if (i + len > bytes.length) return null;
    if (tag === 0) return null;
    if (!tags.has(tag)) tags.set(tag, bytes.subarray(i, i + len));
    i += len;
  }
  return { tags, consumed: i };
}

export function parseTlv(bytes: Uint8Array): Tlv {
  const a = readTlv(bytes, "single");
  const b = readTlv(bytes, "der");
  // Prefer the reading that yields the mandatory tags; fall back to whichever parsed.
  const ok = (r: ReturnType<typeof readTlv>) => r && [1, 2, 3, 4, 5].every((t) => r.tags.has(t));
  if (ok(a)) return a!.tags;
  if (ok(b)) return b!.tags;
  const partial = lenientTlv(bytes);
  if (partial.size) return partial;
  throw new QrParseError("QR content is not valid TLV");
}

/** Stops at the first malformed record, keeping what was read (tags 1-5 come first in every ZATCA QR). */
function lenientTlv(bytes: Uint8Array): Tlv {
  const tags: Tlv = new Map();
  let i = 0;
  while (i + 2 <= bytes.length) {
    const tag = bytes[i];
    const len = bytes[i + 1];
    if (tag === 0 || i + 2 + len > bytes.length) break;
    if (!tags.has(tag)) tags.set(tag, bytes.subarray(i + 2, i + 2 + len));
    i += 2 + len;
  }
  return tags;
}

const dec = new TextDecoder("utf-8", { fatal: false });
const text = (b: Uint8Array | undefined) => (b ? dec.decode(b).replace(/\u0000/g, "").trim() : "");

export function parseAmount(raw: string): number {
  const s = normalizeDigits(raw).replace(/[^\d.,-]/g, "").replace(/,(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const n = Number(s);
  if (!Number.isFinite(n)) throw new QrParseError(`Invalid amount "${raw}"`);
  return Math.round(n * 100) / 100;
}

/** ZATCA timestamps are Saudi local time (UTC+3). Naive and "Z" values are interpreted as Asia/Riyadh. */
export function normalizeTimestamp(raw: string): string {
  const s = normalizeDigits(raw.trim());
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) throw new QrParseError(`Invalid timestamp "${raw}"`);
  const [, y, mo, d, h = "00", mi = "00", se = "00", tz] = m;
  let offset = "+03:00";
  if (tz && tz.toUpperCase() !== "Z") offset = tz.length === 5 ? `${tz.slice(0, 3)}:${tz.slice(3)}` : tz;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${se}${offset}`;
  if (Number.isNaN(Date.parse(iso))) throw new QrParseError(`Invalid timestamp "${raw}"`);
  return iso;
}

export function parseZatcaQr(rawQr: string): ParsedInvoice {
  const raw = rawQr.trim();
  const tags = parseTlv(base64ToBytes(raw));
  const missing = [1, 2, 3, 4, 5].filter((t) => !tags.has(t));
  if (missing.length) throw new QrParseError(`Missing TLV tags: ${missing.join(", ")}`);
  const vat_number = normalizeDigits(text(tags.get(2))).replace(/\s/g, "");
  if (!/^\d{15}$/.test(vat_number)) throw new QrParseError("VAT number must be 15 digits");
  const extra_tags = [...tags.keys()].filter((t) => t > 5).sort((a, b) => a - b);
  return {
    seller_name: text(tags.get(1)),
    vat_number,
    invoice_date: normalizeTimestamp(text(tags.get(3))),
    total_amount: parseAmount(text(tags.get(4))),
    vat_amount: parseAmount(text(tags.get(5))),
    raw_qr: raw,
    phase: extra_tags.length ? 2 : 1,
    extra_tags,
  };
}

/** Encoder used by tests/tools to produce QR payloads. */
export function encodeZatcaQr(fields: Record<number, string | Uint8Array>): string {
  const enc = new TextEncoder();
  const parts: number[] = [];
  for (const [k, v] of Object.entries(fields)) {
    const b = typeof v === "string" ? enc.encode(v) : v;
    if (b.length > 255) throw new Error("value too long for single-byte length");
    parts.push(Number(k), b.length, ...b);
  }
  return bytesToBase64(Uint8Array.from(parts));
}
