import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, publicEncrypt, randomBytes, constants } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import QRCode from "qrcode";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { app } from "../main.ts";
import { makeFlowToken, readFlowToken, verifyMetaSignature } from "../lib/crypto.ts";
import { decryptFlowRequest, encryptFlowResponse, FlowDecryptError, loadPrivateKey } from "../lib/flow-crypto.ts";
import { decryptFlowMedia, encryptFlowMediaForTest } from "../lib/flow-media.ts";
import { handleFlowRequest } from "../lib/flow-handler.ts";
import { decodeQrFromImage } from "../lib/qr-image.ts";
import { MemoryStore } from "../lib/store.ts";
import { ENV, rsaKey, SAMPLE_QR, seedUsers, setup, sign } from "./helpers.ts";

const PASS = "correct horse battery";
const { publicKey, privateKey } = rsaKey(PASS);

/** Acts as WhatsApp: encrypts a request for our public key, decrypts our response. */
function whatsapp(body: unknown) {
  const aes = randomBytes(16), iv = randomBytes(16);
  const c = createCipheriv("aes-128-gcm", aes, iv);
  const data = Buffer.concat([c.update(JSON.stringify(body)), c.final(), c.getAuthTag()]);
  const envelope = {
    encrypted_flow_data: data.toString("base64"), initial_vector: iv.toString("base64"),
    encrypted_aes_key: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, aes).toString("base64"),
  };
  const raw = JSON.stringify(envelope);
  return {
    raw,
    read(text: string) {
      const buf = Buffer.from(text, "base64");
      const d = createDecipheriv("aes-128-gcm", aes, Buffer.from(iv.map((b) => ~b & 0xff)));
      d.setAuthTag(buf.subarray(buf.length - 16));
      return JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString());
    },
  };
}
const callFlow = async (body: unknown, opts: { badSig?: boolean } = {}) => {
  const w = whatsapp(body);
  const res = await app.request("/api/flow", { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sign(w.raw, opts.badSig ? "nope" : ENV.WA_APP_SECRET) }, body: w.raw });
  return { res, json: res.status === 200 ? w.read(await res.text()) : null };
};

describe("Flow encryption", () => {
  it("round trip: RSA-OAEP-SHA256 key unwrap + AES-128-GCM with flipped IV (passphrase-protected key)", () => {
    const w = whatsapp({ action: "ping" });
    const key = loadPrivateKey(privateKey, PASS);
    const dec = decryptFlowRequest(JSON.parse(w.raw), key);
    assert.deepEqual(dec.body, { action: "ping" });
    const out = encryptFlowResponse({ data: { status: "active" } }, dec.aesKey, dec.iv);
    assert.deepEqual(w.read(out), { data: { status: "active" } });
  });
  it("wrong passphrase / tampered ciphertext fails", () => {
    assert.throws(() => loadPrivateKey(privateKey, "wrong"));
    const w = whatsapp({ action: "ping" });
    const env = JSON.parse(w.raw);
    const bytes = Buffer.from(env.encrypted_flow_data, "base64"); bytes[0] ^= 1; env.encrypted_flow_data = bytes.toString("base64");
    assert.throws(() => decryptFlowRequest(env, loadPrivateKey(privateKey, PASS)), FlowDecryptError);
  });
  it("flow tokens bind phone, expire, and cannot be forged", () => {
    const t = makeFlowToken("+966500000002", "s", 60, 1_000_000);
    assert.deepEqual(readFlowToken(t, "s", 1_000_000 + 1000), { phone: "+966500000002" });
    assert.equal(readFlowToken(t, "s", 1_000_000 + 61_000), null);
    assert.equal(readFlowToken(t, "other"), null);
    assert.equal(readFlowToken(t.replace("966500000002", "966500000009"), "s", 1_000_000), null);
  });
  it("signature helper", () => assert.equal(verifyMetaSignature("x", sign("x"), ENV.WA_APP_SECRET), true));
});

describe("QR image decoding", () => {
  async function qrPng(width: number, text = SAMPLE_QR) {
    return new Uint8Array(await QRCode.toBuffer(text, { width, margin: 4, errorCorrectionLevel: "M" }));
  }
  it("decodes a PNG QR", async () => assert.equal(decodeQrFromImage(await qrPng(400)), SAMPLE_QR));
  it("decodes a large, low-contrast JPEG photo-like image (multi-scale + contrast stretch)", async () => {
    const png = PNG.sync.read(Buffer.from(await qrPng(1800)));
    // paste onto a bigger grey canvas and squash contrast to 110..150
    const W = 2400, H = 2000, canvas = Buffer.alloc(W * H * 4, 128);
    for (let i = 3; i < canvas.length; i += 4) canvas[i] = 255;
    for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
      const s = (y * png.width + x) * 4, d = ((y + 100) * W + x + 300) * 4;
      const v = png.data[s] > 128 ? 150 : 110;
      canvas[d] = canvas[d + 1] = canvas[d + 2] = v;
    }
    const jpg = jpeg.encode({ data: canvas, width: W, height: H }, 80).data;
    assert.equal(decodeQrFromImage(new Uint8Array(jpg)), SAMPLE_QR);
  });
  it("returns null when there is no QR", () => {
    const blank = Buffer.alloc(300 * 300 * 4, 255);
    assert.equal(decodeQrFromImage(new Uint8Array(jpeg.encode({ data: blank, width: 300, height: 300 }, 80).data)), null);
  });
  it("PhotoPicker media decrypt round trip + tamper detection", () => {
    const plain = randomBytes(5000);
    const { data, meta } = encryptFlowMediaForTest(plain);
    assert.deepEqual(Buffer.from(decryptFlowMedia(data, meta)), plain);
    const bad = Buffer.from(data); bad[3] ^= 1;
    assert.throws(() => decryptFlowMedia(bad, meta));
  });
});

describe("POST /api/flow", () => {
  let store: MemoryStore;
  let token: string;
  beforeEach(async () => {
    store = setup();
    process.env.WA_FLOW_PRIVATE_KEY = privateKey;
    process.env.WA_FLOW_PRIVATE_KEY_PASSPHRASE = PASS;
    await seedUsers(store);
    token = makeFlowToken("+966500000002", ENV.WA_APP_SECRET);
    await store.insert("categories", { section: "bakery", name: "Packaging", name_ar: "تغليف", active: true });
  });

  it("health-check ping, INIT, and error notification", async () => {
    assert.deepEqual((await callFlow({ action: "ping", version: "3.0" })).json, { data: { status: "active" } });
    const init = (await callFlow({ action: "INIT", flow_token: token, version: "3.0" })).json;
    assert.equal(init.screen, "SECTION");
    assert.deepEqual(init.data.sections.map((s: any) => s.id), ["bakery"]); // only permitted sections
    const err = (await callFlow({ action: "data_exchange", flow_token: token, data: { error: "boom", error_message: "x" } })).json;
    assert.deepEqual(err, { data: { acknowledged: true } });
  });
  it("rejects bad signature (432) and bad ciphertext (421)", async () => {
    assert.equal((await callFlow({ action: "ping" }, { badSig: true })).res.status, 432);
    const raw = JSON.stringify({ encrypted_flow_data: "AAAA", encrypted_aes_key: "AAAA", initial_vector: "AAAA" });
    const r = await app.request("/api/flow", { method: "POST", headers: { "x-hub-signature-256": sign(raw) }, body: raw });
    assert.equal(r.status, 421);
  });
  it("expired/forged flow_token gets the FAILURE screen", async () => {
    const r = (await callFlow({ action: "INIT", flow_token: "bogus" })).json;
    assert.equal(r.screen, "FAILURE");
  });

  const photoFetch = async (png: Uint8Array) => {
    const { data, meta } = encryptFlowMediaForTest(png);
    const f: typeof fetch = async () => new Response(data as BodyInit);
    return { f, media: { cdn_url: "https://cdn.example/x", file_name: "p.png", mime_type: "image/png", encryption_metadata: meta } };
  };
  const deps = (f: typeof fetch) => ({ store, f, appSecret: ENV.WA_APP_SECRET });

  it("full journey: photo -> CONFIRM -> edited total -> SUCCESS; same invoice again -> DUPLICATE", async () => {
    const png = new Uint8Array(await QRCode.toBuffer(SAMPLE_QR, { width: 500, margin: 4 }));
    const { f, media } = await photoFetch(png);
    const scan = await handleFlowRequest({ action: "data_exchange", flow_token: token, data: { action: "scan", section: "bakery", photo: [media] } }, deps(f));
    assert.equal(scan.screen, "CONFIRM");
    const d = (scan as any).data;
    assert.equal(d.total, 145.52); // number: the Flow's numeric TextInput requires a number
    assert.match(d.summary, /شركة مخابز ايمان جدة للخبز/);
    assert.ok(d.image_path.startsWith("flow/966500000002/"));
    assert.equal(store.objects.size, 1);
    assert.deepEqual(d.categories, [{ id: "Packaging", title: "تغليف / Packaging" }]);

    const confirm = (extra: object = {}) => handleFlowRequest({ action: "data_exchange", flow_token: token, data: { action: "confirm", section: "bakery", raw_qr: d.raw_qr, image_path: d.image_path, total: String(d.total), notes: "morning delivery", category: "Packaging", ...extra } }, deps(f));
    const done = await confirm({ total: "150.00" });
    assert.equal((done as any).screen, "SUCCESS");
    const row = store.tables.bakery_expenses[0];
    assert.equal(row.total_amount, 150);
    assert.equal(row.source, "whatsapp_flow");
    assert.equal(row.category, "Packaging");
    assert.match(row.notes, /edited/);
    assert.equal(row.image_path, d.image_path);
    // editing the total must not bypass duplicate detection of the original invoice
    const again = await confirm({ total: "151.00" });
    assert.equal((again as any).screen, "DUPLICATE");
    assert.equal(store.tables.bakery_expenses.length, 1);
  });
  it("unreadable photo -> RETRY, pasted text -> CONFIRM", async () => {
    const blank = new Uint8Array(PNG.sync.write(new PNG({ width: 300, height: 300 })));
    const { f, media } = await photoFetch(blank);
    const retry = await handleFlowRequest({ action: "data_exchange", flow_token: token, data: { action: "scan", section: "bakery", photo: [media] } }, deps(f));
    assert.equal(retry.screen, "RETRY");
    // a second failed attempt must end the Flow (a Flow routing model cannot loop RETRY -> RETRY)
    const again = await handleFlowRequest({ action: "data_exchange", flow_token: token, data: { action: "retry", section: "bakery", photo: [media] } }, deps(f));
    assert.equal(again.screen, "FAILURE");
    const viaText = await handleFlowRequest({ action: "data_exchange", flow_token: token, data: { action: "retry", section: "bakery", qr_text: SAMPLE_QR } }, deps(f));
    assert.equal(viaText.screen, "CONFIRM");
  });
  it("tampering: other user's image path ignored, other section refused, garbage QR refused", async () => {
    const f: typeof fetch = async () => new Response("");
    const base = { action: "confirm", section: "bakery", raw_qr: SAMPLE_QR, total: "145.52" };
    const r = await handleFlowRequest({ action: "data_exchange", flow_token: token, data: { ...base, image_path: "flow/966599999999/evil.jpg" } }, deps(f));
    assert.equal(r.screen, "SUCCESS");
    assert.equal(store.tables.bakery_expenses[0].image_path, null);
    const g = await handleFlowRequest({ action: "data_exchange", flow_token: token, data: { ...base, section: "grocery" } }, deps(f));
    assert.equal(g.screen, "FAILURE");
    const bad = await handleFlowRequest({ action: "data_exchange", flow_token: token, data: { ...base, raw_qr: "AAAA" } }, deps(f));
    assert.equal(bad.screen, "FAILURE");
  });
});
