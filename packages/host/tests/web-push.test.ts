// Web Push message encryption (web-push.ts, spec/push.md), held to conformance/push.json: RFC
// 8291's example, which a device's encryption reproduces byte for byte from the sender's key and
// salt; each message sent has a key pair and a salt of its own; and a subscription is taken only
// when it is one (an http(s) endpoint, a P-256 key, a 16-byte secret). The phone's side (it
// decrypts) is held to the same file in crates/hive-phone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RECORD_SIZE, encrypt, encryptWith, subscriptionOf } from "../src/web-push.ts";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../conformance/push.json");
const r = (JSON.parse(fs.readFileSync(file, "utf8")) as { rfc8291: Record<string, string> }).rfc8291;
const b = (s: string) => Buffer.from(s, "base64url");

test("a device encrypts a notice as RFC 8291's example does, byte for byte", () => {
  assert.equal(encryptWith(b(r.plaintext), b(r.uaPublic), b(r.auth), b(r.asPrivate), b(r.salt)).toString("base64url"), r.body);
});

test("each message has a key pair and a salt of its own, in one record of the spec's size", () => {
  const phone = createECDH("prime256v1");
  phone.generateKeys();
  const to = { endpoint: "https://push.example/x", p256dh: phone.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 7).toString("base64url") };
  const [one, two] = [encrypt(Buffer.from("hello"), to), encrypt(Buffer.from("hello"), to)];
  for (const body of [one, two]) {
    assert.equal(body.readUInt32BE(16), RECORD_SIZE);
    assert.equal(body[20], 65);
    assert.equal(body.length, 86 + 5 + 1 + 16);
  }
  assert.notDeepEqual(one.subarray(0, 16), two.subarray(0, 16), "salts");
  assert.notDeepEqual(one.subarray(21, 86), two.subarray(21, 86), "keys");
});

test("a subscription is taken only when it is one: an http(s) endpoint, a P-256 key, a 16-byte secret", () => {
  const good = { endpoint: "https://push.example/sub/1", p256dh: r.uaPublic, auth: r.auth };
  assert.deepEqual(subscriptionOf({ ...good, extra: 1 }), good);
  assert.deepEqual(subscriptionOf({ ...good, endpoint: "http://192.168.1.31:8080/push" })?.endpoint, "http://192.168.1.31:8080/push");
  const bad: unknown[] = [
    null, { ...good, endpoint: "file:///etc/passwd" }, { ...good, endpoint: "not a url" }, { ...good, endpoint: `https://x/${"a".repeat(1000)}` },
    { ...good, p256dh: r.auth }, { ...good, p256dh: Buffer.alloc(65, 4).toString("base64url") }, { ...good, auth: r.uaPublic }, { ...good, auth: 5 },
  ];
  for (const s of bad) assert.equal(subscriptionOf(s), null, JSON.stringify(s));
});
