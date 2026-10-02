/**
 * Pairing two devices of one person (spec/pairing.md; design §5.2, R14, M3): one device gives the
 * person key it holds and the other takes it, so both are that person. An app gives to a host; of
 * two apps, the one entering the code is the device being added, and takes; two hosts do not pair.
 * A phone (0.3) enters an app's code and is given a certificate naming it, never the person key.
 * A device that shares workspaces with others, either way, never takes. One device offers a code
 * (six words, or a link carrying them and where the device is); the other enters it and dials. Over
 * `hive/pair/1` each proves it holds the code, bound to the two devices' keys, before anything is
 * handed over: a device that only copied what was announced learns nothing it can use.
 *
 * `PairingOffer` is the offering side, answering what the entering device sends; `enterPairing` is
 * the entering side. Neither writes anything: what a pairing gives (the other device, and the
 * person when this device takes it) is handed back to be kept.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { certificateVerifies, certifyDevice, idOf, type DeviceCertificate, type Seed } from "./identity.js";
import { PAIRING_WORDS } from "./pairing-words.js";

/** An app (someone's own computer), which gives its person; a host, which takes one. */
export type DeviceKind = "app" | "host";
/** A device paired with: an app, a host, or a phone (0.3), which an app certifies and never gives
 *  the person key; a phone runs nothing and only enters a code. */
export type PairedKind = DeviceKind | "phone";

/** Where a device is reached: its direct addresses, and the relay it is on. */
export interface Reached {
  addrs: string[];
  relay: string | null;
}

/** This device, as pairing needs it. */
export interface PairingDevice extends Reached {
  device: string;
  name: string;
  kind: DeviceKind;
  certificate: DeviceCertificate;
  /** The person key it holds: given away, or replaced when this device takes another. */
  person: Seed;
  /** People know it as its person: it let someone into a workspace of its own, or was let into
   *  someone else's. It must not take another. */
  shares?: boolean;
  /** The network it is on, which a phone pairing with it takes (spec/pairing.md 0.5): a built-in's
   *  name or a signed profile, as `network-profile.md` has it; none on the local network. */
  network?: string;
}

/** The other device, once paired. */
export interface PairedWith extends Reached {
  device: string;
  name: string;
  kind: PairedKind;
  /** A certificate that names the other device as the person's. */
  certificate: DeviceCertificate;
}

/** What a pairing gave: the other device, and the person key when this device took it. */
export interface Pairing {
  with: PairedWith;
  person: Seed | null;
}

export const CODE_WORDS = 6;
/** How long a code may be entered. */
export const CODE_TTL_MS = 5 * 60_000;
/** Wrong proofs a code survives; the next one voids it. */
export const CODE_TRIES = 3;

export type PairError = "expired" | "wrong-code" | "malformed" | "not-this-device" | "same-kind" | "shares";

/** A new code: six words, one per random byte. */
export function newCode(): string {
  return [...randomBytes(CODE_WORDS)].map((b) => PAIRING_WORDS[b]).join("-");
}

/** The code in `text` — its words in order, separated by spaces or hyphens, in any case — or null
 *  when it is not one. */
export function parseCode(text: string): string | null {
  const words = text.trim().toLowerCase().split(/[\s-]+/).filter(Boolean);
  if (words.length !== CODE_WORDS || !words.every((w) => PAIRING_WORDS.includes(w))) return null;
  return words.join("-");
}

/** The tag of `code`, which its device announces on the local network while it is open. */
export function pairTag(code: string): string {
  return createHash("sha256").update(`hive/pair-tag/1\n${code}`).digest("hex").slice(0, 8);
}

/** What the offering device announces (its mDNS user data) while `code` is open. */
export const pairAnnouncement = (code: string): string => `hive-pair=${pairTag(code)}`;

/** How long the devices nearby are looked through for the one offering a code. */
export const FIND_WITHIN_MS = 10_000;

/**
 * The device on this network offering `code`, from the words alone: the one announcing its tag
 * among the devices `nearby` (hive-net's mDNS) finds, looked for until `withinMs`. None is "not
 * found on this network"; two are refused, since a device that copied the announcement would be
 * one of them.
 */
export async function offeringNearby(code: string, nearby: () => Promise<Array<{ id: string; data: string | null }>>, withinMs = FIND_WITHIN_MS): Promise<string> {
  const announced = pairAnnouncement(code);
  for (const end = Date.now() + withinMs; ; await new Promise((r) => setTimeout(r, 250))) {
    const offering = (await nearby()).filter((d) => d.data === announced);
    if (offering.length > 1) throw new PairingFailed("two devices on this network offer that code: ask for a new one");
    if (offering.length === 1) return offering[0]!.id;
    if (Date.now() >= end) throw new PairingFailed("no device on this network offers that code: check the words, or enter the link");
  }
}

type Label = "entering" | "offering" | "give";

/** A proof of holding `code`, good only between these two devices. */
export function pairProof(code: string, label: Label, offering: string, entering: string): string {
  return createHmac("sha256", code).update(`hive/pair/1 ${label}\n${offering}${entering}`).digest("hex");
}

function sameProof(given: unknown, expected: string): boolean {
  if (typeof given !== "string" || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** A code and where its device is, as one link. */
export interface PairLink {
  device: string;
  addrs: string[];
  relay: string | null;
  code: string;
  name: string;
  kind: DeviceKind;
}

const LINK_PREFIX = "hivemind://pair/";

export function formatPairLink(l: PairLink): string {
  return LINK_PREFIX + Buffer.from(JSON.stringify({ v: 1, ...l })).toString("base64url");
}

const isKey = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
/** Where a message says its device is reached: a few addresses, and a relay or none. */
const reachedOf = (m: Record<string, unknown>): Reached => ({
  addrs: Array.isArray(m.addrs) ? m.addrs.filter((a): a is string => typeof a === "string" && a.length <= 100).slice(0, 16) : [],
  relay: typeof m.relay === "string" && m.relay.length <= 500 ? m.relay : null,
});
const isKind = (v: unknown): v is DeviceKind => v === "app" || v === "host";
const isPairedKind = (v: unknown): v is PairedKind => isKind(v) || v === "phone";
/** A device's name, as another will list it: text, not too long. */
const nameOf = (v: unknown): string | null => (typeof v === "string" && v.trim() && v.length <= 200 ? v.trim() : null);

/** The link in `text`, or null when it is not a pairing link. */
export function parsePairLink(text: string): PairLink | null {
  const t = text.trim();
  if (!t.startsWith(LINK_PREFIX)) return null;
  try {
    const l = JSON.parse(Buffer.from(t.slice(LINK_PREFIX.length), "base64url").toString("utf8")) as Record<string, unknown>;
    const code = typeof l.code === "string" ? parseCode(l.code) : null;
    const name = nameOf(l.name);
    if (l.v !== 1 || !isKey(l.device) || !code || !name || !isKind(l.kind)) return null;
    return { device: l.device, ...reachedOf(l), code, name, kind: l.kind };
  } catch {
    return null;
  }
}

/** The person key in hex, or null. */
const seedOf = (v: unknown): Seed | null => (typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? new Uint8Array(Buffer.from(v, "hex")) : null);
const hex = (seed: Seed): string => Buffer.from(seed).toString("hex");
const fail = (error: PairError) => ({ ok: false as const, error });

/**
 * A code this device offers, answering the device that enters it. `settled` is told once, when
 * the pairing is done; a code that expires or is voided tells nobody.
 */
export class PairingOffer {
  readonly code = newCode();
  readonly expires: number;
  private tries = 0;
  private over = false;
  /** The entering device, once it proved itself, when it is the giver still to give. */
  private proven: PairedWith | null = null;

  constructor(private readonly me: PairingDevice, private readonly settled: (pairing: Pairing) => void, now: number = Date.now()) {
    this.expires = now + CODE_TTL_MS;
  }

  /** Whether the code can still be entered. */
  open(now: number = Date.now()): boolean {
    return !this.over && now < this.expires;
  }

  /** The answer to the entering device `peer` (as its key proved it), which sent `hello`. */
  answer(peer: string, hello: unknown, now: number = Date.now()): unknown {
    if (!this.open(now)) return fail("expired");
    const h = hello as Record<string, unknown> | null;
    if (!h || h.v !== 1) return fail("malformed");
    if (h.pair === "prove") return this.prove(peer, h);
    if (h.pair === "give") return this.give(peer, h);
    return fail("malformed");
  }

  /** A wrong proof counts against the code. */
  private wrong(): { ok: false; error: PairError } {
    if (++this.tries >= CODE_TRIES) this.over = true;
    return fail("wrong-code");
  }

  private prove(peer: string, h: Record<string, unknown>) {
    const me = this.me;
    if (!sameProof(h.proof, pairProof(this.code, "entering", me.device, peer))) return this.wrong();
    const name = nameOf(h.name);
    if (!name || !isPairedKind(h.kind)) return fail("malformed");
    // Only an app gives: a host pairs with an app alone.
    if (me.kind === "host" && h.kind !== "app") return fail("same-kind");
    const proof = pairProof(this.code, "offering", me.device, peer);
    const mine = { ok: true, proof, name: me.name, kind: me.kind, certificate: me.certificate, addrs: me.addrs, relay: me.relay };
    if (h.kind === "phone") {
      // A phone is given a certificate naming it, signed by the person key, and never the key.
      const yours = certifyDevice(me.person, peer);
      this.over = true;
      this.settled({ with: { device: peer, name, kind: "phone", certificate: yours, ...reachedOf(h) }, person: null });
      // And the network this app is on, which the phone reaches the person's devices through.
      return { ...mine, yours, ...(me.network ? { network: me.network } : {}) };
    }
    if (!certificateVerifies(h.certificate)) return fail("malformed");
    if (h.certificate.device !== peer) return fail("not-this-device");
    if (me.kind === "app") {
      // The entering device would take this person, and cannot: those it shares with know it as another.
      if (h.shares === true) return fail("shares");
      // This device gives: the person goes with the answer, to the device that proved it holds the code.
      this.over = true;
      this.settled({ with: { device: peer, name, kind: h.kind, certificate: certifyDevice(me.person, peer), ...reachedOf(h) }, person: null });
      return { ...mine, person: hex(me.person) };
    }
    this.proven = { device: peer, name, kind: h.kind, certificate: h.certificate, ...reachedOf(h) };
    return mine;
  }

  private give(peer: string, h: Record<string, unknown>) {
    const giver = this.proven;
    if (!giver || giver.device !== peer) return fail("malformed");
    if (!sameProof(h.proof, pairProof(this.code, "give", this.me.device, peer))) return this.wrong();
    const person = seedOf(h.person);
    // The person given is the one whose certificate the giver showed.
    if (!person || idOf(person) !== giver.certificate.person) return fail("malformed");
    this.over = true;
    this.settled({ with: giver, person });
    return { ok: true };
  }
}

/** Why pairing did not happen, as the entering device's person is told. */
export class PairingFailed extends Error {}

const MESSAGES: Record<string, string> = {
  expired: "that code has expired, or was used: ask the other device for a new one",
  "wrong-code": "the other device has a different code: check the words",
  "not-this-device": "the other device refused this one's certificate",
  "same-kind": "both devices are hosts: pair a host with an app",
  shares: "this computer shares workspaces as the person it is now: show a code here, and enter it on the other device instead",
  malformed: "the other device did not understand this one",
};

/**
 * Enter `code`, offered by the device `offering`: prove to it, check its proof, and hand over or
 * take the person. `ask` sends one `pair` request to that device and resolves with its answer.
 */
export async function enterPairing(o: { me: PairingDevice; code: string; offering: string; ask(hello: unknown): Promise<unknown> }): Promise<Pairing> {
  const { me, code, offering } = o;
  const reply = (await o.ask({
    v: 1, pair: "prove", proof: pairProof(code, "entering", offering, me.device), name: me.name, kind: me.kind, certificate: me.certificate,
    addrs: me.addrs, relay: me.relay, ...(me.shares ? { shares: true } : {}),
  })) as Record<string, unknown> | null;
  if (!reply?.ok) throw new PairingFailed(MESSAGES[String(reply?.error)] ?? `the other device refused: ${String(reply?.error)}`);
  if (!sameProof(reply.proof, pairProof(code, "offering", offering, me.device))) throw new PairingFailed("the other device does not hold this code");
  const name = nameOf(reply.name);
  const cert = reply.certificate;
  if (!name || !isKind(reply.kind) || (reply.kind === "host" && me.kind === "host") || !certificateVerifies(cert) || cert.device !== offering) {
    throw new PairingFailed(MESSAGES.malformed);
  }
  if (me.kind === "host" || reply.kind === "app") {
    // This device takes (a host does; an app does when it enters another app's code): the person
    // given must be the one that certified the giver.
    const person = seedOf(reply.person);
    if (!person || idOf(person) !== cert.person) throw new PairingFailed(MESSAGES.malformed);
    return { with: { device: offering, name, kind: reply.kind, certificate: cert, ...reachedOf(reply) }, person };
  }
  const given = (await o.ask({ v: 1, pair: "give", proof: pairProof(code, "give", offering, me.device), person: hex(me.person) })) as Record<string, unknown> | null;
  if (!given?.ok) throw new PairingFailed(MESSAGES[String(given?.error)] ?? `the other device refused: ${String(given?.error)}`);
  return { with: { device: offering, name, kind: reply.kind, certificate: certifyDevice(me.person, offering), ...reachedOf(reply) }, person: null };
}
