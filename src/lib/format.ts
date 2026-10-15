// Saudi conventions: SAR with 2 decimals, dd/MM/yyyy, Asia/Riyadh (UTC+3, no DST).
const TZ = "Asia/Riyadh";

const money = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtMoney = (n: number | null | undefined) => money.format(Number(n ?? 0));

const parts = (d: Date, opts: Intl.DateTimeFormatOptions) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hourCycle: "h23", ...opts })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;

export function fmtDate(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  const p = parts(new Date(iso), { day: "2-digit", month: "2-digit", year: "numeric" });
  return `${p.day}/${p.month}/${p.year}`;
}
export function fmtDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  const p = parts(new Date(iso), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}
/** yyyy-MM-dd of the Riyadh calendar day */
export function riyadhDay(iso: string | Date): string {
  const p = parts(new Date(iso), { day: "2-digit", month: "2-digit", year: "numeric" });
  return `${p.year}-${p.month}-${p.day}`;
}
export const riyadhMonth = (iso: string | Date) => riyadhDay(iso).slice(0, 7);
/** ISO instant for 00:00 Riyadh of a yyyy-MM-dd day (+ n days) */
export function riyadhStartOfDay(day: string, plusDays = 0): string {
  return new Date(new Date(`${day}T00:00:00+03:00`).getTime() + plusDays * 86_400_000).toISOString();
}
export const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const shortDay = (day: string) => day.slice(8, 10) + "/" + day.slice(5, 7);
