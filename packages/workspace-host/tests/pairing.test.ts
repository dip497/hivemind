// Pairing two devices of one person (pairing.ts, spec/pairing.md): whichever of an app and a host
// shows the code, the host ends up holding the app's person and each keeps a certificate for the
// other that names it; the person goes only to a device that proved it holds the code, and a proof
// is good only between the two devices it was made for; wrong proofs void the code; two devices of
// one kind do not pair. Here the channel `hive/pair/1` gives is the call to the offering device with
// the entering device's key as the peer, which is what hive-net vouches for.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { certificateVerifies, certifyDevice, idOf, newSeed, type Seed } from "../src/identity.ts";
import {
  CODE_TRIES, PairingFailed, PairingOffer, enterPairing, formatPairLink, newCode, offeringNearby, pairAnnouncement, pairProof, pairTag,
  parseCode, parsePairLink, type DeviceKind, type Pairing, type PairingDevice,
} from "../src/pairing.ts";
import { PAIRING_WORDS } from "../src/pairing-words.ts";

function device(kind: DeviceKind, name: string, person: Seed = newSeed()): PairingDevice {
  const key = newSeed();
  return { device: idOf(key), name, kind, person, certificate: certifyDevice(person, idOf(key)), addrs: [`10.0.0.${name.length}:4433`], relay: null };
}
/** An offer from `offering`, and what it settled with. */
function offered(offering: PairingDevice) {
  const settled: Pairing[] = [];
  return { offer: new PairingOffer(offering, (p) => settled.push(p)), settled };
}
/** `entering` entering `offer`'s code, over the pair channel. */
const enter = (entering: PairingDevice, offering: PairingDevice, offer: PairingOffer, code = offer.code) =>
  enterPairing({ me: entering, code, offering: offering.device, ask: async (hello) => offer.answer(entering.device, hello) });

describe("a host and an app pair", () => {
  test("the host offers, the app enters: the host takes the app's person, and each is certified to the other by it", async () => {
    const app = device("app", "Adarsh's laptop");
    const host = device("host", "home-server");
    const { offer, settled } = offered(host);
    const atApp = await enter(app, host, offer);

    expect(atApp.person).toBeNull();
    expect(atApp.with).toMatchObject({ device: host.device, name: "home-server", kind: "host", addrs: host.addrs, relay: null });
    expect(certificateVerifies(atApp.with.certificate)).toBe(true);
    expect(atApp.with.certificate).toMatchObject({ person: idOf(app.person), device: host.device });

    expect(settled).toHaveLength(1);
    expect(settled[0]!.person).toEqual(app.person);
    expect(settled[0]!.with).toMatchObject({ device: app.device, name: "Adarsh's laptop", kind: "app", certificate: app.certificate, addrs: app.addrs });
    // Used: the code lets nobody else in.
    expect(offer.answer(device("app", "another").device, { v: 1, pair: "prove" })).toEqual({ ok: false, error: "expired" });
  });

  test("the app offers, the host enters: the host takes the person with the app's answer", async () => {
    const app = device("app", "Adarsh's laptop");
    const host = device("host", "home-server");
    const { offer, settled } = offered(app);
    const atHost = await enter(host, app, offer);

    expect(atHost.person).toEqual(app.person);
    expect(atHost.with).toMatchObject({ device: app.device, kind: "app", certificate: app.certificate, addrs: app.addrs });
    expect(settled).toHaveLength(1);
    expect(settled[0]!.person).toBeNull();
    expect(settled[0]!.with).toMatchObject({ device: host.device, addrs: host.addrs });
    expect(settled[0]!.with.certificate).toMatchObject({ person: idOf(app.person), device: host.device });
    expect(certificateVerifies(settled[0]!.with.certificate)).toBe(true);
  });
});

describe("the person goes only to a device that holds the code", () => {
  test("an app that enters a code the other device does not hold gives nothing", async () => {
    const app = device("app", "laptop");
    const host = device("host", "server");
    const { offer } = offered(host);
    const sent: unknown[] = [];
    // The device answering proves a code other than the one entered.
    const failed = await enterPairing({
      me: app, code: newCode(), offering: host.device,
      ask: async (hello) => { sent.push(hello); return offer.answer(app.device, hello); },
    }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(PairingFailed);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain(Buffer.from(app.person).toString("hex"));
  });

  test("an app gives nothing to a device that says yes without proving it holds the code", async () => {
    const app = device("app", "laptop");
    const impostor = device("host", "impostor");
    const sent: unknown[] = [];
    const failed = await enterPairing({
      me: app, code: newCode(), offering: impostor.device,
      ask: async (hello) => {
        sent.push(hello);
        return { ok: true, proof: "0".repeat(64), name: "impostor", kind: "host", certificate: impostor.certificate };
      },
    }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(PairingFailed);
    expect(sent.some((h) => (h as { pair?: string }).pair === "give")).toBe(false);
  });

  test("a proof made for one device is refused from another", async () => {
    const host = device("host", "server");
    const app = device("app", "laptop");
    const thief = device("app", "thief");
    const { offer, settled } = offered(host);
    const proof = pairProof(offer.code, "entering", host.device, app.device);
    expect(offer.answer(thief.device, { v: 1, pair: "prove", proof, name: "thief", kind: "app", certificate: thief.certificate }))
      .toEqual({ ok: false, error: "wrong-code" });
    expect(settled).toHaveLength(0);
  });

  test("the person handed over must be the one that certified the giver, either way round", async () => {
    // The app gives a person other than its certificate's.
    const host = device("host", "server");
    const app = device("app", "laptop");
    const { offer, settled } = offered(host);
    await expect(enter({ ...app, person: newSeed() }, host, offer)).rejects.toThrow(/did not understand/);
    expect(settled).toHaveLength(0);
    // The app answering the host gives a person other than its certificate's.
    const giver = device("app", "laptop");
    const { offer: theirs } = offered({ ...giver, person: newSeed() });
    await expect(enter(device("host", "server"), giver, theirs)).rejects.toThrow(/did not understand/);
  });

  test(`a code takes ${CODE_TRIES} wrong proofs, then lets nobody in`, async () => {
    const host = device("host", "server");
    const app = device("app", "laptop");
    const { offer, settled } = offered(host);
    for (let i = 0; i < CODE_TRIES; i++) {
      await expect(enter(app, host, offer, newCode())).rejects.toThrow(/different code/);
    }
    await expect(enter(app, host, offer)).rejects.toThrow(/expired/);
    expect(settled).toHaveLength(0);
  });

  test("a code expires", () => {
    const host = device("host", "server");
    const app = device("app", "laptop");
    const offer = new PairingOffer(host, () => {}, 0);
    const proof = pairProof(offer.code, "entering", host.device, app.device);
    expect(offer.answer(app.device, { v: 1, pair: "prove", proof, name: "laptop", kind: "app", certificate: app.certificate }, offer.expires))
      .toEqual({ ok: false, error: "expired" });
  });

  test("a certificate must name the device that connected, and two of a kind do not pair", async () => {
    const host = device("host", "server");
    const other = device("app", "other");
    const { offer } = offered(host);
    // The app shows another device's certificate.
    const app = { ...device("app", "laptop"), certificate: other.certificate };
    await expect(enter(app, host, offer)).rejects.toThrow(/refused this one's certificate/);
    const { offer: second } = offered(host);
    await expect(enter(device("host", "another host"), host, second)).rejects.toThrow(/an app with a host/);
  });
});

describe("codes and links", () => {
  test("a code is six of the words, entered in any case and with spaces or hyphens", () => {
    const code = newCode();
    expect(code.split("-")).toHaveLength(6);
    expect(code.split("-").every((w) => PAIRING_WORDS.includes(w))).toBe(true);
    expect(parseCode(` ${code.split("-").join("  ").toUpperCase()} `)).toBe(code);
    expect(parseCode("acorn actor adobe agent alarm")).toBeNull();
    expect(parseCode("acorn actor adobe agent alarm zzz")).toBeNull();
  });

  test("a link carries the code and where the device is; anything else is not a link", () => {
    const host = device("host", "server");
    const code = newCode();
    const link = formatPairLink({ device: host.device, addrs: ["192.168.1.5:4433"], relay: null, code, name: "server", kind: "host" });
    expect(parsePairLink(link)).toEqual({ device: host.device, addrs: ["192.168.1.5:4433"], relay: null, code, name: "server", kind: "host" });
    expect(parsePairLink(link.replace("hivemind://pair/", "hivemind://network/"))).toBeNull();
    expect(parsePairLink(`hivemind://pair/${Buffer.from(JSON.stringify({ v: 1, device: host.device, code: "not words", name: "x", kind: "host" })).toString("base64url")}`)).toBeNull();
  });

  test("the tag announced for a code is the spec's: SHA-256 of its label and the code, four bytes", () => {
    // spec/pairing.md, "Finding the offering device from the words alone".
    expect(pairTag("acorn-actor-adobe-agent-alarm-album")).toBe("ef49cd5e");
  });

  test("from the words alone, the device nearby announcing the code is the one; none is not found, and two are refused", async () => {
    const code = newCode();
    const someoneElse = { id: "a".repeat(64), data: pairAnnouncement(newCode()) };
    const quiet = { id: "b".repeat(64), data: null };
    const offering = { id: "c".repeat(64), data: pairAnnouncement(code) };
    expect(await offeringNearby(code, async () => [someoneElse, quiet, offering], 0)).toBe(offering.id);
    // It may take a moment to be seen.
    let asked = 0;
    expect(await offeringNearby(code, async () => (++asked < 3 ? [quiet] : [quiet, offering]), 5_000)).toBe(offering.id);
    await expect(offeringNearby(code, async () => [someoneElse, quiet], 0)).rejects.toThrow(/no device on this network offers that code/);
    await expect(offeringNearby(code, async () => [offering, { id: "d".repeat(64), data: offering.data }], 0)).rejects.toThrow(/two devices/);
  });

  test("the words are the spec's list: 256 of them, no two alike in their first four letters", () => {
    const spec = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../../../spec/pairing-words.json"), "utf8")) as string[];
    expect([...PAIRING_WORDS]).toEqual(spec);
    expect(new Set(PAIRING_WORDS.map((w) => w.slice(0, 4))).size).toBe(256);
  });
});
