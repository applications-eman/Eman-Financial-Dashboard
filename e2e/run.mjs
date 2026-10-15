#!/usr/bin/env node
// Local end-to-end run: real dashboard build + real Val Town backend code + mock Supabase (see valtown/e2e/server.ts).
// Usage: npm run build && node e2e/run.mjs      (needs Chromium under /opt/pw-browsers or CHROMIUM_PATH)
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const ROOT = new URL("..", import.meta.url).pathname;
const DASH = "http://localhost:3100";
const API = "http://localhost:8787";
const SUPA = "http://localhost:54321";
const SHOTS = `${ROOT}docs/screenshots`;
const results = [];
const procs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(cmd, args, opts) {
  const p = spawn(cmd, args, { ...opts, env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
  const log = (d) => process.env.E2E_VERBOSE && process.stdout.write(d);
  p.stdout.on("data", log);
  p.stderr.on("data", log);
  procs.push(p);
}
async function waitFor(url, ms = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${url}`);
}
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? "" });
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    const detail = String(e.message ?? e).split("\n")[0];
    results.push({ name, ok: false, ms: Date.now() - t0, detail });
    console.log(`FAIL  ${name} — ${detail}`);
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

const chromeDir = readdirSync("/opt/pw-browsers").find((d) => /^chromium-\d+$/.test(d));
const executablePath = process.env.CHROMIUM_PATH ?? `/opt/pw-browsers/${chromeDir}/chrome-linux/chrome`;

start("node", ["--import", "./tests/register.mjs", "e2e/server.ts"], { cwd: `${ROOT}valtown`, env: { E2E_DASH_ORIGIN: DASH } });
start("npx", ["next", "start", "-p", "3100"], {
  cwd: ROOT,
  env: { NEXT_PUBLIC_SUPABASE_URL: SUPA, NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key", NEXT_PUBLIC_ADMIN_API_URL: API },
});

let browser;
let rotatedToken = "";
try {
  await waitFor(`${SUPA}/auth/v1/.well-known/jwks.json`);
  await waitFor(`${DASH}/healthz`);
  const staffToken = readFileSync(`${ROOT}valtown/e2e/staff-token.txt`, "utf8").trim();
  browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  await step("health check route is public", async () => {
    const r = await fetch(`${DASH}/healthz`);
    expect(r.status === 200 && (await r.json()).ok === true, "healthz not ok");
  });
  await step("anonymous request is redirected to /auth/login", async () => {
    const r = await fetch(`${DASH}/dashboard/bakery`, { redirect: "manual" });
    expect(r.status === 307 || r.status === 302, `status ${r.status}`);
    expect(r.headers.get("location")?.includes("/auth/login"), "no login redirect");
  });
  await step("wrong password is rejected", async () => {
    await page.goto(`${DASH}/auth/login`);
    await page.fill("#email", "admin@eman.test");
    await page.fill("#password", "nope");
    await page.click("button[type=submit]");
    await page.waitForSelector("[role=alert]");
  });
  await step("admin signs in and lands on the live dashboard", async () => {
    await page.fill("#password", "correct-horse-battery");
    await page.click("button[type=submit]");
    await page.waitForURL(`${DASH}/dashboard`);
    await page.getByRole("heading", { name: "Live dashboard" }).waitFor();
    await page.getByText("Live", { exact: true }).first().waitFor({ timeout: 15000 });
  });
  await step("KPI cards show seeded data per section", async () => {
    await page.getByText("This month").first().waitFor();
    const txt = await page.locator("main, body").first().innerText();
    expect(/Bakery/.test(txt) && /Grocery/.test(txt), "section headings missing");
    await page.screenshot({ path: `${SHOTS}/dashboard-light.png`, fullPage: true });
  });
  await step("REALTIME: iOS Shortcut POST appears on the dashboard (toast + feed)", async () => {
    const t0 = Date.now();
    const r = await fetch(`${API}/api/expense`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ section: "bakery", token: staffToken, seller_name: "شركة مخابز ايمان جدة للخبز", vat_number: "312028501300003", invoice_date: "2026-10-14T15:19:20", total_amount: 145.52, vat_amount: 18.98 }),
    });
    expect(r.status === 201, `shortcut status ${r.status}`);
    await page.getByText("New invoice").first().waitFor({ timeout: 10000 });
    await page.getByText("شركة مخابز ايمان جدة للخبز").first().waitFor({ timeout: 10000 });
    await page.screenshot({ path: `${SHOTS}/dashboard-realtime.png`, fullPage: true });
    return `${Date.now() - t0} ms from POST to visible`;
  });
  await step("duplicate post is reported and not inserted twice", async () => {
    const body = JSON.stringify({ section: "bakery", token: staffToken, vat_number: "312028501300003", invoice_date: "2026-10-14T15:19:20", total_amount: 145.52, vat_amount: 18.98 });
    const r = await (await fetch(`${API}/api/expense`, { method: "POST", headers: { "content-type": "application/json" }, body })).json();
    expect(r.status === "duplicate", `status ${r.status}`);
  });
  await step("bakery expenses table lists rows with badges; inline status edit goes through the admin API", async () => {
    await page.goto(`${DASH}/dashboard/bakery`);
    await page.getByRole("heading", { name: "Bakery expenses" }).waitFor();
    await page.getByText("Flour Mill Co").first().waitFor();
    await page.getByText(/Duplicate ×1/).waitFor();
    await page.screenshot({ path: `${SHOTS}/expenses.png`, fullPage: true });
    const row = page.getByRole("row").filter({ hasText: "Pack It" });
    await row.getByRole("combobox", { name: "Status" }).click();
    await page.getByRole("option", { name: "Reviewed" }).click();
    await page.waitForTimeout(800);
    await page.reload(); // proves the change was persisted server-side, not just optimistic UI
    const again = page.getByRole("row").filter({ hasText: "Pack It" }).getByRole("combobox", { name: "Status" });
    await again.waitFor();
    expect((await again.innerText()).trim() === "Reviewed", "status not persisted");
  });
  await step("filter by supplier narrows the table", async () => {
    await page.getByPlaceholder("Search supplier").fill("Pack");
    await page.waitForTimeout(800);
    const n = await page.getByRole("row").count();
    expect(n === 2, `expected header+1 row, got ${n}`);
    await page.getByPlaceholder("Search supplier").fill("");
  });
  await step("users: generate Shortcut token is shown once", async () => {
    await page.goto(`${DASH}/dashboard/users`);
    await page.getByText("Ali Staff").waitFor();
    await page.getByRole("row").filter({ hasText: "Ali Staff" }).getByRole("button", { name: /Rotate token/ }).click();
    await page.getByRole("button", { name: "Confirm" }).click();
    const code = page.locator("code");
    await code.waitFor();
    const token = (await code.innerText()).trim();
    expect(/^eb_/.test(token), "token format");
    await page.getByRole("button", { name: "I have copied it" }).click();
    const ok = await fetch(`${API}/api/expense`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ section: "bakery", token, raw_qr: "AAAA" }) });
    expect(ok.status === 422, "new token authenticates (422 = past auth, bad QR)");
    rotatedToken = token;
    const old = await fetch(`${API}/api/expense`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ section: "bakery", token: staffToken, raw_qr: "AAAA" }) });
    expect(old.status === 401, "old token must be dead");
    await page.screenshot({ path: `${SHOTS}/users.png`, fullPage: true });
  });
  await step("settings: edit vat_rate via the data-driven editor; invalid value is rejected by the API", async () => {
    await page.goto(`${DASH}/dashboard/settings`);
    await page.getByText("vat_rate").first().waitFor();
    const input = page.locator("#s-vat_rate");
    await input.fill("0.16");
    await page.locator("div", { has: input }).getByRole("button", { name: "Save" }).last().click();
    await page.getByText("Saved").first().waitFor();
    await input.fill("16");
    await page.locator("div", { has: input }).getByRole("button", { name: "Save" }).last().click();
    await page.getByText(/vat_rate must be/).first().waitFor();
    await page.screenshot({ path: `${SHOTS}/settings.png`, fullPage: true });
  });
  await step("feature flags: switching ios_shortcut off blocks the endpoint, on restores it", async () => {
    const post = () => fetch(`${API}/api/expense`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ section: "bakery", token: rotatedToken, raw_qr: "AAAA" }) });
    await page.goto(`${DASH}/dashboard/flags`);
    await page.locator("#flag-ios_shortcut").waitFor();
    await page.locator("#flag-ios_shortcut").click();
    await page.waitForTimeout(700);
    expect((await post()).status === 403, "flag off should give 403");
    await page.locator("#flag-ios_shortcut").click();
    await page.waitForTimeout(700);
    expect((await post()).status === 422, "flag on should reach validation (422)");
  });
  await step("categories: add a category", async () => {
    await page.goto(`${DASH}/dashboard/categories`);
    await page.locator("#c-name-bakery").fill("Test Category");
    await page.getByRole("button", { name: "Add category" }).first().click();
    await page.locator("input[value='Test Category']").waitFor();
  });
  await step("audit log shows actor for the admin's changes", async () => {
    await page.goto(`${DASH}/dashboard/audit`);
    await page.getByText("admin@eman.test").first().waitFor();
    await page.screenshot({ path: `${SHOTS}/audit.png`, fullPage: true });
  });
  await step("exports: CSV download via the admin API", async () => {
    await page.goto(`${DASH}/dashboard/exports`);
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download" }).click()]);
    const path = await dl.path();
    const csv = readFileSync(path, "utf8");
    expect(csv.includes("section,id,invoice_date") && csv.includes("Flour Mill Co"), "csv content");
  });
  await step("Arabic + RTL switch", async () => {
    await page.goto(`${DASH}/dashboard`);
    await page.getByRole("button", { name: /Language/ }).click();
    await page.getByRole("heading", { name: "لوحة المتابعة المباشرة" }).waitFor();
    expect((await page.locator("html").getAttribute("dir")) === "rtl", "dir=rtl");
    await page.screenshot({ path: `${SHOTS}/dashboard-rtl.png`, fullPage: true });
    await page.getByRole("button", { name: /اللغة/ }).click();
    await page.getByRole("heading", { name: "Live dashboard" }).waitFor();
  });
  await step("mobile viewport has no horizontal page scroll", async () => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(`${DASH}/dashboard`);
    await page.getByRole("heading", { name: "Live dashboard" }).waitFor();
    await page.waitForTimeout(800);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await page.screenshot({ path: `${SHOTS}/dashboard-mobile.png` });
    expect(overflow <= 1, `overflow ${overflow}px`);
    await page.setViewportSize({ width: 1360, height: 900 });
  });
  await step("dark mode toggles", async () => {
    await page.goto(`${DASH}/dashboard`);
    await page.getByRole("button", { name: /theme/i }).first().click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/dashboard-dark.png`, fullPage: true });
  });
  await step("non-admin (staff) is sent to the Not authorized page", async () => {
    const ctx2 = await browser.newContext();
    const p2 = await ctx2.newPage();
    await p2.goto(`${DASH}/auth/login`);
    await p2.fill("#email", "staff@eman.test");
    await p2.fill("#password", "correct-horse-battery");
    await p2.click("button[type=submit]");
    await p2.goto(`${DASH}/dashboard`);
    await p2.waitForURL(`${DASH}/unauthorized`);
    await p2.getByRole("heading", { name: "Not authorized" }).waitFor();
    await ctx2.close();
  });
  await step("admin API refuses a staff JWT and cross-origin callers", async () => {
    const login = await (await fetch(`${SUPA}/auth/v1/token?grant_type=password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "staff@eman.test", password: "correct-horse-battery" }) })).json();
    const r = await fetch(`${API}/admin/users`, { headers: { authorization: `Bearer ${login.access_token}` } });
    expect(r.status === 403, `staff status ${r.status}`);
    const none = await fetch(`${API}/admin/users`);
    expect(none.status === 401, "anonymous 401");
    const pre = await fetch(`${API}/admin/users`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    expect(pre.headers.get("access-control-allow-origin") !== "https://evil.example", "CORS leaked");
  });
  await step("no unexpected browser console errors", async () => {
    const real = consoleErrors.filter((e) => !/favicon|Failed to load resource.*(401|403|400|422)|net::ERR/.test(e));
    expect(real.length === 0, real.slice(0, 3).join(" | "));
  });
} catch (e) {
  console.log("HARNESS ERROR:", e.message);
  results.push({ name: "harness", ok: false, ms: 0, detail: e.message });
} finally {
  await browser?.close();
  for (const p of procs) p.kill("SIGTERM");
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} passed`);
writeFileSync(`${ROOT}docs/e2e-local-results.json`, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
process.exit(pass === results.length ? 0 : 1);
