import { signBody, verifyMetaSignature } from "./crypto.ts";
import { MemoryRegistry, MemorySeenStore, registryFromJson } from "./registry.ts";
import { handleWebhook, verifyChallenge } from "./router.ts";
import { isSafeTargetUrl } from "./ssrf.ts";
import type { Target } from "./types.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const SECRET = "app-secret";
const targets: Target[] = [
  { id: "expense", name: "Expense", url: "https://expense.example.com/webhook", secret: "e-secret", enabled: true },
  { id: "invoicing", name: "Invoicing", url: "https://invoicing.example.com/webhook", enabled: true },
  { id: "off", name: "Off", url: "https://off.example.com/webhook", enabled: false },
];
const routes = [
  { phone: "966500000001", targetId: "expense" },
  { phone: "966500000002", targetId: "invoicing" },
  { phone: "966500000003", targetId: "off" },
];
const msg = (from: string, id: string) => ({ from, id, type: "text", text: { body: "hi" } });
const body = (messages: unknown[], statuses: unknown[] = []) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "1", changes: [{ field: "messages", value: { messages, statuses } }] }],
});
const signed = (b: unknown) => {
  const raw = Buffer.from(JSON.stringify(b));
  return { raw, headers: { "x-hub-signature-256": signBody(raw, SECRET) } };
};

function setup(fetchImpl?: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: Buffer.from(init.body as Buffer).toString("utf8"),
    });
    return fetchImpl ? fetchImpl(url, init) : new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const deps = {
    appSecret: SECRET,
    registry: new MemoryRegistry(targets, routes),
    seen: new MemorySeenStore(),
    fetch: f,
  };
  return { deps, calls };
}

test("signature: right secret passes, wrong or missing header fails", () => {
  const raw = Buffer.from("{}");
  assert.equal(verifyMetaSignature(raw, signBody(raw, SECRET), SECRET), true);
  assert.equal(verifyMetaSignature(raw, signBody(raw, "other"), SECRET), false);
  assert.equal(verifyMetaSignature(raw, undefined, SECRET), false);
  assert.equal(verifyMetaSignature(raw, "sha1=abc", SECRET), false);
});

test("unsigned request is rejected and nothing is forwarded", async () => {
  const { deps, calls } = setup();
  const raw = Buffer.from(JSON.stringify(body([msg("966500000001", "w1")])));
  const r = await handleWebhook(deps, raw, {});
  assert.equal(r.status, 401);
  assert.equal(calls.length, 0);
});

test("a message goes to the owner of the sender's number, the body is forwarded byte for byte", async () => {
  const { deps, calls } = setup();
  const { raw, headers } = signed(body([msg("966500000001", "w1")]));
  const r = await handleWebhook(deps, raw, headers);
  assert.equal(r.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://expense.example.com/webhook");
  assert.equal(calls[0].body, raw.toString("utf8"));
  assert.equal(calls[0].headers["x-hub-signature-256"], headers["x-hub-signature-256"]);
  assert.equal(calls[0].headers["x-router-secret"], "e-secret");
});

test("an unknown number is never forwarded", async () => {
  const { deps, calls } = setup();
  const { raw, headers } = signed(body([msg("966599999999", "w1")]));
  assert.equal((await handleWebhook(deps, raw, headers)).status, 200);
  assert.equal(calls.length, 0);
});

test("a number whose service is switched off is not forwarded", async () => {
  const { deps, calls } = setup();
  const { raw, headers } = signed(body([msg("966500000003", "w1")]));
  await handleWebhook(deps, raw, headers);
  assert.equal(calls.length, 0);
});

test("delivery statuses follow the recipient's number", async () => {
  const { deps, calls } = setup();
  const { raw, headers } = signed(body([], [{ id: "s1", status: "delivered", recipient_id: "966500000002" }]));
  await handleWebhook(deps, raw, headers);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://invoicing.example.com/webhook");
});

test("a Meta retry of the same message is forwarded only once", async () => {
  const { deps, calls } = setup();
  const { raw, headers } = signed(body([msg("966500000002", "w7")]));
  await handleWebhook(deps, raw, headers);
  await handleWebhook(deps, raw, headers);
  assert.equal(calls.length, 1);
});

test("one POST with people of two services is split; each service gets only its own, validly re-signed", async () => {
  const { deps, calls } = setup();
  const { raw, headers } = signed(body([msg("966500000001", "a"), msg("966500000002", "b")]));
  const r = await handleWebhook(deps, raw, headers);
  assert.equal(r.status, 200);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    const parsed = JSON.parse(c.body);
    const msgs = parsed.entry[0].changes[0].value.messages;
    assert.equal(msgs.length, 1);
    assert.equal(verifyMetaSignature(Buffer.from(c.body), c.headers["x-hub-signature-256"], SECRET), true);
    assert.equal(
      c.url,
      msgs[0].from === "966500000001" ? "https://expense.example.com/webhook" : "https://invoicing.example.com/webhook",
    );
  }
});

test("a service that fails gives 502 so Meta retries, and the retry is then accepted", async () => {
  let fail = true;
  const { deps, calls } = setup(async () => (fail ? new Response("boom", { status: 500 }) : new Response("ok")));
  const { raw, headers } = signed(body([msg("966500000001", "w9")]));
  assert.equal((await handleWebhook(deps, raw, headers)).status, 502);
  fail = false;
  assert.equal((await handleWebhook(deps, raw, headers)).status, 200);
  assert.equal(calls.length, 2);
});

test("an unreachable service gives 502", async () => {
  const { deps } = setup(async () => {
    throw new Error("network");
  });
  const { raw, headers } = signed(body([msg("966500000001", "w10")]));
  assert.equal((await handleWebhook(deps, raw, headers)).status, 502);
});

test("events that belong to no number (template updates etc.) are acknowledged and ignored", async () => {
  const { deps, calls } = setup();
  const { raw, headers } = signed({
    object: "whatsapp_business_account",
    entry: [{ id: "1", changes: [{ field: "message_template_status_update", value: {} }] }],
  });
  assert.equal((await handleWebhook(deps, raw, headers)).status, 200);
  assert.equal(calls.length, 0);
});

test("Meta's address check", () => {
  const q = (o: Record<string, string>) => new URLSearchParams(o);
  assert.deepEqual(
    verifyChallenge(q({ "hub.mode": "subscribe", "hub.verify_token": "t", "hub.challenge": "123" }), "t"),
    { status: 200, body: "123" },
  );
  assert.equal(
    verifyChallenge(q({ "hub.mode": "subscribe", "hub.verify_token": "x", "hub.challenge": "123" }), "t").status,
    403,
  );
  assert.equal(
    verifyChallenge(q({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "1" }), "").status,
    403,
  );
});

test("target addresses: only public https; internal and unsafe ones are refused", () => {
  assert.equal(isSafeTargetUrl("https://svc-abc.a.run.app/webhook"), true);
  for (const bad of [
    "http://svc.example.com/x",
    "https://localhost/x",
    "https://127.0.0.1/x",
    "https://10.0.0.5/x",
    "https://169.254.169.254/x",
    "https://metadata.google.internal/x",
    "https://svc/x",
    "https://user:pw@svc.example.com/x",
    "ftp://svc.example.com",
    "not a url",
    "https://[::1]/x",
  ]) {
    assert.equal(isSafeTargetUrl(bad), false, bad);
  }
});

test("registry JSON: valid list loads, an unsafe target or a number owned twice is refused", async () => {
  const ok = registryFromJson(
    JSON.stringify({
      targets: [{ id: "a", url: "https://a.example.com/w" }],
      numbers: [{ phone: "+966 50 000 0001", target: "a" }],
    }),
  );
  assert.deepEqual(await ok.routes(), [{ phone: "966500000001", targetId: "a" }]);
  assert.throws(() =>
    registryFromJson(JSON.stringify({ targets: [{ id: "a", url: "http://a.example.com" }], numbers: [] })),
  );
  assert.throws(() =>
    registryFromJson(
      JSON.stringify({
        targets: [
          { id: "a", url: "https://a.example.com/w" },
          { id: "b", url: "https://b.example.com/w" },
        ],
        numbers: [
          { phone: "966500000001", target: "a" },
          { phone: "966500000001", target: "b" },
        ],
      }),
    ),
  );
});
