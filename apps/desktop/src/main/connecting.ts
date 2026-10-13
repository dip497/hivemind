/**
 * Connect (spec/pairing.md 0.10, docs/design/connect-2026-10-13.md): the one offer this app makes,
 * the requests made with it as the windows show them, and the person's answers. A request nobody
 * answers within ANSWER_WITHIN_MS is no. It's me pairs the device once it took the person there;
 * someone else is let into the workspace of the window the offer was made in, by that workspace's
 * host. A new offer voids the last.
 */
import type { LinkRole } from "@hivemind/workspace-host/access";
import { ConnectOffer, TAKE_WITHIN_MS, formatConnectLink, type ConnectLink, type ConnectRequest, type GuestAnswer } from "@hivemind/workspace-host/connect";
import { pairTag, type Admission, type Pairing, type PairingDevice } from "@hivemind/workspace-host/pairing";
import { ANSWER_WITHIN_MS } from "@hivemind/host/people";
import type { ProfileSettings } from "@hivemind/core/settings-schema";
import type { ConnectAnswer, ConnectState } from "../shared/ipc.js";


/** What a device on this network finds the offer of a code by, from its words alone. */
export const connectAnnouncement = (code: string): string => `hive-connect=${pairTag(code)}`;

export interface ConnectingOptions {
  /** This app, as connecting needs it. */
  me(): Promise<PairingDevice & { profile: ProfileSettings }>;
  /** Announce `data` on this network (none: stop). */
  announce(data: string | null): void;
  /** How a device elsewhere gets onto this network for `seconds`; none on the local one. */
  admission(seconds: number): Promise<Admission | undefined>;
  /** Let `request`'s device into the workspace `repo` at `role`, where it is hosted. */
  admit(repo: string, request: ConnectRequest, role: LinkRole): Promise<GuestAnswer>;
  /** A device took the person here: keep it as one of theirs. */
  kept(pairing: Pairing): void;
  /** What the windows show changed. */
  changed(state: ConnectState): void;
}

interface Current {
  offer: ConnectOffer;
  shown: { code: string; link: string; expires: number };
  /** The workspace of the window it was made in; none from Home. */
  repo: string | null;
  asking: Map<string, { request: ConnectRequest; confirming: boolean; timer: NodeJS.Timeout }>;
  ends: NodeJS.Timeout;
}

export class Connecting {
  private current: Current | null = null;
  private last: ConnectState["last"] = null;

  constructor(private readonly o: ConnectingOptions) {}

  /** A new offer, made in the window showing `repo` (none: Home). */
  async offer(repo: string | null): Promise<NonNullable<ConnectState["offer"]>> {
    this.cancel();
    const me = await this.o.me();
    const offer: ConnectOffer = new ConnectOffer(me, {
      asked: (request) => this.asked(offer, request),
      gone: (id) => this.gone(offer, id, true),
      settled: (pairing) => this.settled(offer, pairing),
    });
    const admission = await this.o.admission((offer.expires - Date.now()) / 1000);
    const link: ConnectLink = { device: me.device, addrs: me.addrs, relay: me.relay, code: offer.code, name: me.name, ...(admission ? { admission } : {}) };
    const shown = { code: offer.code, link: formatConnectLink(link), expires: offer.expires };
    const ends = setTimeout(() => { if (this.current?.offer === offer) this.cancel(); }, offer.expires - Date.now());
    ends.unref?.();
    this.current = { offer, shown, repo, asking: new Map(), ends };
    this.last = null;
    this.o.announce(connectAnnouncement(offer.code));
    this.tell();
    return shown;
  }

  /** Void the offer: every request still waiting is told it expired. */
  cancel(): void {
    const c = this.current;
    if (!c) return;
    this.current = null;
    clearTimeout(c.ends);
    for (const a of c.asking.values()) clearTimeout(a.timer);
    c.offer.close();
    this.o.announce(null);
    this.tell();
  }

  /** The answer to `peer`, which sent `hello` with this app's offer. */
  answer(peer: string, hello: unknown): unknown {
    return this.current ? this.current.offer.answer(peer, hello) : { ok: false, error: "expired" };
  }

  state(): ConnectState {
    const c = this.current;
    const requests = c ? [...c.asking.values()].map(({ request: r, confirming }) => ({
      id: r.id, name: r.name, kind: r.kind, profile: r.profile, words: r.words, confirming,
      me: r.kind !== "host" && !r.shares, guest: !!r.certificate && c.repo !== null,
    })) : [];
    return { offer: c?.offer.open() ? c.shown : null, requests, last: this.last };
  }

  /** The person answers the request `id`. */
  async decide(id: string, answer: ConnectAnswer): Promise<void> {
    const c = this.current;
    const a = c?.asking.get(id);
    if (!c || !a || a.confirming) throw new Error("connect: that request waits no more");
    if (answer.as === "no") {
      c.offer.deny(id);
      this.gone(c.offer, id, false);
      return;
    }
    if (answer.as === "me") {
      if (!c.offer.itsMe(id)) throw new Error("connect: that device cannot be yours this way");
      this.o.announce(null);
      // Its own person says whether the words match there; it may take the person until then.
      clearTimeout(a.timer);
      a.confirming = true;
      a.timer = setTimeout(() => this.gone(c.offer, id, false), TAKE_WITHIN_MS);
      a.timer.unref?.();
      this.tell();
      return;
    }
    const repo = c.repo;
    if (!repo) throw new Error("connect: an offer made from Home lets nobody into a workspace");
    let admitted: boolean;
    try {
      admitted = await c.offer.guest(id, () => this.o.admit(repo, a.request, answer.role));
    } catch (e) {
      // The offer was used on it: it is over, whatever the host said.
      this.done(c, null);
      throw e;
    }
    if (!admitted) throw new Error("connect: that device cannot be let in as someone else");
    this.done(c, { name: a.request.name, as: "guest" });
  }

  private asked(offer: ConnectOffer, request: ConnectRequest): void {
    const c = this.current;
    if (c?.offer !== offer) return;
    const timer = setTimeout(() => { offer.deny(request.id); this.gone(offer, request.id, false); }, ANSWER_WITHIN_MS);
    timer.unref?.();
    c.asking.set(request.id, { request, confirming: false, timer });
    this.tell();
  }

  /** `id` waits no more; `byIt`, when it was told it's me, says its person said no there. */
  private gone(offer: ConnectOffer, id: string, byIt: boolean): void {
    const c = this.current;
    const a = c?.offer === offer ? c.asking.get(id) : undefined;
    if (!c || !a) return;
    clearTimeout(a.timer);
    c.asking.delete(id);
    if (a.confirming) this.done(c, byIt ? { name: a.request.name, as: "refused" } : null);
    else this.tell();
  }

  private settled(offer: ConnectOffer, pairing: Pairing): void {
    const c = this.current;
    if (c?.offer !== offer) return;
    this.o.kept(pairing);
    this.done(c, { name: pairing.with.name, as: "me" });
  }

  /** The offer was used: it is over, and how it ended is shown. */
  private done(c: Current, last: ConnectState["last"]): void {
    this.last = last;
    if (this.current === c) this.cancel();
    else this.tell();
  }

  private tell(): void {
    this.o.changed(this.state());
  }
}
