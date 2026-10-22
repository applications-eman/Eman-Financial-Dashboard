import { SupabaseRegistry, SupabaseSeenStore } from "./supabase.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("registry reads both lists with the service key and maps them", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url, auth: (init.headers as Record<string, string>).authorization });
    return url.includes("wa_targets")
      ? json([
          {
            id: "expense",
            name: "Expense",
            url: "https://e.example.com/w",
            secret: null,
            enabled: true,
            is_default: true,
          },
        ])
      : json([
          { phone: "966500000001", target_id: "expense", enabled: true },
          { phone: "966500000002", target_id: "expense", enabled: false },
        ]);
  }) as unknown as typeof fetch;
  const reg = new SupabaseRegistry({ url: "https://p.supabase.co", serviceKey: "KEY", fetch: f });
  assert.deepEqual(await reg.routes(), [
    { phone: "966500000001", targetId: "expense", enabled: true },
    { phone: "966500000002", targetId: "expense", enabled: false },
  ]);
  assert.equal((await reg.targets())[0].isDefault, true);
  assert.equal((await reg.targets())[0].secret, undefined);
  assert.ok(seen.every((s) => s.auth === "Bearer KEY"));
  assert.ok(seen.some((s) => s.url.includes("wa_numbers") && s.url.includes("enabled")));
  assert.equal(seen.length, 2); // second call was served from the cache
});

test("if the database is briefly down the router keeps the last good copy", async () => {
  let down = false;
  const f = (async (url: string) => {
    if (down) return new Response("x", { status: 503 });
    return url.includes("wa_targets")
      ? json([{ id: "a", name: "A", url: "https://a.example.com/w", enabled: true }])
      : json([{ phone: "966500000001", target_id: "a" }]);
  }) as unknown as typeof fetch;
  const reg = new SupabaseRegistry({ url: "https://p.supabase.co", serviceKey: "K", fetch: f }, 0); // ttl 0 = always refresh
  assert.equal((await reg.routes()).length, 1);
  down = true;
  assert.equal((await reg.routes()).length, 1);
});

test("with no copy at all and the database down, the read fails (the router then answers 5xx so Meta retries)", async () => {
  const f = (async () => new Response("x", { status: 503 })) as unknown as typeof fetch;
  await assert.rejects(new SupabaseRegistry({ url: "https://p.supabase.co", serviceKey: "K", fetch: f }).routes());
});

test("seen store: first time false, repeat true; forget lets a retry through", async () => {
  const db = new Set<string>();
  const f = (async (_url: string, init: RequestInit) => {
    if (init.method === "POST") {
      const id = JSON.parse(String(init.body)).message_id as string;
      if (db.has(id)) return json([]);
      db.add(id);
      return json([{ message_id: id }]);
    }
    const m = /in\.\((.*)\)/.exec(decodeURIComponent(String(_url)));
    for (const id of (m?.[1] ?? "").split(",").map((x) => x.replace(/"/g, ""))) db.delete(id);
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const s = new SupabaseSeenStore({ url: "https://p.supabase.co", serviceKey: "K", fetch: f });
  assert.equal(await s.seen("w1"), false);
  assert.equal(await s.seen("w1"), true);
  await s.forget(["w1"]);
  assert.equal(await s.seen("w1"), false);
});

test("both key styles work: JWT keys are also sent as Bearer, sb_secret keys only as apikey", async () => {
  const sent: Record<string, string>[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    sent.push(init.headers as Record<string, string>);
    return json([]);
  }) as unknown as typeof fetch;
  await new SupabaseRegistry({ url: "https://p.supabase.co", serviceKey: "eyJhbGciOi.old", fetch: f }, 0).routes();
  assert.equal(sent[0].authorization, "Bearer eyJhbGciOi.old");
  sent.length = 0;
  await new SupabaseRegistry({ url: "https://p.supabase.co", serviceKey: "sb_secret_abc", fetch: f }, 0).routes();
  assert.equal(sent[0].apikey, "sb_secret_abc");
  assert.equal(sent[0].authorization, undefined);
});
