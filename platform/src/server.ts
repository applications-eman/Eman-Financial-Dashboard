import { serve } from "@hono/node-server";

import { createApp } from "./app.ts";
import { PgDb } from "./db.ts";

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing setting ${k}`);
  return v;
};

const app = createApp({
  db: new PgDb(need("DATABASE_URL")),
  auth: {
    issuerBase: need("AUTH_SUPABASE_URL").replace(/\/$/, ""),
    jwtSecret: process.env.AUTH_JWT_SECRET || undefined,
    fetch,
  },
  allowedOrigins: need("ALLOWED_ORIGINS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8080) }, (i) =>
  console.log(JSON.stringify({ event: "platform_started", port: i.port })),
);
