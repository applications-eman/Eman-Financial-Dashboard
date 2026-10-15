import { errMsg, logger } from "./log.ts";
import { type SaveResult, saveExpense } from "./expenses.ts";
import { flagEnabled, getSetting, type Lang, money2, sectionLabel, template } from "./settings.ts";
import type { Row, Store } from "./store.ts";
import type { Section, Source } from "./validate.ts";
import { sendNotification, sendText, type WaDeps, defaultDeps, waConfigured } from "./whatsapp.ts";
import { hashToken } from "./crypto.ts";

export async function findUserByToken(store: Store, token: string): Promise<Row | null> {
  const { rows } = await store.select("app_users", { filters: [["token_hash", "eq", hashToken(token)], ["active", "eq", true]], limit: 1 });
  return rows[0] ?? null;
}
export async function findUserByPhone(store: Store, phone: string): Promise<Row | null> {
  const { rows } = await store.select("app_users", { filters: [["phone_e164", "eq", phone], ["active", "eq", true]], limit: 1 });
  return rows[0] ?? null;
}
export const canUseSection = (user: Row, section: Section) => (user.sections ?? []).includes(section);

export async function listAdmins(store: Store): Promise<Row[]> {
  const { rows } = await store.select("app_users", { filters: [["role", "eq", "admin"], ["active", "eq", true]] });
  return rows.filter((r) => r.phone_e164);
}

/** Runs capture + notifications. Notification failures never fail the capture. */
export async function captureExpense(
  store: Store, user: Row, section: Section, input: Record<string, unknown>,
  opts: { source: Source; image_path?: string; lang?: Lang; deps?: WaDeps; notifySubmitter?: boolean },
): Promise<SaveResult & { reply: string }> {
  const lang = opts.lang ?? "ar";
  const deps = opts.deps ?? defaultDeps;
  const res = await saveExpense(store, section, input, { source: opts.source, submitted_by: user.name, image_path: opts.image_path, actor: `${opts.source}:${user.name}` });
  const row = res.row ?? res.existing;
  const vars = {
    name: user.name, section: sectionLabel(section, lang), seller: row?.seller_name ?? (input.seller_name as string) ?? "",
    total: row ? money2(Number(row.total_amount)) : "", vat: row ? money2(Number(row.vat_amount)) : "", reason: res.message,
  };
  const reply = await template(store, res.status === "saved" ? "saved" : res.status === "duplicate" ? "duplicate" : "invalid", lang, vars);
  try {
    if (waConfigured()) {
      if (opts.notifySubmitter && user.phone_e164 && (await flagEnabled(store, "confirm_to_submitter"))) await sendText(user.phone_e164, reply, deps);
      if (await flagEnabled(store, "alert_admins")) {
        const th = await getSetting<Record<string, any>>(store, "alert_thresholds", {});
        const kind = res.status === "duplicate" && th.notify_on_duplicate !== false ? "admin_duplicate"
          : res.status === "saved" && res.warnings?.length && th.notify_on_vat_warning !== false ? "admin_vat_warning"
          : res.status === "saved" && th.max_invoice_amount && Number(res.row?.total_amount) > Number(th.max_invoice_amount) ? "admin_vat_warning" : null;
        if (kind) {
          for (const a of await listAdmins(store)) await sendNotification(store, a.phone_e164, await template(store, kind, a.lang === "en" ? "en" : "ar", { ...vars, section: sectionLabel(section, "ar") }), deps);
        }
      }
    }
  } catch (e) {
    logger.warn("notification failed", { error: errMsg(e) });
  }
  return { ...res, reply };
}
