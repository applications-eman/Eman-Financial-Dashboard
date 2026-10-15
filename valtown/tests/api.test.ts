import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { app } from "../main.ts";
import { MemoryStore } from "../lib/store.ts";
import { ENV, SAMPLE_QR, seedUsers, setup, sign } from "./helpers.ts";
import { encodeZatcaQr } from "../lib/tlv.ts";
import { signHs256 } from "../lib/jwt.ts";

let store: MemoryStore;
let u: Awaited<ReturnType<typeof seedUsers>>;
beforeEach(async () => { store = setup(); u = await seedUsers(store); });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("POST /api/expense (iOS Shortcut)", () => {
  const fields = { section: "bakery", seller_name: "Mill", vat_number: "312028501300003", invoice_date: "2026-08-11T15:19:20", total_amount: 145.52, vat_amount: 18.98 };
  it("saves, then reports duplicate on the second post", async () => {
    const a = await post("/api/expense", { ...fields, token: u.staffToken });
    assert.equal(a.status, 201);
    assert.equal((await a.json()).status, "saved");
    const b = await post("/api/expense", { ...fields, token: u.staffToken });
    const bj = await b.json();
    assert.equal(bj.status, "duplicate");
    assert.equal(store.tables.bakery_expenses.length, 1);
    assert.equal(store.tables.bakery_expenses[0].duplicate_count, 1);
  });
  it("accepts raw_qr alone and parses server-side (Arabic seller preserved)", async () => {
    const r = await post("/api/expense", { section: "bakery", raw_qr: SAMPLE_QR, token: u.staffToken });
    assert.equal((await r.json()).status, "saved");
    const row = store.tables.bakery_expenses[0];
    assert.equal(row.seller_name, "شركة مخابز ايمان جدة للخبز");
    assert.equal(row.total_amount, 145.52);
    assert.equal(row.source, "ios_shortcut");
    assert.equal(row.submitted_by, "Ali");
  });
  it("rejects bad token, inactive user, wrong section, invalid data", async () => {
    assert.equal((await post("/api/expense", { ...fields, token: "eb_nottherealtoken" })).status, 401);
    assert.equal((await post("/api/expense", { ...fields, token: u.inactiveToken })).status, 401);
    assert.equal((await post("/api/expense", { ...fields, section: "grocery", token: u.staffToken })).status, 403);
    const inv = await post("/api/expense", { ...fields, vat_number: "123", token: u.staffToken });
    assert.equal(inv.status, 422);
    assert.equal((await inv.json()).status, "invalid");
    const inv2 = await post("/api/expense", { ...fields, vat_amount: 999, token: u.staffToken });
    assert.equal(inv2.status, 422);
    assert.equal((await post("/api/expense", "{nope", {})).status, 400);
    assert.equal(store.tables.bakery_expenses?.length ?? 0, 0);
  });
  it("stores only hashes (no plaintext token in DB) and throttles brute force", async () => {
    assert.ok(!JSON.stringify(store.tables.app_users).includes(u.staffToken));
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await post("/api/expense", { ...fields, token: `eb_wrong_token_${i}` })).status;
    assert.equal(last, 429);
  });
});

describe("WhatsApp webhook", () => {
  const msg = (id: string, text: string, from = "966500000002") => JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id, from, type: "text", text: { body: text } }] } }] }] });
  it("GET verification uses WA_VERIFY_TOKEN", async () => {
    const ok = await app.request(`/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${ENV.WA_VERIFY_TOKEN}&hub.challenge=1234`);
    assert.equal(await ok.text(), "1234");
    assert.equal((await app.request("/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=1")).status, 403);
  });
  it("rejects missing/forged signatures", async () => {
    const body = msg("wamid.1", SAMPLE_QR);
    assert.equal((await post("/whatsapp/webhook", body)).status, 401);
    assert.equal((await post("/whatsapp/webhook", body, { "x-hub-signature-256": sign(body, "other-secret") })).status, 401);
    assert.equal((await post("/whatsapp/webhook", body, { "x-hub-signature-256": sign(body + " ") })).status, 401);
  });
  it("saves a Base64 text message once (idempotent on wa_message_id), section from user's only section", async () => {
    const body = msg("wamid.A", SAMPLE_QR);
    const r1 = await (await post("/whatsapp/webhook", body, { "x-hub-signature-256": sign(body) })).json();
    assert.deepEqual(r1.results, ["saved"]);
    const r2 = await (await post("/whatsapp/webhook", body, { "x-hub-signature-256": sign(body) })).json();
    assert.deepEqual(r2.results, ["duplicate_event"]);
    assert.equal(store.tables.bakery_expenses.length, 1);
    assert.equal(store.tables.bakery_expenses[0].source, "whatsapp_text");
  });
  it("parses the five fields sent as labelled text and as plain lines", async () => {
    const t1 = msg("wamid.B", "bakery\nSeller: Test Co\nVAT: 300000000000003\nDate: 2026-09-01 10:00\nTotal: 115\nVAT amount: 15");
    const r1 = await (await post("/whatsapp/webhook", t1, { "x-hub-signature-256": sign(t1) })).json();
    assert.deepEqual(r1.results, ["saved"]);
    const t2 = msg("wamid.C", "Test Co\n300000000000003\n2026-09-02 10:00\n230\n30");
    const r2 = await (await post("/whatsapp/webhook", t2, { "x-hub-signature-256": sign(t2) })).json();
    assert.deepEqual(r2.results, ["saved"]);
    assert.equal(store.tables.bakery_expenses.length, 2);
  });
  it("ignores numbers that are not active app_users", async () => {
    const body = msg("wamid.X", SAMPLE_QR, "966599999999");
    const r = await (await post("/whatsapp/webhook", body, { "x-hub-signature-256": sign(body) })).json();
    assert.deepEqual(r.results, ["ignored_unregistered"]);
    const inactive = msg("wamid.Y", SAMPLE_QR, "966500000003");
    const r2 = await (await post("/whatsapp/webhook", inactive, { "x-hub-signature-256": sign(inactive) })).json();
    assert.deepEqual(r2.results, ["ignored_unregistered"]);
    assert.equal(store.tables.bakery_expenses?.length ?? 0, 0);
  });
  it("respects the whatsapp_text feature flag", async () => {
    await store.insert("feature_flags", { key: "whatsapp_text", enabled: false });
    const body = msg("wamid.F", SAMPLE_QR);
    const r = await (await post("/whatsapp/webhook", body, { "x-hub-signature-256": sign(body) })).json();
    assert.deepEqual(r.results, ["disabled"]);
  });
});

describe("WhatsApp guided capture (reply buttons, no Flow)", () => {
  const text = (id: string, from: string, body: string) => JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id, from, type: "text", text: { body } }] } }] }] });
  const tap = (id: string, from: string, btn: string) => JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id, from, type: "interactive", interactive: { type: "button_reply", button_reply: { id: btn, title: "x" } } }] } }] }] });
  const send = async (raw: string) => (await (await post("/whatsapp/webhook", raw, { "x-hub-signature-256": sign(raw) })).json()).results[0];
  const qr2 = encodeZatcaQr({ 1: "Guided Co", 2: "300000000000003", 3: "2026-09-05T10:00:00", 4: "115.00", 5: "15.00" });

  it("multi-section admin: hi -> buttons -> tap Grocery -> QR text is saved to GROCERY, then pending is cleared", async () => {
    const admin = "966500000001";
    assert.equal(await send(text("m1", admin, "مصروف")), "capture_started");
    assert.equal(await send(tap("m2", admin, "sec:grocery")), "section_selected");
    assert.equal(await send(text("m3", admin, qr2)), "saved");
    assert.equal(store.tables.grocery_expenses.length, 1);
    assert.equal(store.tables.bakery_expenses?.length ?? 0, 0);
    // next invoice without choosing again must ask for the section instead of guessing
    const qr3 = encodeZatcaQr({ 1: "Guided Co", 2: "300000000000003", 3: "2026-09-06T10:00:00", 4: "230.00", 5: "30.00" });
    assert.equal(await send(text("m4", admin, qr3)), "ambiguous_section");
    assert.equal(store.tables.grocery_expenses.length, 1);
  });
  it("duplicate through the guided path is reported and not stored twice", async () => {
    const admin = "966500000001";
    await send(tap("d1", admin, "sec:bakery"));
    assert.equal(await send(text("d2", admin, qr2)), "saved");
    await send(tap("d3", admin, "sec:bakery"));
    assert.equal(await send(text("d4", admin, qr2)), "duplicate");
    assert.equal(store.tables.bakery_expenses.length, 1);
  });
  it("single-section staff skip the buttons; 'Hi,' with a comma works; unreadable text keeps the section selected", async () => {
    const ali = "966500000002";
    assert.equal(await send(text("s1", ali, "Hi,")), "capture_started");
    assert.equal(await send(text("s2", ali, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")), "invalid");
    assert.equal(await send(text("s3", ali, qr2)), "saved");
    assert.equal(store.tables.bakery_expenses.length, 1);
  });
  it("a staff member cannot pick a section they do not have; strangers' taps are ignored", async () => {
    assert.equal(await send(tap("x1", "966500000002", "sec:grocery")), "section_not_allowed");
    assert.equal(await send(tap("x2", "966599999999", "sec:bakery")), "ignored_unregistered");
  });
  it("pending choice expires after 15 minutes", async () => {
    const { setPending, getPending } = await import("../lib/wa-session.ts");
    await setPending(store, "+966500000001", "bakery", Date.now() - 16 * 60_000);
    assert.equal(await getPending(store, "+966500000001"), null);
  });
});

describe("Admin API auth", () => {
  const now = Math.floor(Date.now() / 1000);
  const jwt = (sub: string, extra: Record<string, unknown> = {}, secret = ENV.SUPABASE_JWT_SECRET) =>
    signHs256({ sub, aud: "authenticated", exp: now + 3600, iss: `${ENV.SUPABASE_URL}/auth/v1`, email: "admin@x.com", ...extra }, secret);
  const get = (path: string, token?: string, headers: Record<string, string> = {}) =>
    app.request(path, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });

  it("401 without / with forged / expired token", async () => {
    assert.equal((await get("/admin/me")).status, 401);
    assert.equal((await get("/admin/me", jwt(u.admin.auth_user_id, {}, "wrong-secret-wrong-secret-wrong"))).status, 401);
    assert.equal((await get("/admin/me", jwt(u.admin.auth_user_id, { exp: now - 10 }))).status, 401);
    assert.equal((await get("/admin/me", jwt(u.admin.auth_user_id, { aud: "anon" }))).status, 401);
  });
  it("403 for staff and unknown users, 200 for admin", async () => {
    assert.equal((await get("/admin/me", jwt(u.staff.auth_user_id))).status, 403);
    assert.equal((await get("/admin/me", jwt("cccccccc-0000-0000-0000-000000000003"))).status, 403);
    const ok = await get("/admin/me", jwt(u.admin.auth_user_id));
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).role, "admin");
  });
  it("CORS only allows ALLOWED_ORIGIN", async () => {
    const good = await app.request("/admin/me", { method: "OPTIONS", headers: { origin: ENV.ALLOWED_ORIGIN, "access-control-request-method": "GET" } });
    assert.equal(good.headers.get("access-control-allow-origin"), ENV.ALLOWED_ORIGIN);
    const evil = await app.request("/admin/me", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    assert.notEqual(evil.headers.get("access-control-allow-origin"), "https://evil.example");
  });
  it("token generate/rotate shows token once and never returns hashes", async () => {
    const t = jwt(u.admin.auth_user_id);
    const auth = { authorization: `Bearer ${t}`, "content-type": "application/json" };
    const r1 = await (await app.request(`/admin/users/${u.staff.id}/token`, { method: "POST", headers: auth })).json();
    assert.match(r1.token, /^eb_/);
    const list = JSON.stringify(await (await get("/admin/users", t)).json());
    assert.ok(!list.includes(r1.token) && !list.includes("token_hash"));
    // new token works, old one is dead
    const ok = await post("/api/expense", { section: "bakery", raw_qr: SAMPLE_QR, token: r1.token });
    assert.equal((await ok.json()).status, "saved");
    assert.equal((await post("/api/expense", { section: "bakery", raw_qr: SAMPLE_QR, token: u.staffToken })).status, 401);
  });
  it("edits are validated and carry the admin as actor", async () => {
    const t = jwt(u.admin.auth_user_id);
    const auth = { authorization: `Bearer ${t}`, "content-type": "application/json" };
    await post("/api/expense", { section: "bakery", raw_qr: SAMPLE_QR, token: u.staffToken });
    const id = store.tables.bakery_expenses[0].id;
    const patch = (b: unknown) => app.request(`/admin/expenses/bakery/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify(b) });
    const ok = await patch({ status: "reviewed", category: "Packaging" });
    assert.equal(ok.status, 200);
    assert.equal(store.audit.at(-1)?.actor, "admin@x.com");
    assert.equal((await patch({ status: "bogus" })).status, 400);
    assert.equal((await patch({ id: "x", raw_qr: "x" })).status, 400); // unknown keys rejected
    const bulk = await app.request("/admin/expenses/bakery/bulk-status", { method: "POST", headers: auth, body: JSON.stringify({ ids: [id], status: "exported" }) });
    assert.equal((await bulk.json()).updated, 1);
  });
  it("settings: vat_rate validated; export is CSV with BOM and neutralises formulas", async () => {
    const t = jwt(u.admin.auth_user_id);
    const auth = { authorization: `Bearer ${t}`, "content-type": "application/json" };
    const bad = await app.request("/admin/settings/vat_rate", { method: "PUT", headers: auth, body: JSON.stringify({ value: 15 }) });
    assert.equal(bad.status, 422);
    const good = await app.request("/admin/settings/vat_rate", { method: "PUT", headers: auth, body: JSON.stringify({ value: 0.15 }) });
    assert.equal(good.status, 200);
    await post("/api/expense", { section: "bakery", seller_name: "=HYPERLINK(\"x\")", vat_number: "300000000000003", invoice_date: "2026-09-01T10:00:00", total_amount: 115, vat_amount: 15, token: u.staffToken });
    const buf = Buffer.from(await (await get("/admin/export?section=bakery&format=csv", t)).arrayBuffer());
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]); // UTF-8 BOM for Excel
    const csv = buf.toString("utf8");
    assert.ok(csv.includes("section,id,invoice_date"));
    assert.ok(csv.includes("'=HYPERLINK"));
  });
});
