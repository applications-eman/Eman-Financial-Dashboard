// Val Town HTTP entrypoint (Hono). Routes: /health, /api/expense, /whatsapp/webhook, /api/flow, /admin/*
import { Hono } from "npm:hono@4";
import { adminRoutes } from "./routes/admin.ts";
import { expenseRoutes } from "./routes/expense.ts";
import { flowRoutes } from "./routes/flow.ts";
import { webhookRoutes } from "./routes/webhook.ts";
import { errMsg, logger } from "./lib/log.ts";

export const app = new Hono();
app.get("/health", (c) => c.json({ ok: true, service: "eman-expense-backend", time: new Date().toISOString() }));
app.route("/", expenseRoutes);
app.route("/", webhookRoutes);
app.route("/", flowRoutes);
app.route("/", adminRoutes);
app.onError((e, c) => {
  logger.error("unhandled", { path: new URL(c.req.url).pathname, error: errMsg(e) });
  return c.json({ error: "internal error" }, 500);
});
app.notFound((c) => c.json({ error: "not found" }, 404));

export default app.fetch;
