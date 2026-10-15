// Processes one inbound WhatsApp message (already signature-verified and de-duplicated).
import { canUseSection, captureExpense, findUserByPhone } from "./capture.ts";
import { makeFlowToken } from "./crypto.ts";
import { errMsg, logger, maskPhone } from "./log.ts";
import { decodeQrFromImage } from "./qr-image.ts";
import { detectLang, flagEnabled, getSetting, template } from "./settings.ts";
import type { Store } from "./store.ts";
import { parseTextMessage } from "./text-parse.ts";
import { SECTIONS } from "./validate.ts";
import { downloadMedia, sendFlowMessage, sendText, type WaDeps, defaultDeps } from "./whatsapp.ts";

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

  if (msg.type === "interactive" && msg.interactive?.type === "nfm_reply") return "flow_reply_ignored";

  if (msg.type === "image") {
    if (!(await flagEnabled(store, "whatsapp_text"))) return "disabled";
    if (sections.length !== 1) { await sendText(from, "لديك أكثر من قسم. أرسل صورة مع الكلمة (مخبز/بقالة) أو استخدم النموذج. / Several sections: use the form or send the image caption 'bakery' or 'grocery'.", deps); return "ambiguous_section"; }
    try {
      const { bytes } = await downloadMedia(msg.image.id, deps);
      const qr = decodeQrFromImage(bytes);
      if (!qr) { await sendText(from, await template(store, "invalid", lang, { reason: "QR not found in image" }), deps); return "qr_not_found"; }
      const res = await captureExpense(store, user, sections[0], { raw_qr: qr }, { source: "whatsapp_text", lang, deps, notifySubmitter: true });
      return res.status;
    } catch (e) {
      logger.error("image capture failed", { error: errMsg(e) });
      await sendText(from, await template(store, "invalid", lang, { reason: "image error" }), deps);
      return "error";
    }
  }
  if (msg.type !== "text") return "unsupported_type";

  const triggers = await getSetting<string[]>(store, "wa_trigger_words", []);
  const norm = text.trim().toLowerCase();
  const flowId = await getSetting<string>(store, "wa_flow_id", "");
  if (flowId && (await flagEnabled(store, "whatsapp_flow")) && triggers.some((t) => norm === t.toLowerCase())) {
    const ok = await sendFlowMessage(from, {
      flowId, flowToken: makeFlowToken(from, appSecret),
      body: await template(store, "welcome", lang, { name: user.name }), cta: lang === "ar" ? "تسجيل فاتورة" : "Record invoice",
    }, deps);
    return ok ? "flow_sent" : "flow_send_failed";
  }

  if (!(await flagEnabled(store, "whatsapp_text"))) { return "disabled"; }
  const p = parseTextMessage(text);
  if (p.error || !p.input) {
    if (flowId) await sendText(from, await template(store, "welcome", lang, { name: user.name }), deps);
    return "unparseable";
  }
  const section = p.section && sections.includes(p.section) ? p.section : sections.length === 1 ? sections[0] : undefined;
  if (!section) {
    await sendText(from, lang === "ar" ? "حدد القسم: اكتب (مخبز) أو (بقالة) مع الفاتورة." : "Please include the section: write 'bakery' or 'grocery' with the invoice.", deps);
    return "ambiguous_section";
  }
  const res = await captureExpense(store, user, section, p.input, { source: "whatsapp_text", lang, deps, notifySubmitter: true });
  return res.status;
}
