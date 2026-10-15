// Scheduled summaries. Cron fires HOURLY (UTC); the Riyadh hour/day to send comes from app_settings.report_schedule,
// so schedules are editable in the dashboard. app_settings.report_state remembers what was already sent.
import { listAdmins } from "./capture.ts";
import { errMsg, logger } from "./log.ts";
import { flagEnabled, getSetting, money2, sectionLabel } from "./settings.ts";
import type { Row, Store } from "./store.ts";
import { SECTIONS, sectionTable } from "./validate.ts";
import { sendNotification, type WaDeps, defaultDeps, waConfigured } from "./whatsapp.ts";

const RIYADH_OFFSET_MS = 3 * 3600_000;
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function riyadhParts(now: Date) {
  const r = new Date(now.getTime() + RIYADH_OFFSET_MS);
  const iso = r.toISOString();
  return { date: iso.slice(0, 10), hour: r.getUTCHours(), day: DAYS[r.getUTCDay()] };
}
/** [startIso, endIso) in absolute time for a Riyadh calendar day range. */
export function riyadhRange(dateFrom: string, days: number) {
  const start = new Date(`${dateFrom}T00:00:00+03:00`);
  return { from: start.toISOString(), to: new Date(start.getTime() + days * 86400_000).toISOString() };
}
const shiftDate = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const fmtDmy = (d: string) => d.split("-").reverse().join("/");

export interface Summary { section: string; count: number; total: number; vat: number; uncategorized: number }
export async function summarize(store: Store, section: (typeof SECTIONS)[number], from: string, to: string): Promise<Summary> {
  const { rows } = await store.select(sectionTable(section), { filters: [["invoice_date", "gte", from], ["invoice_date", "lte", to]], limit: 20000 });
  return {
    section, count: rows.length,
    total: rows.reduce((a, r) => a + Number(r.total_amount), 0),
    vat: rows.reduce((a, r) => a + Number(r.vat_amount), 0),
    uncategorized: rows.filter((r) => !r.category).length,
  };
}
export function formatSummary(title: string, list: Summary[]): string {
  const lines = list.map((s) => `${sectionLabel(s.section, "ar")}: ${s.count} فاتورة | الإجمالي ${money2(s.total)} ر.س | الضريبة ${money2(s.vat)} ر.س | بدون تصنيف ${s.uncategorized}`);
  return `${title}\n${lines.join("\n")}`;
}

export async function runScheduledReports(store: Store, now = new Date(), deps: WaDeps = defaultDeps): Promise<string[]> {
  const done: string[] = [];
  const sched = await getSetting<Record<string, any>>(store, "report_schedule", {});
  const state = await getSetting<Record<string, string>>(store, "report_state", {});
  const p = riyadhParts(now);
  const send = async (kind: "daily" | "weekly", title: string, from: string, to: string) => {
    const list: Summary[] = [];
    for (const s of SECTIONS) list.push(await summarize(store, s, from, to));
    const text = formatSummary(title, list);
    if (waConfigured()) for (const a of await listAdmins(store)) await sendNotification(store, a.phone_e164, text, deps);
    done.push(kind);
    return text;
  };
  try {
    if (sched.daily_enabled !== false && (await flagEnabled(store, "daily_summary")) && p.hour === Number(sched.daily_hour ?? 21) && state.daily !== p.date) {
      const r = riyadhRange(p.date, 1);
      await send("daily", `📊 ملخص اليوم ${fmtDmy(p.date)}`, r.from, r.to);
      state.daily = p.date;
    }
    if (sched.weekly_enabled !== false && (await flagEnabled(store, "weekly_report")) && p.day === String(sched.weekly_day ?? "sat") && p.hour === Number(sched.weekly_hour ?? 9) && state.weekly !== p.date) {
      const r = riyadhRange(shiftDate(p.date, -7), 7);
      await send("weekly", `📈 التقرير الأسبوعي ${fmtDmy(shiftDate(p.date, -7))} - ${fmtDmy(shiftDate(p.date, -1))}`, r.from, r.to);
      state.weekly = p.date;
    }
    if (done.length) await store.upsert("app_settings", { key: "report_state", value: state, updated_by: "cron" }, "key", "cron");
  } catch (e) {
    logger.error("scheduled report failed", { error: errMsg(e) });
  }
  return done;
}
export type { Row };
