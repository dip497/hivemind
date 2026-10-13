/**
 * Connecting (spec/pairing.md 0.10): an app offers one code, and whoever uses it only asks. The
 * person at the app answers each request: their own device (paired, as `pairing.ts` pairs), someone
 * else let into the workspace the offer was made from, or no. Each request has words of its own,
 * shown on both screens, so "it's me" is said of the device the person holds; that device takes the
 * person only once its own person says the words match too.
 *
 * `ConnectOffer` is the offering side and writes nothing: requests go to `asked`, the person's
 * answers come back through `itsMe`, `guest` and `deny`, and a pairing is handed to `settled`.
 * `enterConnect` is the entering side.
 */
import { createHmac, randomBytes } from "node:crypto";
import { profileOf, type ProfileSettings } from "@hivemind/core/settings-schema";
import { LINK_ROLES, type LinkRole } from "./access.js";
import { certificateVerifies, certifyDevice, idOf, type DeviceCertificate } from "./identity.js";
import {
  admissionOf, CODE_TRIES, isKey, isKind, nameOf, newCode, parseCode, PairingFailed, reachedOf, sameProof, seedOf,
  type Admission, type DeviceKind, type PairedKind, type Pairing, type PairingDevice, type Reached,
} from "./pairing.js";
import { PAIRING_WORDS } from "./pairing-words.js";

/** How long an offer may be used. */
export const OFFER_TTL_MS = 24 * 60 * 60_000;
/** Requests that may wait on the person at once; the next is told the offer is busy. */
export const WAITING_AT_MOST = 3;
/** How long a device told "it's me" may still take the person. */
export const TAKE_WITHIN_MS = 170_000;

const hexOf = (bytes: number) => randomBytes(bytes).toString("hex");
const isHex = (v: unknown, bytes: number): v is string => typeof v === "string" && new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(v);

/** A proof of holding `code`, good only between these two devices. */
export function connectProof(code: string, label: "entering" | "offering", offering: string, entering: string): string {
  return createHmac("sha256", code).update(`hive/connect/1 ${label}\n${offering}${entering}`).digest("hex");
}

/** The words both screens show for one request. */
export function connectWords(code: string, offering: string, entering: string, nonceO: string, nonceJ: string): string[] {
  const mac = createHmac("sha256", code).update(`hive/connect/1 words\n${offering}${entering}${nonceO}${nonceJ}`).digest();
  return [...mac.subarray(0, 3)].map((b) => PAIRING_WORDS[b]!);
}

export interface ConnectLink extends Reached {
  device: string;
  code: string;
  name: string;
  admission?: Admission;
}

const LINK = /^hivemind:\/\/connect\/([0-9a-f]{64})#([A-Za-z0-9_-]+)$/;

export function formatConnectLink(l: ConnectLink): string {
  const { device, ...rest } = l;
  return `hivemind://connect/${device}#${Buffer.from(JSON.stringify({ v: 1, ...rest })).toString("base64url")}`;
}

/** The offer `text` is a link to (or the phone page's address carrying one), or null. */
export function parseConnectLink(text: string): ConnectLink | null {
  const t = text.trim();
  const page = /^https?:\/\/[^#]*#(.*)$/s.exec(t);
  const m = LINK.exec(page ? (new URLSearchParams(page[1]).get("connect") ?? "").trim() : t);
  if (!m) return null;
  try {
    const l = JSON.parse(Buffer.from(m[2]!, "base64url").toString("utf8")) as Record<string, unknown>;
    const code = typeof l.code === "string" ? parseCode(l.code) : null;
    const name = nameOf(l.name);
    if (l.v !== 1 || !code || !name) return null;
    return { device: m[1]!, ...reachedOf(l), code, name, ...admissionOf(l.admission) };
  } catch {
    return null;
  }
}

/** A device asking to connect, as the person at the offering app is shown it. */
export interface ConnectRequest extends Reached {
  id: string;
  device: string;
  name: string;
  kind: PairedKind;
  /** None from a phone, which cannot be let in as someone else. */
  certificate: DeviceCertificate | null;
  profile: ProfileSettings | null;
  /** It shares workspaces as its own person, so cannot take this one. */
  shares: boolean;
  words: string[];
}

/** Where a device let in as someone else finds the workspace. */
export interface GuestAnswer extends Reached {
  workspace: string;
  host: string;
  role: LinkRole;
  names: { workspace: string; host: string };
  hosting: { key: string; lookup: string | null } | null;
}

export type ConnectError = "expired" | "wrong-code" | "malformed" | "not-this-device" | "busy" | "declined";

const fail = (error: ConnectError) => ({ ok: false as const, error });

interface Asked {
  peer: string;
  request: ConnectRequest;
  waiting: boolean;
  told: Promise<unknown>;
  tell(reply: unknown): void;
}

/**
 * One offer of this app's. `asked` is shown each request; `gone` is told of one that waits no more
 * and was not answered here (another was let in, its device asked again, the offer closed, or its
 * device said the words did not match); `settled` is told once, when a device took the person.
 */
export class ConnectOffer {
  readonly code = newCode();
  readonly expires: number;
  private tries = 0;
  private over = false;
  private readonly asked = new Map<string, Asked>();
  /** The request told "it's me", until it takes the person. */
  private chosen: { id: string; at: number } | null = null;

  constructor(
    private readonly me: PairingDevice & { profile: ProfileSettings },
    private readonly hooks: { asked(request: ConnectRequest): void; gone(id: string): void; settled(pairing: Pairing): void },
    now: number = Date.now(),
  ) {
    this.expires = now + OFFER_TTL_MS;
  }

  /** Whether the offer can still be used. */
  open(now: number = Date.now()): boolean {
    return !this.over && now < this.expires;
  }

  /** The requests waiting on the person. */
  waiting(): ConnectRequest[] {
    return [...this.asked.values()].filter((a) => a.waiting).map((a) => a.request);
  }

  /** The answer to `peer` (as its key proved it), which sent `hello`. */
  answer(peer: string, hello: unknown, now: number = Date.now()): unknown {
    const h = hello as Record<string, unknown> | null;
    if (!h || h.v !== 1) return fail("malformed");
    if (h.connect === "ask") return this.ask(peer, h, now);
    const a = typeof h.request === "string" ? this.asked.get(h.request) : undefined;
    if (!a || a.peer !== peer) return fail("expired");
    if (h.connect === "wait") return a.told;
    if (h.connect === "take") return this.take(a, now);
    if (h.connect === "refuse") return this.refuse(a);
    return fail("malformed");
  }

  /** The person says `id` is their own device. */
  itsMe(id: string, now: number = Date.now()): boolean {
    const a = this.decidable(id, now);
    if (!a || a.request.kind === "host" || a.request.shares) return false;
    this.spend(a);
    this.chosen = { id, at: now };
    a.tell({ ok: true, as: "me", profile: this.me.profile });
    return true;
  }

  /** The person lets `id` in as someone else: `admit` lets it into the workspace and says where it is. */
  async guest(id: string, admit: () => Promise<GuestAnswer>, now: number = Date.now()): Promise<boolean> {
    const a = this.decidable(id, now);
    if (!a?.request.certificate) return false;
    this.spend(a);
    try {
      a.tell({ ok: true, as: "guest", ...(await admit()) });
      return true;
    } catch (e) {
      a.tell(fail("declined"));
      throw e;
    }
  }

  /** The person says no to `id`, or did not answer. */
  deny(id: string): void {
    const a = this.asked.get(id);
    if (!a?.waiting) return;
    a.waiting = false;
    a.tell(fail("declined"));
  }

  /** Cancelled, or another offer made: every request still waiting is told it expired. */
  close(): void {
    this.over = true;
    this.chosen = null;
    for (const [id, a] of this.asked) this.drop(id, a);
  }

  /** A wrong proof counts against the code. */
  private wrong() {
    if (++this.tries >= CODE_TRIES) this.close();
    return fail("wrong-code");
  }

  private ask(peer: string, h: Record<string, unknown>, now: number) {
    if (!this.open(now)) return fail("expired");
    const me = this.me;
    if (!sameProof(h.proof, connectProof(this.code, "entering", me.device, peer))) return this.wrong();
    const name = nameOf(h.name);
    const kind = h.kind === "phone" || isKind(h.kind) ? h.kind : null;
    if (!name || !kind || !isHex(h.nonce, 16)) return fail("malformed");
    let certificate: DeviceCertificate | null = null;
    if (kind !== "phone") {
      if (!certificateVerifies(h.certificate)) return fail("malformed");
      if (h.certificate.device !== peer) return fail("not-this-device");
      certificate = h.certificate;
    }
    // A device asking again stands in for its own earlier request.
    for (const [id, a] of this.asked) if (a.peer === peer && a.waiting) this.drop(id, a);
    if (this.waiting().length >= WAITING_AT_MOST) return fail("busy");
    const nonce = hexOf(16);
    const request: ConnectRequest = {
      id: hexOf(8), device: peer, name, kind, certificate, profile: kind === "phone" ? null : profileOf(h.profile),
      shares: kind !== "phone" && h.shares === true, words: connectWords(this.code, me.device, peer, nonce, h.nonce), ...reachedOf(h),
    };
    let tell!: (reply: unknown) => void;
    const told = new Promise<unknown>((resolve) => (tell = resolve));
    this.asked.set(request.id, { peer, request, waiting: true, told, tell });
    this.hooks.asked(request);
    return {
      ok: true, request: request.id, proof: connectProof(this.code, "offering", me.device, peer), nonce,
      name: me.name, certificate: me.certificate, addrs: me.addrs, relay: me.relay,
    };
  }

  /** `id`, while it waits on an offer still open. */
  private decidable(id: string, now: number): Asked | null {
    const a = this.asked.get(id);
    return a?.waiting && this.open(now) ? a : null;
  }

  /** `a` is let in: the offer is used, and every other request waiting is told so. */
  private spend(a: Asked): void {
    this.over = true;
    a.waiting = false;
    for (const [id, other] of this.asked) if (other !== a) this.drop(id, other);
  }

  private drop(id: string, a: Asked): void {
    this.asked.delete(id);
    a.tell(fail("expired"));
    this.hooks.gone(id);
  }

  private take(a: Asked, now: number) {
    const chosen = this.chosen;
    if (!chosen || chosen.id !== a.request.id || now > chosen.at + TAKE_WITHIN_MS) return fail("expired");
    this.chosen = null;
    this.asked.delete(chosen.id);
    const { request } = a;
    const me = this.me;
    const reached = { addrs: request.addrs, relay: request.relay };
    if (request.kind === "phone") {
      // A phone is given a certificate naming it, signed by the person key, and never the key.
      const yours = certifyDevice(me.person, request.device);
      this.hooks.settled({ with: { device: request.device, name: request.name, kind: "phone", certificate: yours, ...reached }, person: null });
      return { ok: true, yours, ...(me.network ? { network: me.network } : {}) };
    }
    this.hooks.settled({ with: { device: request.device, name: request.name, kind: request.kind, certificate: certifyDevice(me.person, request.device), ...reached }, person: null });
    return { ok: true, person: Buffer.from(me.person).toString("hex") };
  }

  private refuse(a: Asked) {
    if (this.chosen?.id !== a.request.id) return fail("expired");
    this.chosen = null;
    this.asked.delete(a.request.id);
    this.hooks.gone(a.request.id);
    return { ok: true };
  }
}

const MESSAGES: Record<string, string> = {
  expired: "that offer has expired, or was used: ask for a new one",
  "wrong-code": "the other computer has a different code: check the words",
  "not-this-device": "the other computer refused this one's certificate",
  busy: "the other computer has requests waiting already: try again in a few minutes",
  declined: "the other computer did not let this one in",
  malformed: "the other computer did not understand this one",
};

const failed = (reply: Record<string, unknown> | null) => new PairingFailed(MESSAGES[String(reply?.error)] ?? `the other computer refused: ${String(reply?.error)}`);

/** This device, as connecting needs it. */
export interface Entering extends Reached {
  device: string;
  name: string;
  kind: DeviceKind;
  certificate: DeviceCertificate;
  profile: ProfileSettings;
  shares?: boolean;
}

export type Connected = { as: "me"; pairing: Pairing } | { as: "guest"; guest: GuestAnswer };

/** A guest answer as the spec has it, or null. */
function guestOf(r: Record<string, unknown>): GuestAnswer | null {
  const names = (r.names ?? {}) as Record<string, unknown>;
  const hosting = r.hosting as Record<string, unknown> | null | undefined;
  if (!isHex(r.workspace, 16) || !isKey(r.host) || !LINK_ROLES.includes(r.role as LinkRole)) return null;
  return {
    workspace: r.workspace, host: r.host, role: r.role as LinkRole, ...reachedOf(r),
    names: { workspace: typeof names.workspace === "string" ? names.workspace.slice(0, 200) : "", host: typeof names.host === "string" ? names.host.slice(0, 64) : "" },
    hosting: hosting && isHex(hosting.key, 32) ? { key: hosting.key, lookup: typeof hosting.lookup === "string" && /^https?:\/\//.test(hosting.lookup) ? hosting.lookup : null } : null,
  };
}

/**
 * Use the offer of `code` made by the device `offering`: ask, show `words`, wait for the person
 * there, and, told it is theirs, take the person once `sure` (this device's person, shown the
 * words and whose computer says so) agrees. `ask` sends one request to that device and resolves
 * with its answer.
 */
export async function enterConnect(o: {
  me: Entering;
  code: string;
  offering: string;
  ask(hello: unknown): Promise<unknown>;
  words(words: string[]): void;
  sure(profile: ProfileSettings): Promise<boolean>;
}): Promise<Connected> {
  const { me, code, offering } = o;
  const nonce = hexOf(16);
  const asked = (await o.ask({
    v: 1, connect: "ask", proof: connectProof(code, "entering", offering, me.device), nonce, name: me.name, kind: me.kind,
    certificate: me.certificate, profile: me.profile, addrs: me.addrs, relay: me.relay, ...(me.shares ? { shares: true } : {}),
  })) as Record<string, unknown> | null;
  if (!asked?.ok) throw failed(asked);
  if (!sameProof(asked.proof, connectProof(code, "offering", offering, me.device))) throw new PairingFailed("the other computer does not hold this code");
  const name = nameOf(asked.name);
  const cert = asked.certificate;
  if (!name || !isHex(asked.request, 8) || !isHex(asked.nonce, 16) || !certificateVerifies(cert) || cert.device !== offering) throw failed({ error: "malformed" });
  o.words(connectWords(code, offering, me.device, asked.nonce, nonce));

  const told = (await o.ask({ v: 1, connect: "wait", request: asked.request })) as Record<string, unknown> | null;
  if (!told?.ok) throw failed(told);
  if (told.as === "guest") {
    const guest = guestOf(told);
    if (!guest) throw failed({ error: "malformed" });
    return { as: "guest", guest };
  }
  if (told.as !== "me") throw failed({ error: "malformed" });
  if (!(await o.sure(profileOf(told.profile)))) {
    await o.ask({ v: 1, connect: "refuse", request: asked.request });
    throw new PairingFailed("the words did not match: nothing was taken");
  }
  const taken = (await o.ask({ v: 1, connect: "take", request: asked.request })) as Record<string, unknown> | null;
  if (!taken?.ok) throw failed(taken);
  // The person given must be the one that certified the offering computer.
  const person = seedOf(taken.person);
  if (!person || idOf(person) !== cert.person) throw failed({ error: "malformed" });
  return { as: "me", pairing: { with: { device: offering, name, kind: "app", certificate: cert, ...reachedOf(asked) }, person } };
}
