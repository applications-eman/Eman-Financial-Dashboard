// Hourly cron (Val Town: interval, every hour). Sends the daily/weekly summaries when the Riyadh time matches
// app_settings.report_schedule. Hourly in UTC == hourly in Riyadh (UTC+3, no DST).
import { runScheduledReports } from "./lib/reports.ts";
import { getStore } from "./lib/store.ts";

export default async function () {
  const sent = await runScheduledReports(getStore());
  console.log(JSON.stringify({ msg: "reports cron", sent }));
}
