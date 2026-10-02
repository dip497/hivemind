// Telling the person's phones what happened while they were away (push.ts, spec/push.md): an agent
// that begins waiting on the person, finishes or fails is told, and nothing else is (the same wait
// again, another state, an agent first seen as this device starts, one waiting on its supervisor);
// each phone subscribed is posted the notice encrypted to it alone, urgently when it waits on them;
// one its push service no longer knows is dropped; an agent not yet on a board here is told of
// once it is, by at most 200 characters of its name; a device back tells each phone so; and the
// subscriptions are kept one per phone, readable by this user alone; and each notice is posted as
// Web Push takes it, signed by the device that posts it, as a push server asks (0.3). A permission
// the device can allow or deny is told as one (0.4).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createHash, createHmac, createPublicKey, verify, type ECDH } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { newSeed, idOf } from "@hivemind/workspace-host/identity";
import type { WorkspaceChange } from "@hivemind/workspace-host/layout";
import { AGENT_MAX, toldOf, postNotice, PushNotices, PushSubscriptions, type Notice } from "../src/push.ts";
import type { HeldBoard, WaitingStatus } from "../src/needs.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-push-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let made = 0;
const T = 1_790_000_000_000;
const W = "ab".repeat(16);
const held: HeldBoard[] = [{ workspace: W, name: "api", repo: "/home/p/api", core: { frames: [], tiles: [{ id: "t1", kind: "claude", label: "Claude" }] } }];
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

test("each phone subscribed is posted the notice encrypted to it alone, urgently when it waits on them, signed where its subscription asks; one its push service no longer knows is dropped", async () => {
  const [a, b] = [phone("https://push.example/a"), phone("https://push.example/b")];
  const subscriptions = new PushSubscriptions(path.join(tmp, `push-${made++}.json`));
  subscriptions.set("a".repeat(64), { ...a.sub, sign: true });
  subscriptions.set("b".repeat(64), b.sub);
  const posted: Array<{ endpoint: string; body: Buffer; urgency: string; sign: boolean }> = [];
  // b's push service no longer knows it.
  const notices = new PushNotices({ boards: () => held, decides: () => false, changes: () => () => {}, subscriptions, post: async (endpoint, body, urgency, sign) => { posted.push({ endpoint, body, urgency, sign }); return endpoint.endsWith("/b") ? 410 : 201; } });
  notices.changed(change(st("working")));
  notices.changed(change(st("waiting", "permission", T)));
  await new Promise((r) => setImmediate(r));
  const sent = Object.fromEntries(posted.map((p) => [p.endpoint, p]));
  const notice = { v: 1, t: "needs", workspace: W, name: "api", tile: "t1", agent: "Claude", kind: "permission", since: T };
  assert.deepEqual(read(sent["https://push.example/a"]!.body, a.key, a.auth), notice);
  assert.deepEqual(read(sent["https://push.example/b"]!.body, b.key, b.auth), notice);
  assert.throws(() => read(sent["https://push.example/a"]!.body, b.key, b.auth), "not b's to read");
  assert.deepEqual(posted.map((p) => [p.endpoint, p.urgency, p.sign]), [["https://push.example/a", "high", true], ["https://push.example/b", "high", false]]);
  assert.deepEqual(subscriptions.list().map((s) => s.device), ["a".repeat(64)]);

  posted.length = 0;
  notices.changed(change(st("working", undefined, T + 1)));
  notices.changed(change(st("done", undefined, T + 2)));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(posted.map((p) => [p.endpoint, p.urgency]), [["https://push.example/a", "normal"]]);
  assert.deepEqual(read(posted[0]!.body, a.key, a.auth), { v: 1, t: "finished", workspace: W, name: "api", tile: "t1", agent: "Claude", since: T + 2 });
});

test("an agent on no board here yet is told of once its window saves its tile, by at most 200 characters of its name and its workspace's, unless its status changes first", async () => {
  const a = phone("https://push.example/a");
  const subscriptions = new PushSubscriptions(path.join(tmp, `push-${made++}.json`));
  subscriptions.set("a".repeat(64), a.sub);
  const tiles = [{ id: "t1", kind: "claude", label: "Claude" }];
  const named = "ä".repeat(AGENT_MAX + 50);
  const boards = (): HeldBoard[] => [{ workspace: W, name: named, repo: "/home/p/api", core: { frames: [], tiles: [...tiles] } }];
  const heard = new Set<(change: WorkspaceChange) => void>();
  const posted: unknown[] = [];
  const notices = new PushNotices({
    boards,
    decides: () => false,
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
  assert.deepEqual(posted, [{ v: 1, t: "needs", workspace: W, name: "ä".repeat(AGENT_MAX), tile: "t2", agent: "🐝".repeat(AGENT_MAX), kind: "permission", since: T }]);
});

test("a permission the device can allow or deny is told as one, so the phone may offer Allow / Deny; a question of the same agent, or a permission of one that says no keys, is not", async () => {
  const a = phone("https://push.example/a");
  const subscriptions = new PushSubscriptions(path.join(tmp, `push-${made++}.json`));
  subscriptions.set("a".repeat(64), a.sub);
  const boards = (): HeldBoard[] => [{ workspace: W, name: "api", repo: "/home/p/api", core: { frames: [], tiles: [{ id: "t1", kind: "claude", label: "Claude" }, { id: "t2", kind: "probe", label: "Probe" }] } }];
  const posted: unknown[] = [];
  const notices = new PushNotices({ boards, decides: (tile) => tile === "t1", changes: () => () => {}, subscriptions, post: async (_endpoint, body) => { posted.push(read(body, a.key, a.auth)); return 201; } });
  for (const tile of ["hm:t1", "hm:t2"]) notices.changed(change(st("idle"), tile));
  notices.changed(change(st("waiting", "permission", T), "hm:t1"));
  notices.changed(change(st("waiting", "permission", T + 1), "hm:t2"));
  notices.changed(change(st("waiting", "question", T + 2), "hm:t1"));
  await new Promise((r) => setImmediate(r));
  const told = { v: 1, t: "needs", workspace: W, name: "api" };
  assert.deepEqual(posted, [
    { ...told, tile: "t1", agent: "Claude", kind: "permission", since: T, decide: true },
    { ...told, tile: "t2", agent: "Probe", kind: "permission", since: T + 1 },
    { ...told, tile: "t1", agent: "Claude", kind: "question", since: T + 2 },
  ]);
});

test("a device back tells each phone subscribed, encrypted to it, by its id and what it is called (at most 200 characters of it), plainly", async () => {
  const [a, b] = [phone("https://push.example/a"), phone("https://push.example/b")];
  const subscriptions = new PushSubscriptions(path.join(tmp, `push-${made++}.json`));
  subscriptions.set("a".repeat(64), a.sub);
  subscriptions.set("b".repeat(64), b.sub);
  const posted: Array<{ endpoint: string; body: Buffer; urgency: string }> = [];
  const notices = new PushNotices({
    me: () => ({ device: "d".repeat(64), name: "desk".repeat(AGENT_MAX) }),
    boards: () => held,
    decides: () => false,
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
    assert.deepEqual({ ...back, since: 0 }, { v: 1, t: "back", device: "d".repeat(64), name: "desk".repeat(AGENT_MAX / 4), since: 0 });
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
  subscriptions.set("a".repeat(64), { ...a2.sub, sign: true });
  assert.deepEqual(subscriptions.list(), [{ device: "b".repeat(64), ...b.sub }, { device: "a".repeat(64), ...a2.sub, sign: true }]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  subscriptions.remove("b".repeat(64));
  const kept = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(file, JSON.stringify({ ...kept, ["c".repeat(64)]: { endpoint: "ftp://x", p256dh: "", auth: "" }, ["d".repeat(64)]: { ...b.sub, sign: "yes" }, nonsense: a.sub }));
  assert.deepEqual(subscriptions.list(), [{ device: "a".repeat(64), ...a2.sub, sign: true }, { device: "d".repeat(64), ...b.sub }]);
});

test("a notice is posted as Web Push takes it; signed, where its subscription asks, by the device that posts it over the phone's handle, its time and its body; and never where a redirect points", async () => {
  const got: Array<{ url: string; headers: http.IncomingHttpHeaders; body: Buffer }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      got.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
      if (req.url === "/moved") res.writeHead(307, { Location: "/push/elsewhere" }).end();
      else res.writeHead(201).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const { port } = server.address() as { port: number };
  const handle = "00112233445566778899aabbccddeeff";
  const device = newSeed();
  const body = Buffer.from("a notice, encrypted to the phone");
  const before = Date.now();
  assert.equal(await postNotice(`http://127.0.0.1:${port}/push/${handle}`, body, "high", device), 201);
  const [{ headers, body: posted }] = got;
  assert.deepEqual(posted, body);
  assert.deepEqual(
    { ttl: headers.ttl, urgency: headers.urgency, encoding: headers["content-encoding"], type: headers["content-type"] },
    { ttl: "86400", urgency: "high", encoding: "aes128gcm", type: "application/octet-stream" },
  );
  // Hive-Sender: the device, the time, Ed25519 over "hive/push-notice/1\n", the handle, "\n",
  // the time, "\n" and SHA-256 of the body (checked here apart from the code).
  const [id, at, signature, ...rest] = String(headers["hive-sender"]).split(" ");
  assert.deepEqual(rest, []);
  assert.equal(id, idOf(device));
  assert.ok(Number(at) >= before && Number(at) <= Date.now(), at);
  const signed = Buffer.concat([Buffer.from(`hive/push-notice/1\n${handle}\n${at}\n`), createHash("sha256").update(body).digest()]);
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(id!, "hex")]), format: "der", type: "spki" });
  assert.ok(verify(null, signed, key, Buffer.from(signature!, "hex")), "the signature is the device's over the handle, the time and the body");

  // Unsigned where the subscription does not ask: the device's key goes to no one else.
  assert.equal(await postNotice(`http://127.0.0.1:${port}/up/a-phone`, body, "normal", null), 201);
  assert.equal(got[1]!.headers["hive-sender"], undefined);
  // A redirect is not followed: the notice goes nowhere else.
  await assert.rejects(postNotice(`http://127.0.0.1:${port}/moved`, body, "normal", device));
  assert.deepEqual(got.map((g) => g.url), [`/push/${handle}`, "/up/a-phone", "/moved"]);
});
