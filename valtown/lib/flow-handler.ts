// WhatsApp Flow business logic (post-decryption). Screens: SECTION -> PHOTO -> CONFIRM -> SUCCESS|DUPLICATE
// (RETRY when the QR could not be read, FAILURE for fatal errors). Stateless: the CONFIRM screen carries the raw QR
// text, which is re-parsed server-side, so a tampered client can only change total/notes/category.
import { randomUUID } from "node:crypto";
import { canUseSection, captureExpense, findUserByPhone } from "./capture.ts";
import { readFlowToken } from "./crypto.ts";
import { decryptFlowMedia, type FlowMedia } from "./flow-media.ts";
import { errMsg, logger } from "./log.ts";
import { decodeQrFromImage } from "./qr-image.ts";
import { flagEnabled, money2, sectionLabel } from "./settings.ts";
import type { Row, Store } from "./store.ts";
import { parseZatcaQr } from "./tlv.ts";
import { isSection, type Section, sectionTable, SECTIONS } from "./validate.ts";
import { parseTextMessage } from "./text-parse.ts";

export interface FlowDeps { store: Store; f: typeof fetch; appSecret: string; now?: () => number }
type Screen = { screen: string; data: Record<string, unknown> };

const failure = (message: string): Screen => ({ screen: "FAILURE", data: { message } });
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export async function handleFlowRequest(body: Record<string, any>, deps: FlowDeps): Promise<Record<string, unknown>> {
  const action = String(body.action ?? "");
  if (action === "ping") return { data: { status: "active" } };
  // Error notifications from WhatsApp must be acknowledged.
  if (body.data?.error || body.data?.error_message) {
    logger.warn("flow error notification", { error: String(body.data.error ?? body.data.error_message).slice(0, 200) });
    return { data: { acknowledged: true } };
  }
  const session = readFlowToken(String(body.flow_token ?? ""), deps.appSecret, deps.now?.());
  if (!session) return failure("انتهت صلاحية الجلسة، أرسل رسالة جديدة للبدء. / Session expired, send a new message to start.");
  const user = await findUserByPhone(deps.store, session.phone);
  if (!user) return failure("هذا الرقم غير مسجل. / This number is not registered.");
  if (!(await flagEnabled(deps.store, "whatsapp_flow"))) return failure("التسجيل عبر النموذج متوقف مؤقتاً. / Flow capture is currently disabled.");
  const allowed = SECTIONS.filter((s) => canUseSection(user, s));
  if (!allowed.length) return failure("ليس لديك صلاحية لأي قسم. / You have no section permissions.");

  try {
    if (action === "INIT" || (action === "BACK" && body.screen === "PHOTO")) return sectionScreen(user, allowed);
    if (action === "BACK") return { screen: "PHOTO", data: { section: body.data?.section ?? allowed[0] } };
    if (action === "data_exchange") {
      const d = (body.data ?? {}) as Record<string, any>;
      const section = d.section;
      if (!isSection(section) || !allowed.includes(section)) return failure("قسم غير مسموح. / Section not allowed.");
      if (d.action === "scan" || d.action === "retry") return await scan(d, section, session.phone, deps);
      if (d.action === "confirm") return await confirm(d, section, session.phone, user, deps);
    }
  } catch (e) {
    logger.error("flow handler error", { error: errMsg(e) });
    return failure("حدث خطأ غير متوقع، حاول مرة أخرى. / Unexpected error, please try again.");
  }
  return failure("طلب غير معروف. / Unknown request.");
}

function sectionScreen(user: Row, allowed: Section[]): Screen {
  return {
    screen: "SECTION",
    data: { greeting: `مرحباً ${user.name} / Hello ${user.name}`, sections: allowed.map((s) => ({ id: s, title: `${sectionLabel(s, "ar")} / ${sectionLabel(s, "en")}` })) },
  };
}

async function loadCategories(store: Store, section: Section) {
  const { rows } = await store.select("categories", { filters: [["section", "eq", section], ["active", "eq", true]], order: ["name", "asc"] });
  const list = rows.map((r) => ({ id: r.name as string, title: (r.name_ar ? `${r.name_ar} / ${r.name}` : r.name).slice(0, 30) }));
  return list.length ? list : [{ id: "Other", title: "أخرى / Other" }]; // Dropdown needs at least one option
}

async function fetchPhoto(media: FlowMedia, f: typeof fetch): Promise<Uint8Array> {
  const u = new URL(media.cdn_url);
  if (u.protocol !== "https:") throw new Error("media url must be https");
  const r = await f(media.cdn_url);
  if (!r.ok) throw new Error(`media fetch ${r.status}`);
  const enc = new Uint8Array(await r.arrayBuffer());
  if (enc.length > MAX_IMAGE_BYTES) throw new Error("image too large");
  return decryptFlowMedia(enc, media.encryption_metadata);
}

async function scan(d: Record<string, any>, section: Section, phone: string, deps: FlowDeps): Promise<Screen> {
  let rawQr: string | null = null;
  let imagePath: string | undefined;
  const text = typeof d.qr_text === "string" ? d.qr_text.trim() : "";
  if (text) rawQr = parseTextMessage(text).input?.raw_qr as string | undefined ?? text;

  const media: FlowMedia | undefined = Array.isArray(d.photo) ? d.photo[0] : d.photo && typeof d.photo === "object" ? d.photo : undefined;
  if (!rawQr && media) {
    try {
      const bytes = await fetchPhoto(media, deps.f);
      rawQr = decodeQrFromImage(bytes);
      if (await flagEnabled(deps.store, "store_invoice_images")) {
        const ext = bytes[0] === 0x89 ? "png" : "jpg";
        imagePath = `flow/${phone.replace(/\D/g, "")}/${randomUUID()}.${ext}`;
        await deps.store.uploadObject(imagePath, bytes, ext === "png" ? "image/png" : "image/jpeg");
      }
    } catch (e) {
      logger.warn("flow photo handling failed", { error: errMsg(e) });
    }
  }
  if (!rawQr) return { screen: "RETRY", data: { section, image_path: imagePath ?? "", message: "تعذرت قراءة رمز QR. أعد التصوير بوضوح أو الصق النص. / Could not read the QR. Retake a clearer photo or paste the text." } };
  let p;
  try { p = parseZatcaQr(rawQr); }
  catch (e) { return { screen: "RETRY", data: { section, image_path: imagePath ?? "", message: `${errMsg(e)} — أعد المحاولة / try again` } }; }
  return {
    screen: "CONFIRM",
    data: {
      section, raw_qr: p.raw_qr, image_path: imagePath ?? d.image_path ?? "",
      summary: `${p.seller_name}\nVAT: ${p.vat_number}\n${p.invoice_date.replace("T", " ").slice(0, 16)}\nVAT amount: ${money2(p.vat_amount)} SAR`,
      total: money2(p.total_amount), notes: "", categories: await loadCategories(deps.store, section),
    },
  };
}

async function confirm(d: Record<string, any>, section: Section, phone: string, user: Row, deps: FlowDeps): Promise<Screen> {
  let p;
  try { p = parseZatcaQr(String(d.raw_qr ?? "")); } catch { return failure("بيانات الفاتورة غير صالحة. / Invalid invoice data."); }
  const digits = phone.replace(/\D/g, "");
  const imagePath = typeof d.image_path === "string" && d.image_path.startsWith(`flow/${digits}/`) && !d.image_path.includes("..") ? d.image_path : undefined;
  let total = p.total_amount;
  let notes = String(d.notes ?? "").slice(0, 900);
  const edited = d.total != null && String(d.total).trim() !== "" ? Number(String(d.total).replace(/[^\d.]/g, "")) : p.total_amount;
  if (Number.isFinite(edited) && Math.abs(edited - p.total_amount) >= 0.005) {
    // dedupe still holds: a unique index on raw_qr stops the same QR being saved again with another total
    total = Math.round(edited * 100) / 100;
    notes = `${notes} [QR total ${money2(p.total_amount)} edited to ${money2(total)}]`.trim();
  }
  const res = await captureExpense(
    deps.store, user, section,
    { raw_qr: p.raw_qr, total_override: total, notes, category: typeof d.category === "string" ? d.category : undefined },
    { source: "whatsapp_flow", image_path: imagePath, lang: "ar", notifySubmitter: true },
  );
  if (res.status === "saved") return { screen: "SUCCESS", data: { message: `${res.reply}` } };
  if (res.status === "duplicate") return { screen: "DUPLICATE", data: { message: res.reply } };
  return failure(res.reply);
}
