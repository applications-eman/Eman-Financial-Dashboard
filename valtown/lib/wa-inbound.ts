// Processes one inbound WhatsApp message (already signature-verified and de-duplicated).
//
// Capture conversation (default, no WhatsApp Flow needed):
//   "hi" / "مصروف"  ->  [Bakery] [Grocery] buttons  ->  "send the QR photo or text"  ->  saved / duplicate confirmation
// Setting wa_capture_mode = "flow" switches the greeting to the WhatsApp Flow form instead.
import { canUseSection, captureExpense, findUserByPhone } from "./capture.ts";
import { makeFlowToken } from "./crypto.ts";
import { errMsg, logger, maskPhone } from "./log.ts";
import { decodeQrFromImage } from "./qr-image.ts";
import { detectLang, flagEnabled, getSetting, type Lang, sectionLabel, template } from "./settings.ts";
import type { Row, Store } from "./store.ts";
import { parseTextMessage } from "./text-parse.ts";
import { isSection, SECTIONS, type Section } from "./validate.ts";
import { clearPending, getPending, setPending } from "./wa-session.ts";
import { defaultDeps, downloadMedia, sendButtons, sendFlowMessage, sendText, type WaDeps } from "./whatsapp.ts";

async function askSection(store: Store, from: string, sections: Section[], lang: Lang, deps: WaDeps) {
  if (sections.length === 1) {
    await setPending(store, from, sections[0]);
    await sendText(from, await template(store, `send_invoice_${sections[0]}`, lang, {}), deps);
    return;
  }
  const ok = await sendButtons(from, await template(store, "choose_section", lang, {}), sections.map((s) => ({ id: `sec:${s}`, title: `${sectionLabel(s, "ar")} / ${sectionLabel(s, "en")}` })), deps);
  if (!ok) await sendText(from, "اكتب (مخبز) أو (بقالة) مع نص الفاتورة. / Write 'bakery' or 'grocery' together with the invoice text.", deps);
}

export async function processInboundMessage(store: Store, msg: Record<string, any>, appSecret: string, deps: WaDeps = defaultDeps): Promise<string> {
  const from = `+${String(msg.from ?? "").replace(/\D/g, "")}`;
  const user = await findUserByPhone(store, from);
  if (!user) {
    logger.warn("message from unregistered number", { from: maskPhone(from) });
    return "ignored_unregistered"; // no reply: do not confirm the number exists
  }
  const text: string = msg.type === "text" ? String(msg.text?.body ?? "") : "";
  const lang = detectLang(text || user.name);
  const sections = SECTIONS.filter((s) => canUseSection(user, s));
  if (!sections.length) { await sendText(from, await template(store, "not_allowed", lang, {}), deps); return "no_sections"; }

  // ---- a tap on a reply button
  if (msg.type === "interactive") {
    if (msg.interactive?.type === "nfm_reply") return "flow_reply_ignored";
    const id: string = msg.interactive?.button_reply?.id ?? "";
    if (id.startsWith("sec:")) {
      const section = id.slice(4);
      if (!isSection(section) || !sections.includes(section)) return "section_not_allowed";
      await setPending(store, from, section);
      await sendText(from, await template(store, `send_invoice_${section}`, lang, {}), deps);
      return "section_selected";
    }
    return "ignored_interactive";
  }

  const resolveSection = async (explicit?: Section): Promise<Section | undefined> => {
    if (explicit && sections.includes(explicit)) return explicit;
    const pending = await getPending(store, from);
    if (pending && sections.includes(pending)) return pending;
    return sections.length === 1 ? sections[0] : undefined;
  };

  // ---- a photo of the invoice QR
  if (msg.type === "image") {
    if (!(await flagEnabled(store, "whatsapp_text"))) return "disabled";
    const section = await resolveSection(parseTextMessage(String(msg.image?.caption ?? "")).section);
    if (!section) { await askSection(store, from, sections, lang, deps); return "ambiguous_section"; }
    try {
      const { bytes } = await downloadMedia(msg.image.id, deps);
      const qr = decodeQrFromImage(bytes);
      if (!qr) {
        await sendText(from, await template(store, "invalid", lang, { reason: lang === "ar" ? "لم يتم العثور على رمز QR في الصورة، أعد التصوير بوضوح أو أرسل النص" : "no QR found in the image; retake it clearly or send the QR text" }), deps);
        return "qr_not_found";
      }
      const res = await captureExpense(store, user, section, { raw_qr: qr }, { source: "whatsapp_text", lang, deps, notifySubmitter: true });
      if (res.status !== "invalid") await clearPending(store, from);
      return res.status;
    } catch (e) {
      logger.error("image capture failed", { error: errMsg(e) });
      await sendText(from, await template(store, "invalid", lang, { reason: "image error" }), deps);
      return "error";
    }
  }
  if (msg.type !== "text") return "unsupported_type";

  // ---- greeting / trigger word
  const triggers = await getSetting<string[]>(store, "wa_trigger_words", ["مصروف", "فاتورة", "expense", "invoice", "hi", "hello", "مرحبا"]);
  const norm = text.trim().toLowerCase().replace(/[.,!؟?،\s]+$/g, ""); // "Hi," and "hi!" count as "hi"
  if (triggers.some((t) => norm === t.toLowerCase())) {
    const flowId = await getSetting<string>(store, "wa_flow_id", "");
    const mode = await getSetting<string>(store, "wa_capture_mode", "buttons");
    if (mode === "flow" && flowId && (await flagEnabled(store, "whatsapp_flow"))) {
      const draft = (await getSetting<string>(store, "wa_flow_mode", "published")) === "draft" ? "draft" : "published";
      const ok = await sendFlowMessage(from, {
        mode: draft, flowId, flowToken: makeFlowToken(from, appSecret),
        body: await template(store, "welcome", lang, { name: user.name }), cta: lang === "ar" ? "تسجيل فاتورة" : "Record invoice",
      }, deps);
      if (ok) return "flow_sent";
      logger.warn("flow could not be sent, falling back to buttons");
    }
    if (!(await flagEnabled(store, "whatsapp_text"))) return "disabled";
    await askSection(store, from, sections, lang, deps);
    return "capture_started";
  }

  // ---- invoice text (Base64 QR, labelled fields, or five plain fields)
  if (!(await flagEnabled(store, "whatsapp_text"))) return "disabled";
  const p = parseTextMessage(text);
  if (p.error || !p.input) {
    await askSection(store, from, sections, lang, deps); // unknown message: start the guided capture
    return "unparseable";
  }
  const section = await resolveSection(p.section);
  if (!section) { await askSection(store, from, sections, lang, deps); return "ambiguous_section"; }
  const res = await captureExpense(store, user, section, p.input, { source: "whatsapp_text", lang, deps, notifySubmitter: true });
  if (res.status !== "invalid") await clearPending(store, from);
  return res.status;
}
export type { Row };
