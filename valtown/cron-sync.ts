// Odoo sync cron (Val Town interval, every 5 minutes). Does nothing until the feature flag "odoo_sync" is ON and the
// Odoo variables are set. Honors sync_settings.interval_minutes (so the interval can be changed from the dashboard).
import { getOdoo, odooAvailable } from "./lib/odoo-factory.ts";
import { runSyncCycle } from "./lib/odoo-sync.ts";
import { DEFAULT_SYNC } from "./lib/odoo-sync.ts";
import { flagEnabled, getSetting } from "./lib/settings.ts";
import { getStore } from "./lib/store.ts";

export default async function () {
  const store = getStore();
  if (!(await flagEnabled(store, "odoo_sync", false)) || !odooAvailable()) return console.log(JSON.stringify({ msg: "odoo sync off" }));
  const cfg = { ...DEFAULT_SYNC, ...(await getSetting<Record<string, number>>(store, "sync_settings", {})) };
  const { rows } = await store.select("sync_runs", { order: ["started_at", "desc"], limit: 1 });
  const last = rows[0]?.started_at ? Date.parse(rows[0].started_at) : 0;
  if (Date.now() - last < (cfg.interval_minutes * 60_000) - 30_000) return console.log(JSON.stringify({ msg: "odoo sync not due" }));
  const r = await runSyncCycle(store, getOdoo());
  console.log(JSON.stringify({ msg: "odoo sync", ...r }));
}
