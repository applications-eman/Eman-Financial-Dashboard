import { loadPrivateKey } from "./invoicing/flow-crypto.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

const PASS = "correct horse";

function pems() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const plain = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const encrypted = privateKey
    .export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: PASS })
    .toString();
  return { plain, encrypted };
}

test("the Flow key is read however it was stored", () => {
  const { plain, encrypted } = pems();
  const oneLine = (p: string, sep: string) => p.trim().split("\n").join(sep);
  const cases: [string, string, string | undefined][] = [
    ["real line breaks", plain, undefined],
    ["typed-out \\n", oneLine(plain, "\\n"), undefined],
    ["typed-out doubled \\\\n", oneLine(plain, "\\\\n"), undefined],
    ["quoted with doubled \\\\n and a final one", `"${oneLine(encrypted, "\\\\n")}\\\\n"`, PASS],
    ["encrypted, real line breaks", encrypted, PASS],
    ["encrypted, passphrase with a trailing space", encrypted, `${PASS} `],
    ["single quotes", `'${oneLine(plain, "\\n")}'`, undefined],
  ];
  for (const [name, pem, pass] of cases) {
    const key = loadPrivateKey(pem, pass);
    assert.equal(key.asymmetricKeyType, "rsa", name);
  }
  assert.throws(() => loadPrivateKey(encrypted, "wrong passphrase"));
  assert.throws(() => loadPrivateKey(encrypted), /passphrase, but none was given/);
  assert.throws(() => loadPrivateKey(encrypted, "  "), /passphrase, but none was given/);
  assert.throws(() => loadPrivateKey(encrypted, "wrong"), /does not match the key/);
  assert.throws(() => loadPrivateKey("garbage"), /could not be read/);
});
