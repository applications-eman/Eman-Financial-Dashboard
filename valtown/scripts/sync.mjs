#!/usr/bin/env node
// Pushes /valtown source files to the Val Town project (idempotent: updates existing files, creates missing ones).
// Usage: VAL_TOWN_API_KEY=vtwn_... VAL=applications/eman-expense-api node valtown/scripts/sync.mjs
// The API key needs "vals: read+write". Env vars/secrets are NOT synced (set them in Val Town > Environment variables).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const key = process.env.VAL_TOWN_API_KEY;
const [handle, name] = (process.env.VAL ?? "applications/eman-expense-api").split("/");
if (!key) { console.error("Set VAL_TOWN_API_KEY"); process.exit(2); }
const root = new URL("..", import.meta.url).pathname;
const SKIP = new Set(["node_modules", "tests", "scripts", "package.json", "package-lock.json", "tsconfig.json"]);
const HTTP = new Set(["main.ts"]);
const INTERVAL = new Set(["cron-reports.ts"]);

const api = (p, init = {}) => fetch(`https://api.val.town${p}`, { ...init, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...init.headers } });
const val = await (await api(`/v2/alias/vals/${handle}/${name}`)).json();
if (!val.id) { console.error("Val not found:", JSON.stringify(val)); process.exit(1); }

function* walk(dir) {
  for (const f of readdirSync(dir)) {
    if (SKIP.has(f)) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* walk(p); else if (f.endsWith(".ts")) yield p;
  }
}
for (const file of walk(root)) {
  const path = relative(root, file);
  const type = HTTP.has(path) ? "http" : INTERVAL.has(path) ? "interval" : "script";
  const body = JSON.stringify({ content: readFileSync(file, "utf8"), type });
  const q = `/v2/vals/${val.id}/files?path=${encodeURIComponent(path)}`;
  let r = await api(q, { method: "PUT", body });
  if (r.status === 404) r = await api(q, { method: "POST", body });
  console.log(r.ok ? "ok  " : `FAIL(${r.status})`, path);
  if (!r.ok) process.exitCode = 1;
}
