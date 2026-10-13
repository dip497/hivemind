// Connecting (connect.ts, spec/pairing.md 0.10): a device using an app's offer only asks; the person
// at the app answers. Told "it's me", a device takes the person once its own person agrees, and both
// screens showed the same words, new for each request; someone else is let in where the app's
// `admit` says; no, a wrong code, a fourth request or an expired offer give nothing. Here the channel
// `hive/pair/1` gives is the call to the offer with the asking device's key as the peer.
import { describe, expect, test } from "bun:test";
import {
  ConnectOffer, OFFER_TTL_MS, TAKE_WITHIN_MS, WAITING_AT_MOST, connectProof, connectWords, enterConnect,
  type ConnectRequest, type Entering, type GuestAnswer,
} from "../src/connect.ts";
import { certificateVerifies, certifyDevice, idOf, newSeed, type Seed } from "../src/identity.ts";
import { CODE_TRIES, PairingFailed, type DeviceKind, type Pairing, type PairingDevice } from "../src/pairing.ts";

function device(kind: DeviceKind, name: string, person: Seed = newSeed()): PairingDevice {
  const key = newSeed();
  return { device: idOf(key), name, kind, person, certificate: certifyDevice(person, idOf(key)), addrs: [`10.0.0.${name.length}:4433`], relay: null };
}
const ASHA = { name: "Asha", color: "#336699" };
const entering = (d: PairingDevice, shares = false): Entering => ({ ...d, profile: { name: "Ravi", color: "#aa3300" }, ...(shares ? { shares } : {}) });

/** An offer of `me`'s, and what it told. */
function offering(me = device("app", "Asha's desktop"), network?: string) {
  const asked: ConnectRequest[] = [];
  const gone: string[] = [];
  const settled: Pairing[] = [];
  const offer = new ConnectOffer({ ...me, profile: ASHA, ...(network ? { network } : {}) }, { asked: (r) => asked.push(r), gone: (id) => gone.push(id), settled: (p) => settled.push(p) });
  return { me, offer, asked, gone, settled };
}
type Offered = ReturnType<typeof offering>;

/** `joiner` using `o`'s offer, and what its screen showed. */
function use(joiner: Entering, o: Offered, sure = true) {
  const shown: string[][] = [];
  const sureOf: unknown[] = [];
  const done = enterConnect({
    me: joiner, code: o.offer.code, offering: o.me.device, ask: async (hello) => o.offer.answer(joiner.device, hello),
    words: (w) => shown.push(w), sure: async (p) => (sureOf.push(p), sure),
  });
  done.catch(() => {});
  return { done, shown, sureOf };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

/** A device's ask, as the spec has it, made for `code`. */
const ask = (o: Offered, from: string, extra: Record<string, unknown> = {}, code = o.offer.code) =>
  o.offer.answer(from, { v: 1, connect: "ask", proof: connectProof(code, "entering", o.me.device, from), nonce: "ab".repeat(16), name: "iPhone", kind: "phone", ...extra }) as Record<string, unknown>;

describe("it's me", () => {
  test("an app told it is the person's takes the person once its own person agrees, and both screens show the same words", async () => {
    const o = offering();
    const laptop = device("app", "Asha's laptop");
    const u = use(entering(laptop), o);
    await settle();

    expect(o.asked).toHaveLength(1);
    const request = o.asked[0]!;
    expect(request).toMatchObject({ device: laptop.device, name: "Asha's laptop", kind: "app", certificate: laptop.certificate, profile: { name: "Ravi", color: "#aa3300" }, shares: false, addrs: laptop.addrs });
    expect(request.words).toHaveLength(3);
    expect(u.shown).toEqual([request.words]);
    expect(o.settled).toEqual([]);

    expect(o.offer.itsMe(request.id)).toBe(true);
    const done = await u.done;
    expect(u.sureOf).toEqual([ASHA]);
    expect(done).toEqual({ as: "me", pairing: { with: { device: o.me.device, name: "Asha's desktop", kind: "app", certificate: o.me.certificate, addrs: o.me.addrs, relay: null }, person: o.me.person } });
    expect(o.settled).toHaveLength(1);
    expect(o.settled[0]).toMatchObject({ person: null, with: { device: laptop.device, name: "Asha's laptop", kind: "app", addrs: laptop.addrs } });
    expect(certificateVerifies(o.settled[0]!.with.certificate)).toBe(true);
    expect(o.settled[0]!.with.certificate).toMatchObject({ person: idOf(o.me.person), device: laptop.device });
    // Used: the offer lets nobody else in.
    expect(ask(o, device("app", "another").device)).toEqual({ ok: false, error: "expired" });
  });

  test("a phone is given a certificate naming it and the app's network, never the person key", async () => {
    const o = offering(undefined, "home-net");
    const phone = idOf(newSeed());
    expect(ask(o, phone)).toMatchObject({ ok: true });
    const { id } = o.asked[0]!;
    expect(o.asked[0]).toMatchObject({ kind: "phone", certificate: null, profile: null });
    const told = o.offer.answer(phone, { v: 1, connect: "wait", request: id });
    o.offer.itsMe(id);
    expect(await told).toEqual({ ok: true, as: "me", profile: ASHA });

    const taken = o.offer.answer(phone, { v: 1, connect: "take", request: id }) as Record<string, unknown>;
    expect(taken).toMatchObject({ ok: true, network: "home-net" });
    expect(taken.person).toBeUndefined();
    expect(taken.yours).toMatchObject({ person: idOf(o.me.person), device: phone });
    expect(o.settled).toEqual([{ with: { device: phone, name: "iPhone", kind: "phone", certificate: taken.yours, addrs: [], relay: null }, person: null }]);
  });

  test("the words are the same on both sides, and new when either side's nonce is", () => {
    const o = offering();
    const phone = idOf(newSeed());
    const nonceJ = "cd".repeat(16);
    const reply = ask(o, phone, { nonce: nonceJ });
    expect(o.asked[0]!.words).toEqual(connectWords(o.offer.code, o.me.device, phone, reply.nonce as string, nonceJ));
    expect(connectWords(o.offer.code, o.me.device, phone, reply.nonce as string, "ce".repeat(16))).not.toEqual(o.asked[0]!.words);
    // Asked again, with the same nonce: the offering side's is new, and so are the words.
    const again = ask(o, phone, { nonce: nonceJ });
    expect(again.nonce).not.toBe(reply.nonce);
    expect(o.asked[1]!.words).toEqual(connectWords(o.offer.code, o.me.device, phone, again.nonce as string, nonceJ));
    expect(o.asked[1]!.words).not.toEqual(o.asked[0]!.words);
  });

  test("when the person there says the words do not match, nothing is taken, and the offer is used", async () => {
    const o = offering();
    const laptop = device("app", "laptop");
    const u = use(entering(laptop), o, false);
    await settle();
    const { id } = o.asked[0]!;
    o.offer.itsMe(id);
    await expect(u.done).rejects.toThrow("the words did not match");
    expect(o.gone).toEqual([id]);
    expect(o.settled).toEqual([]);
    expect(o.offer.answer(laptop.device, { v: 1, connect: "take", request: id })).toEqual({ ok: false, error: "expired" });
    expect(o.offer.open()).toBe(false);
  });

  test("the person may be taken only for a while after it's me", async () => {
    const o = offering();
    const phone = idOf(newSeed());
    ask(o, phone);
    const { id } = o.asked[0]!;
    const at = Date.now();
    o.offer.itsMe(id, at);
    expect(o.offer.answer(phone, { v: 1, connect: "take", request: id }, at + TAKE_WITHIN_MS + 1)).toEqual({ ok: false, error: "expired" });
    expect(o.settled).toEqual([]);
  });

  test("it's me is no answer to a host, nor to an app that shares workspaces as its own person", async () => {
    const o = offering();
    use(entering(device("host", "home-server")), o);
    use(entering(device("app", "Ravi's laptop"), true), o);
    await settle();
    expect(o.asked.map((r) => [r.kind, r.shares])).toEqual([["host", false], ["app", true]]);
    for (const r of o.asked) expect(o.offer.itsMe(r.id)).toBe(false);
    expect(o.offer.open()).toBe(true);
  });

  test("only the device that asked may wait on, take or refuse its request", async () => {
    const o = offering();
    const phone = idOf(newSeed());
    ask(o, phone);
    const { id } = o.asked[0]!;
    o.offer.itsMe(id);
    const other = idOf(newSeed());
    for (const connect of ["wait", "take", "refuse"]) expect(o.offer.answer(other, { v: 1, connect, request: id })).toEqual({ ok: false, error: "expired" });
    expect(o.settled).toEqual([]);
  });
});

describe("someone else", () => {
  const answer: GuestAnswer = {
    workspace: "0f".repeat(16), host: "1e".repeat(32), addrs: ["10.0.0.9:4433"], relay: null, role: "view",
    names: { workspace: "design", host: "Asha" }, hosting: null,
  };

  test("is let in where the app's admit says, and told where the workspace is; the others waiting are told the offer expired", async () => {
    const o = offering();
    const friend = device("app", "Ravi's laptop");
    const u = use(entering(friend, true), o);
    const phone = idOf(newSeed());
    ask(o, phone);
    await settle();
    const [request, waiting] = o.asked;
    const told = o.offer.answer(phone, { v: 1, connect: "wait", request: waiting!.id });

    let admitted = 0;
    expect(await o.offer.guest(request!.id, async () => (admitted++, answer))).toBe(true);
    expect(await u.done).toEqual({ as: "guest", guest: answer });
    expect(admitted).toBe(1);
    expect(await told).toEqual({ ok: false, error: "expired" });
    expect(o.gone).toEqual([waiting!.id]);
    expect(o.settled).toEqual([]);
    expect(o.offer.open()).toBe(false);
  });

  test("is no answer to a phone, which has no certificate", async () => {
    const o = offering();
    ask(o, idOf(newSeed()));
    let admitted = 0;
    expect(await o.offer.guest(o.asked[0]!.id, async () => (admitted++, answer))).toBe(false);
    expect(admitted).toBe(0);
    expect(o.offer.open()).toBe(true);
  });

  test("a device the workspace could not let in is told no", async () => {
    const o = offering();
    const u = use(entering(device("app", "Ravi's laptop")), o);
    await settle();
    await expect(o.offer.guest(o.asked[0]!.id, async () => { throw new Error("not the owner"); })).rejects.toThrow("not the owner");
    await expect(u.done).rejects.toThrow("did not let this one in");
  });
});

describe("what gives nothing", () => {
  test("no: the device is told so, nothing is kept, and the offer stays open for the next", async () => {
    const o = offering();
    const u = use(entering(device("app", "stranger")), o);
    await settle();
    const { id } = o.asked[0]!;
    o.offer.deny(id);
    await expect(u.done).rejects.toThrow(PairingFailed);
    await expect(u.done).rejects.toThrow("did not let this one in");
    expect(o.settled).toEqual([]);
    expect(o.offer.itsMe(id)).toBe(false);
    expect(o.offer.open()).toBe(true);
    expect(ask(o, idOf(newSeed()))).toMatchObject({ ok: true });
  });

  test("a wrong code counts against the offer, and the third voids it, telling those waiting", async () => {
    const o = offering();
    const phone = idOf(newSeed());
    ask(o, phone);
    const told = o.offer.answer(phone, { v: 1, connect: "wait", request: o.asked[0]!.id });
    const wrong = "acorn-actor-adobe-agent-alarm-album";
    for (let i = 0; i < CODE_TRIES; i++) expect(ask(o, idOf(newSeed()), {}, wrong)).toEqual({ ok: false, error: "wrong-code" });
    expect(await told).toEqual({ ok: false, error: "expired" });
    expect(ask(o, idOf(newSeed()))).toEqual({ ok: false, error: "expired" });
  });

  test(`a request beyond ${WAITING_AT_MOST} waiting is told busy, which costs no try; a wrong code then still counts`, () => {
    const o = offering();
    for (let i = 0; i < WAITING_AT_MOST; i++) expect(ask(o, idOf(newSeed()))).toMatchObject({ ok: true });
    for (let i = 0; i < CODE_TRIES; i++) expect(ask(o, idOf(newSeed()))).toEqual({ ok: false, error: "busy" });
    expect(o.asked).toHaveLength(WAITING_AT_MOST);
    for (let i = 0; i < CODE_TRIES; i++) expect(ask(o, idOf(newSeed()), {}, "acorn-actor-adobe-agent-alarm-album")).toEqual({ ok: false, error: "wrong-code" });
    expect(o.offer.open()).toBe(false);
  });

  test("a device asking again stands in for its earlier request", async () => {
    const o = offering();
    const phone = idOf(newSeed());
    for (let i = 0; i < WAITING_AT_MOST; i++) ask(o, phone);
    expect(o.offer.waiting().map((r) => r.id)).toEqual([o.asked.at(-1)!.id]);
    expect(o.gone).toEqual(o.asked.slice(0, -1).map((r) => r.id));
    expect(o.offer.itsMe(o.asked[0]!.id)).toBe(false);
  });

  test("an offer lasts a day, and one closed tells those waiting it expired", async () => {
    const at = Date.now();
    const late = offering();
    expect(late.offer.open(at + OFFER_TTL_MS - 60_000)).toBe(true);
    expect(late.offer.answer(idOf(newSeed()), { v: 1, connect: "ask" }, at + OFFER_TTL_MS + 1)).toEqual({ ok: false, error: "expired" });

    const o = offering();
    const phone = idOf(newSeed());
    ask(o, phone);
    const told = o.offer.answer(phone, { v: 1, connect: "wait", request: o.asked[0]!.id });
    o.offer.close();
    expect(await told).toEqual({ ok: false, error: "expired" });
    expect(o.offer.itsMe(o.asked[0]!.id)).toBe(false);
  });

  test("a certificate that does not name the device asking is refused", () => {
    const o = offering();
    const other = device("app", "other");
    expect(ask(o, idOf(newSeed()), { kind: "app", certificate: other.certificate })).toEqual({ ok: false, error: "not-this-device" });
    expect(o.asked).toEqual([]);
  });

  test("the device asking learns nothing from one that does not hold the code, nor takes a person that did not certify it", async () => {
    const o = offering();
    const laptop = device("app", "laptop");
    const forged = enterConnect({
      me: entering(laptop), code: o.offer.code, offering: o.me.device, words: () => {}, sure: async () => true,
      ask: async (hello) => ({ ...(o.offer.answer(laptop.device, hello) as object), proof: "00".repeat(32) }),
    });
    await expect(forged).rejects.toThrow("does not hold this code");

    const p = offering();
    const shown: string[][] = [];
    const swapped = enterConnect({
      me: entering(laptop), code: p.offer.code, offering: p.me.device, words: (w) => shown.push(w), sure: async () => true,
      ask: async (hello) => {
        const r = (await p.offer.answer(laptop.device, hello)) as Record<string, unknown>;
        return (hello as { connect: string }).connect === "take" ? { ...r, person: Buffer.from(newSeed()).toString("hex") } : r;
      },
    });
    await settle();
    p.offer.itsMe(p.asked[0]!.id);
    await expect(swapped).rejects.toThrow("did not understand");
  });
});
