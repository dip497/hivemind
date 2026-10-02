// Telling the person's phones what happened while they were away (push.ts, spec/push.md): an agent
// that begins waiting on the person, finishes or fails is told, and nothing else is (the same wait
// again, another state, an agent first seen as this device starts, one waiting on its supervisor);
// each phone subscribed is posted the notice encrypted to it alone, urgently when it waits on them;
// one its push service no longer knows is dropped; an agent not yet on a board here is told of
// once it is, by at most 200 characters of its name; a device back tells each phone so; and the
// subscriptions are kept one per phone, readable by this user alone.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createHmac, type ECDH } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkspaceChange } from "@hivemind/workspace-host/layout";
import { AGENT_MAX, toldOf, PushNotices, PushSubscriptions, type Notice } from "../src/push.ts";
import type { HeldBoard, WaitingStatus } from "../src/needs.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-push-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let made = 0;
const T = 1_790_000_000_000;
const W = "ab".repeat(16);
const held: HeldBoard[] = [{ workspace: W, name: "api", core: { frames: [], tiles: [{ id: "t1", kind: "claude", label: "Claude" }] } }];
type Status = WaitingStatus["status"];
const st = (state: string, kind?: Status["kind"], since = T, title?: string): Status => ({ state, ...(kind ? { kind } : {}), since, ...(title ? { title } : {}) });
const change = (status: Status, tileId = "hm:t1"): WaitingStatus => ({ tileId, status });

/** A phone: its push key and secret, and its subscription at `endpoint`. */
function phone(endpoint: string) {
  const key = createECDH("prime256v1");
  key.generateKeys();
  const auth = Buffer.alloc(16, made++);
  return { key, auth, sub: { endpoint, p256dh: key.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
}
/** What `body` says to the phone whose key is `key` (RFC 8291, done here apart from the code). */
function read(body: Buffer, key: ECDH, auth: Buffer): unknown {
  const hmac = (k: Uint8Array, d: Uint8Array) => createHmac("sha256", k).update(d).digest();
  const sender = body.subarray(21, 86);
  const ikm = hmac(hmac(auth, key.computeSecret(sender)), Buffer.concat([Buffer.from("WebPush: info\0"), key.getPublicKey(), sender, Buffer.from([1])]));
  const prk = hmac(body.subarray(0, 16), ikm);
  const decipher = createDecipheriv("aes-128-gcm", hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16), hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12));
  const record = body.subarray(86);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  assert.equal(plain[plain.length - 1], 2, "the last record's delimiter");
  return JSON.parse(plain.subarray(0, plain.length - 1).toString("utf8"));
}

test("an agent that begins waiting on the person, finishes or fails is told; nothing else is", () => {
  const cases: Array<[Status | undefined, Status, Notice["t"] | null, string]> = [
    [st("idle"), st("waiting", "permission"), "needs", "begins waiting"],
    [st("waiting", "permission"), st("waiting", "permission", T, "Editing Nav.tsx"), null, "the same wait"],
    [st("waiting", "permission"), st("waiting", "question", T + 5), "needs", "a wait anew"],
    [st("working"), st("done", undefined, T + 9), "finished", "finishes"],
    [st("done"), st("done", undefined, T + 9), null, "done still"],
    [st("working"), st("failed", undefined, T + 9), "failed", "fails"],
    [st("working"), st("waiting", "approval"), null, "waits on its supervisor"],
    [st("idle"), st("working"), null, "works"],
    [undefined, st("waiting", "permission"), null, "first seen now"],
  ];
  for (const [before, now, t, about] of cases) assert.equal(toldOf(before, now), t, about);
});

test("each phone subscribed is posted the notice encrypted to it alone, urgently when it waits on them; one its push service no longer knows is dropped", async () => {
  const [a, b] = [phone("https://push.example/a"), phone("https://push.example/b")];
  const subscriptions = new PushSubscriptions(path.join(tmp, `push-${made++}.json`));
  subscriptions.set("a".repeat(64), a.sub);
  subscriptions.set("b".repeat(64), b.sub);
  const posted: Array<{ endpoint: string; body: Buffer; urgency: string }> = [];
  // b's push service no longer knows it.
  const notices = new PushNotices({ boards: () => held, changes: () => () => {}, subscriptions, post: async (endpoint, body, urgency) => { posted.push({ endpoint, body, urgency }); return endpoint.endsWith("/b") ? 410 : 201; } });
  notices.changed(change(st("working")));
  notices.changed(change(st("waiting", "permission", T)));
  await new Promise((r) => setImmediate(r));
  const sent = Object.fromEntries(posted.map((p) => [p.endpoint, p]));
  const notice = { v: 1, t: "needs", workspace: W, name: "api", tile: "t1", agent: "Claude", kind: "permission", since: T };
  assert.deepEqual(read(sent["https://push.example/a"]!.body, a.key, a.auth), notice);
  assert.deepEqual(read(sent["https://push.example/b"]!.body, b.key, b.auth), notice);
  assert.throws(() => read(sent["https://push.example/a"]!.body, b.key, b.auth), "not b's to read");
  assert.deepEqual(posted.map((p) => p.urgency), ["high", "high"]);
  assert.deepEqual(subscriptions.list().map((s) => s.device), ["a".repeat(64)]);

  posted.length = 0;
  notices.changed(change(st("working", undefined, T + 1)));
  notices.changed(change(st("done", undefined, T + 2)));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(posted.map((p) => [p.endpoint, p.urgency]), [["https://push.example/a", "normal"]]);
  assert.deepEqual(read(posted[0]!.body, a.key, a.auth), { v: 1, t: "finished", workspace: W, name: "api", tile: "t1", agent: "Claude", since: T + 2 });
});

test("an agent on no board here yet is told of once its window saves its tile, by at most 200 characters of its name, unless its status changes first", async () => {
  const a = phone("https://push.example/a");
  const subscriptions = new PushSubscriptions(path.join(tmp, `push-${made++}.json`));
  subscriptions.set("a".repeat(64), a.sub);
  const tiles = [{ id: "t1", kind: "claude", label: "Claude" }];
  const boards = (): HeldBoard[] => [{ workspace: W, name: "api", core: { frames: [], tiles: [...tiles] } }];
  const heard = new Set<(change: WorkspaceChange) => void>();
  const posted: unknown[] = [];
  const notices = new PushNotices({
    boards,
    changes: (l) => { heard.add(l); return () => { heard.delete(l); }; },
    subscriptions,
    post: async (_endpoint, body) => { posted.push(read(body, a.key, a.auth)); return 201; },
  });
  const settle = () => new Promise((r) => setImmediate(r));
  /** The window saves the board with `tile` on it. */
  const save = async (tile: string) => {
    tiles.push({ id: tile, kind: "claude", label: "Claude" });
    for (const l of heard) l({ repo: "/work/api", part: "core", writer: "" });
    await settle();
  };
  // Both begin waiting before their windows save them; t3 works again before it is saved.
  for (const tile of ["hm:t2", "hm:t3"]) {
    notices.changed(change(st("idle"), tile));
    notices.changed(change(st("waiting", "permission", T, "🐝".repeat(AGENT_MAX * 3)), tile));
  }
  notices.changed(change(st("working", undefined, T + 1), "hm:t3"));
  await settle();
  assert.deepEqual(posted, []);
  await save("t2");
  await save("t3");
  assert.deepEqual(posted, [{ v: 1, t: "needs", workspace: W, name: "api", tile: "t2", agent: "🐝".repeat(AGENT_MAX), kind: "permission", since: T }]);
});

test("a device back tells each phone subscribed, encrypted to it, by its id and what it is called, plainly", async () => {
  const [a, b] = [phone("https://push.example/a"), phone("https://push.example/b")];
  const subscriptions = new PushSubscriptions(path.join(tmp, `push-${made++}.json`));
  subscriptions.set("a".repeat(64), a.sub);
  subscriptions.set("b".repeat(64), b.sub);
  const posted: Array<{ endpoint: string; body: Buffer; urgency: string }> = [];
  const notices = new PushNotices({
    me: () => ({ device: "d".repeat(64), name: "desk" }),
    boards: () => held,
    changes: () => () => {},
    subscriptions,
    post: async (endpoint, body, urgency) => { posted.push({ endpoint, body, urgency }); return 201; },
  });
  const before = Date.now();
  notices.back();
  await new Promise((r) => setImmediate(r));
  const sent = Object.fromEntries(posted.map((p) => [p.endpoint, p]));
  for (const [to, endpoint] of [[a, "https://push.example/a"], [b, "https://push.example/b"]] as const) {
    const back = read(sent[endpoint]!.body, to.key, to.auth) as { since: number };
    assert.deepEqual({ ...back, since: 0 }, { v: 1, t: "back", device: "d".repeat(64), name: "desk", since: 0 });
    assert.ok(back.since >= before && back.since <= Date.now());
  }
  assert.deepEqual(posted.map((p) => p.urgency), ["normal", "normal"]);
});

test("subscriptions are kept one per phone, readable by this user alone; anything malformed is not one", () => {
  const file = path.join(tmp, `push-${made++}.json`);
  const subscriptions = new PushSubscriptions(file);
  const [a, a2, b] = [phone("https://push.example/a"), phone("https://push.example/a2"), phone("https://push.example/b")];
  subscriptions.set("a".repeat(64), a.sub);
  subscriptions.set("b".repeat(64), b.sub);
  subscriptions.set("a".repeat(64), a2.sub);
  assert.deepEqual(subscriptions.list(), [{ device: "b".repeat(64), ...b.sub }, { device: "a".repeat(64), ...a2.sub }]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  subscriptions.remove("b".repeat(64));
  const kept = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(file, JSON.stringify({ ...kept, ["c".repeat(64)]: { endpoint: "ftp://x", p256dh: "", auth: "" }, nonsense: a.sub }));
  assert.deepEqual(subscriptions.list(), [{ device: "a".repeat(64), ...a2.sub }]);
});
