import { Hono } from "npm:hono@4";
import { canUseSection, captureExpense, findUserByToken } from "../lib/capture.ts";
import { flagEnabled } from "../lib/settings.ts";
import { rateLimit } from "../lib/ratelimit.ts";
import { logger } from "../lib/log.ts";
import { getStore } from "../lib/store.ts";
import { shortcutBodySchema } from "../lib/validate.ts";

export const expenseRoutes = new Hono();

// iOS Shortcut endpoint: JSON body, token authenticates the staff member.
expenseRoutes.post("/api/expense", async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!rateLimit(`exp-ip:${ip}`, 60, 60_000).ok) return c.json({ status: "invalid", message: "Too many requests" }, 429);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ status: "invalid", message: "Body must be JSON" }, 400); }
  const parsed = shortcutBodySchema.safeParse(body);
  if (!parsed.success) return c.json({ status: "invalid", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
  const { token, section, ...fields } = parsed.data;

  const store = getStore();
  // Failed-token attempts are throttled per IP to stop brute force.
  const user = await findUserByToken(store, token);
  if (!user) {
    const rl = rateLimit(`exp-bad:${ip}`, 10, 10 * 60_000);
    logger.warn("shortcut auth failed", { ip });
    return c.json({ status: "invalid", message: rl.ok ? "Invalid token" : "Too many failed attempts" }, rl.ok ? 401 : 429);
  }
  if (!canUseSection(user, section)) return c.json({ status: "invalid", message: "Not allowed for this section" }, 403);
  if (!(await flagEnabled(store, "ios_shortcut"))) return c.json({ status: "invalid", message: "Shortcut capture is disabled" }, 403);

  const res = await captureExpense(store, user, section, fields, { source: "ios_shortcut", lang: "ar" });
  const code = res.status === "saved" ? 201 : res.status === "duplicate" ? 200 : 422;
  return c.json({ status: res.status, message: res.reply, id: res.row?.id ?? res.existing?.id, warnings: res.warnings }, code);
});
