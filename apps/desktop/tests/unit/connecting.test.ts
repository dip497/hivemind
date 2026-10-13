// Connect, in the app (main/connecting.ts, spec/pairing.md 0.10): a request nobody answers in time
// is no; no and an expired offer keep nothing and admit nobody; it's me keeps the device once it
// took the person there, and goes when it does not in time; someone else is let into the workspace
// of the window the offer was made in, never from Home; either use ends the offer, and a new offer
// voids the last. Here the network is the call to `answer` with the asking device's key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connectProof, type ConnectRequest, type GuestAnswer } from "@hivemind/workspace-host/connect";
import { certifyDevice, idOf, newSeed } from "@hivemind/workspace-host/identity";
import type { Pairing } from "@hivemind/workspace-host/pairing";
import { ANSWER_WITHIN_MS } from "@hivemind/host/people";
import { OFFER_TTL_MS, TAKE_WITHIN_MS, connectAnnouncement } from "@hivemind/workspace-host/connect";
import { Connecting } from "../../src/main/connecting.ts";
import type { ConnectState } from "../../src/shared/ipc.ts";

const GUEST: GuestAnswer = { workspace: "0f".repeat(16), host: "1e".repeat(32), addrs: [], relay: null, role: "view", names: { workspace: "api", host: "Asha" }, hosting: null };

function app(o: { admitFails?: boolean } = {}) {
  const person = newSeed();
  const key = idOf(newSeed());
  const me = { device: key, name: "Asha's desktop", kind: "app" as const, person, certificate: certifyDevice(person, key), addrs: ["10.0.0.2:4433"], relay: null, profile: { name: "Asha", color: "#336699" } };
  const announced: Array<string | null> = [];
  const admitted: Array<[string, ConnectRequest, string]> = [];
  const kept: Pairing[] = [];
  const states: ConnectState[] = [];
  const connecting = new Connecting({
    me: async () => me,
    announce: (d) => announced.push(d),
    admission: async () => undefined,
    admit: async (repo, request, role) => {
      if (o.admitFails) throw new Error("people: this workspace does not say whose it is yet");
      admitted.push([repo, request, role]);
      return { ...GUEST, role: role as GuestAnswer["role"] };
    },
    kept: (p) => kept.push(p),
    changed: (s) => states.push(s),
  });
  /** A device asking with the offer of `code`; a computer when it has a certificate. */
  const ask = (code: string, kind: "phone" | "app" | "host" = "phone", shares = false) => {
    const seed = newSeed();
    const device = idOf(seed);
    const certificate = kind !== "phone" ? { certificate: certifyDevice(newSeed(), device), profile: { name: "Ravi", color: "#aa3300" }, shares } : {};
    const reply = connecting.answer(device, { v: 1, connect: "ask", proof: connectProof(code, "entering", me.device, device), nonce: "ab".repeat(16), name: kind === "app" ? "Ravi's laptop" : "iPhone", kind, ...certificate }) as { ok: boolean; request: string };
    const send = (connect: string) => connecting.answer(device, { v: 1, connect, request: reply.request });
    return { device, reply, id: reply.request, wait: () => send("wait") as Promise<unknown>, take: () => send("take"), refuse: () => send("refuse") };
  };
  return { me, connecting, announced, admitted, kept, states, ask, last: () => states.at(-1)! };
}

test("a request nobody answers in time is no: the device is told declined, nothing is kept, and the offer stays", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const a = app();
  const { code } = await a.connecting.offer("/work/api");
  assert.deepEqual(a.announced, [connectAnnouncement(code)]);
  const phone = a.ask(code);
  const told = phone.wait();
  assert.deepEqual(a.last().requests.map((r) => [r.name, r.kind, r.me, r.guest, r.confirming]), [["iPhone", "phone", true, false, false]]);

  t.mock.timers.tick(ANSWER_WITHIN_MS);
  assert.deepEqual(await told, { ok: false, error: "declined" });
  assert.deepEqual(a.last().requests, []);
  assert.equal(a.last().offer?.code, code);
  assert.deepEqual([a.kept, a.admitted], [[], []]);
});

test("no keeps nothing and admits nobody, and the offer stays for the next", async () => {
  const a = app();
  const { code } = await a.connecting.offer("/work/api");
  const laptop = a.ask(code, "app");
  const told = laptop.wait();
  await a.connecting.decide(laptop.id, { as: "no" });
  assert.deepEqual(await told, { ok: false, error: "declined" });
  assert.deepEqual([a.kept, a.admitted, a.last().requests], [[], [], []]);
  assert.equal(a.ask(code).reply.ok, true);
});

test("it's me keeps the device once it took the person there, and the offer is over", async () => {
  const a = app();
  const { code } = await a.connecting.offer(null);
  const phone = a.ask(code);
  const other = a.ask(code);
  const otherTold = other.wait();
  await a.connecting.decide(phone.id, { as: "me" });
  assert.deepEqual(await phone.wait(), { ok: true, as: "me", profile: a.me.profile });
  assert.deepEqual(await otherTold, { ok: false, error: "expired" });
  assert.deepEqual(a.last().requests.map((r) => [r.id, r.confirming]), [[phone.id, true]]);
  // Answered: only the device's own person decides from here.
  await assert.rejects(a.connecting.decide(phone.id, { as: "no" }), /waits no more/);
  assert.equal(a.last().offer, null);
  assert.deepEqual(a.announced.at(-1), null);
  assert.deepEqual(a.kept, []);

  assert.equal((phone.take() as { ok: boolean }).ok, true);
  assert.deepEqual(a.kept.map((p) => [p.with.device, p.with.kind]), [[phone.device, "phone"]]);
  assert.deepEqual(a.last(), { offer: null, requests: [], last: { name: "iPhone", as: "me" } });
  assert.deepEqual(a.ask(code).reply, { ok: false, error: "expired" });
});

test("it's me goes when the device's person says the words do not match, or says nothing in time", async (t) => {
  const a = app();
  const { code } = await a.connecting.offer(null);
  const phone = a.ask(code);
  await a.connecting.decide(phone.id, { as: "me" });
  assert.deepEqual(phone.refuse(), { ok: true });
  assert.deepEqual(a.last(), { offer: null, requests: [], last: { name: "iPhone", as: "refused" } });

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const again = await a.connecting.offer(null);
  const late = a.ask(again.code);
  await a.connecting.decide(late.id, { as: "me" });
  t.mock.timers.tick(TAKE_WITHIN_MS);
  assert.deepEqual(a.last(), { offer: null, requests: [], last: null });
  assert.deepEqual(late.take(), { ok: false, error: "expired" });
  assert.deepEqual(a.kept, []);
});

test("someone else is let into the workspace of the window the offer was made in, at the role chosen", async () => {
  const a = app();
  const { code } = await a.connecting.offer("/work/api");
  const laptop = a.ask(code, "app");
  const told = laptop.wait();
  assert.deepEqual(a.last().requests.map((r) => [r.me, r.guest]), [[true, true]]);
  await a.connecting.decide(laptop.id, { as: "guest", role: "edit" });
  assert.deepEqual(await told, { ok: true, as: "guest", ...GUEST, role: "edit" });
  assert.deepEqual(a.admitted.map(([repo, r, role]) => [repo, r.device, role]), [["/work/api", laptop.device, "edit"]]);
  assert.deepEqual(a.kept, []);
  assert.deepEqual(a.last(), { offer: null, requests: [], last: { name: "Ravi's laptop", as: "guest" } });
});

test("someone else is no answer from Home, nor for a phone", async () => {
  const a = app();
  const home = await a.connecting.offer(null);
  const laptop = a.ask(home.code, "app");
  assert.equal(a.last().requests[0]!.guest, false);
  await assert.rejects(a.connecting.decide(laptop.id, { as: "guest", role: "view" }), /from Home/);

  const there = await a.connecting.offer("/work/api");
  const phone = a.ask(there.code);
  assert.equal(a.last().requests[0]!.guest, false);
  await assert.rejects(a.connecting.decide(phone.id, { as: "guest", role: "view" }), /as someone else/);
  assert.deepEqual(a.admitted, []);
});

test("a new offer voids the last: its requests are told it expired, and its code is no longer announced", async () => {
  const a = app();
  const first = await a.connecting.offer("/work/api");
  const phone = a.ask(first.code);
  const told = phone.wait();
  const second = await a.connecting.offer("/work/api");
  assert.deepEqual(await told, { ok: false, error: "expired" });
  assert.deepEqual(a.announced, [connectAnnouncement(first.code), null, connectAnnouncement(second.code)]);
  assert.deepEqual(a.ask(first.code).reply, { ok: false, error: "wrong-code" });
  a.connecting.cancel();
  assert.deepEqual(a.last(), { offer: null, requests: [], last: null });
  assert.deepEqual(a.ask(second.code).reply, { ok: false, error: "expired" });
});

test("a host, or a computer that shares workspaces as its own person, is not offered it's me", async () => {
  const a = app();
  const { code } = await a.connecting.offer("/work/api");
  const host = a.ask(code, "host");
  const sharing = a.ask(code, "app", true);
  assert.deepEqual(a.last().requests.map((r) => [r.kind, r.me, r.guest]), [["host", false, true], ["app", false, true]]);
  for (const d of [host, sharing]) await assert.rejects(a.connecting.decide(d.id, { as: "me" }), /cannot be yours/);
  assert.equal(a.last().offer?.code, code);
});

test("a device its workspace's host could not let in is told no, and the offer, used on it, is over", async () => {
  const a = app({ admitFails: true });
  const { code } = await a.connecting.offer("/work/api");
  const laptop = a.ask(code, "app");
  const told = laptop.wait();
  await assert.rejects(a.connecting.decide(laptop.id, { as: "guest", role: "view" }), /does not say whose it is/);
  assert.deepEqual(await told, { ok: false, error: "declined" });
  assert.deepEqual(a.last(), { offer: null, requests: [], last: null });
  assert.deepEqual(a.announced.at(-1), null);
});

test("an offer ends after a day: its code is no longer announced, and those waiting are told it expired", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const a = app();
  const { code } = await a.connecting.offer(null);
  t.mock.timers.tick(OFFER_TTL_MS - 1000);
  const told = a.ask(code).wait();
  t.mock.timers.tick(1000);
  assert.deepEqual(await told, { ok: false, error: "expired" });
  assert.deepEqual(a.last(), { offer: null, requests: [], last: null });
  assert.deepEqual(a.announced, [connectAnnouncement(code), null]);
});
