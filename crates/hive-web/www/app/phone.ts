// This browser as one of a person's devices (docs/design/phone-browser-2026-10-03.md §3): the wasm
// (hive-phone's core) pairs, signs, reads and acts; this keeps a connection to each of the person's
// computers, the ones paired with and the ones they tell of, each dialled again when it drops, and
// hands the screens what they say, as one Home.

import init, { Device, type Host, Homes, Term, type ViewSession, connectWith, deviceId, pair, readConnectLink, readLink, readQr } from "../pkg/hive_web.js";
import type { Filter } from "./home.js";
import type { Account, Computer } from "./accounts.js";
import { deviceKey, get } from "./store.js";
import type { Agent, Folders, Held, Offered, Others, Overview, Paired, Photo, Piece, Places, Reply, Screen, Sent, Shown, Start, Unfolded, ViewFile } from "./types.js";
import { message } from "./words.js";

/** What connecting shows, step by step (pair.ts). */
export interface Connect {
  /** Asking the computer `name`. */
  asking(name: string): void;
  /** The words both screens show, while the person at the computer answers. */
  words(words: string[]): void;
  /** The computer says this phone is the person's, `person` by name when it says; whether the
   *  words match, as the person here says. */
  match(person: string | null): Promise<boolean>;
}

export interface Told {
  /** What a computer says of Home changed what this browser holds. */
  home(): void;
  /** A computer was reached, or lost. */
  status(): void;
  /** What the person is called, as a computer they own says. */
  named(name: string): void;
  /** A computer this browser paired with turned it away: it is not one of the person's devices
   *  there now. The pairing is to be forgotten here too. */
  refused(computer: Computer): void;
}

/** One of the person's computers, and how it is reached. */
export interface Reach {
  device: string;
  name: string;
  kind: string;
  /** Paired with here; else told of by one that was. */
  paired: boolean;
  live: boolean;
  error: string | null;
}

/** The wasm, compiled once (`instantiateStreaming`, the module from the service worker's cache
 *  once kept). Beside the page: bundled, this script is not beside the glue. */
let compiled: Promise<unknown> | null = null;
export const ready = () => (compiled ??= init({ module_or_path: new URL("pkg/hive_web_bg.wasm", document.baseURI) }));

/** The computer the link in `text` names, to pair with or, `connect`, to connect to; null when it
 *  is neither. */
export function read(text: string): { device: string; name: string; connect: boolean } | null {
  const pairing = readLink(text) as { device: string; name: string } | null;
  if (pairing) return { ...pairing, connect: false };
  const offer = readConnectLink(text) as { device: string; name: string } | null;
  return offer && { ...offer, connect: true };
}

/** The text of a QR code in a camera's frame, or null when none in it reads. */
export function scan(rgba: Uint8Array, width: number, height: number): string | null {
  return readQr(rgba, width, height) ?? null;
}

/** The id the key `key` gives this browser. */
export async function idOf(key: string): Promise<string> {
  return deviceId(await deviceKey(key));
}

/** Pair under the key `key` with the computer whose link `text` is, as the page's address carries
 *  it or as copied; or, an offer to connect (spec/pairing.md 0.10), connect to it, showing `shown`
 *  each step, once the person at the computer and the one here both say yes. */
export async function pairUnder(key: string, text: string, name: string, shown: Connect): Promise<Paired> {
  const seed = await deviceKey(key);
  if (!read(text)?.connect) return (await pair(seed, text, name)) as Paired;
  shown.asking(read(text)?.name ?? "your computer");
  const asked = await connectWith(seed, text, name);
  shown.words(asked.words);
  let person: { name: string } | null;
  try {
    person = (await asked.wait()) as { name: string } | null;
  } catch (e) {
    await asked.close();
    throw e;
  }
  if (!(await shown.match(person?.name ?? null))) {
    await asked.refuse();
    throw new Error("The words did not match: nothing was kept.");
  }
  return (await asked.take()) as Paired;
}

/** The longest wait before dialling again. */
const PATIENCE = 15_000;
/** How long the computer has to answer before the person is told it is not reached. */
const REACH = 10_000;

function within<T>(p: Promise<T>, ms: number, why: string): Promise<T> {
  let timer = 0;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(why)), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** A computer of the account, its connection while it has one, and what is followed on it. */
class Link {
  host: Host | null = null;
  live = false;
  error: string | null = null;
  wake: (() => void) | null = null;
  readonly followed = new Set<Followed | Watched>();

  constructor(
    readonly device: string,
    readonly name: string,
    readonly kind: string,
    readonly relay: string | null,
    /** The key it is reached under: its own pairing's, or the one that told of it's. */
    readonly key: string,
    readonly paired: Computer | null,
  ) {}
}

export class Phone {
  private readonly links = new Map<string, Link>();
  /** One endpoint per key, every computer reached under it dialled through it: two endpoints of
   *  one key are one device to the relay, which keeps only one of them. */
  private readonly devices = new Map<string, Promise<Device>>();
  private closed = false;
  /** Which computer holds a workspace, as their lists of workspaces say. */
  private readonly holds = new Map<string, string>();

  private constructor(
    readonly account: Account,
    private readonly told: Told,
    private readonly homes: Homes,
  ) {
    for (const c of account.computers) {
      this.links.set(c.with.device, new Link(c.with.device, c.with.name, c.with.kind, c.with.relay, c.key, c));
    }
  }

  /** The person of `account`, what this browser last held of their computers' Home. */
  static async open(account: Account, told: Told): Promise<Phone> {
    await ready();
    const kept = await get<unknown>(`home:${account.person}`);
    return new Phone(account, told, new Homes(kept ?? null));
  }

  /** Each computer, those paired with first, and how it is reached. */
  computers(): Reach[] {
    return [...this.links.values()].map((l) => ({ device: l.device, name: l.name, kind: l.kind, paired: !!l.paired, live: l.live, error: l.error }));
  }

  private named(): Array<{ device: string; name: string }> {
    return [...this.links.values()].map((l) => ({ device: l.device, name: l.name }));
  }

  /** Home as it shows across the computers, by `filter` and the person's View `choices`
   *  (hive-phone's `homes`). */
  shown(filter: Filter, choices: object = {}): Shown {
    return this.homes.shown(filter.query, filter.machine ?? undefined, this.named(), choices) as Shown;
  }

  /** The agents across the computers, and what waits on the person. */
  overview(): Overview {
    return this.homes.overview(this.named()) as Overview;
  }

  /** What this browser holds of Home, to keep. */
  kept(): unknown {
    return this.homes.kept();
  }

  /** Keep a connection to each computer. */
  connect(): void {
    for (const link of this.links.values()) this.keep(link);
  }

  /** Let go of every connection: another account is shown. */
  disconnect(): void {
    this.closed = true;
    for (const link of this.links.values()) {
      link.host?.close();
      link.wake?.();
    }
    for (const device of this.devices.values()) void device.then((d) => d.close(), () => {});
    this.devices.clear();
  }

  /** Dial again now rather than after the wait: the page is shown again, or the network is back. */
  retry(): void {
    for (const link of this.links.values()) link.wake?.();
  }

  /** Forget the account's computers, and tell each to forget this browser when it is reached
   *  (spec/pairing.md, "Unpairing"): the ones not told. */
  async forget(): Promise<string[]> {
    const paired = [...this.links.values()].filter((l) => l.paired);
    const told = await Promise.all(paired.map((l) => l.host ? within(l.host.unpair(), REACH, "no answer").catch(() => false) : Promise.resolve(false)));
    this.disconnect();
    return paired.filter((_, i) => !told[i]).map((l) => l.name);
  }

  private running = new Set<string>();

  private keep(link: Link): void {
    if (this.running.has(link.device) || this.closed) return;
    this.running.add(link.device);
    void this.dial(link).finally(() => this.running.delete(link.device));
  }

  private async dial(link: Link): Promise<void> {
    for (let tries = 0; !this.closed && this.links.get(link.device) === link; ) {
      try {
        const device = await this.deviceOf(link);
        const reaching = device.reach(link.device, link.relay ?? undefined);
        // Reached after the wait was given up on: let go of.
        const host = await within(reaching, REACH, `no answer in ${REACH / 1000} s`).catch((e: unknown) => {
          void reaching.then((late) => late.close(), () => {});
          throw e;
        });
        if (this.closed) {
          host.close();
          throw new Error("closed");
        }
        link.host = host;
        link.live = true;
        link.error = null;
        tries = 0;
        this.told.status();
        for (const f of link.followed) f.start(host);
        if (link.paired) void this.ask(link, host);
        await host.home(this.homes.at(link.device), (text: string) => this.homes.apply(link.device, text) && this.told.home());
        throw new Error(`${link.name} stopped telling this browser of its agents`);
      } catch (e) {
        if (this.closed) break;
        if (e instanceof Error && e.name === "Unpaired" && link.paired) {
          this.drop(link);
          this.told.refused(link.paired);
          break;
        }
        link.error = message(e);
      } finally {
        link.host?.close();
        link.host = null;
        link.live = false;
        if (!this.closed) this.told.status();
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(PATIENCE, 1000 * 2 ** tries++));
        link.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      link.wake = null;
    }
  }

  /** What a computer paired with tells of the person: their name, and their other computers and
   *  hosts, each reached too, under the key that computer knows this browser by. */
  private async ask(link: Link, host: Host): Promise<void> {
    const others = (await host.devices(link.paired!.certificate).catch(() => null)) as Others | null;
    if (!others || this.closed) return;
    if (others.whose) this.told.named(others.whose);
    let added = false;
    for (const d of others.devices) {
      if (this.links.has(d.device) || !d.relay) continue;
      const other = new Link(d.device, d.name, d.kind, d.relay, link.key, null);
      this.links.set(d.device, other);
      this.keep(other);
      added = true;
    }
    this.told.status();
    // What was kept of it shows now, before it is reached.
    if (added) this.told.home();
  }

  /** The endpoint `link`'s key dials through, started on first use; one that failed to start is
   *  started again next time. */
  private deviceOf(link: Link): Promise<Device> {
    let device = this.devices.get(link.key);
    if (!device) {
      device = deviceKey(link.key).then((seed) => Device.start(seed, link.relay ? [link.relay] : []));
      this.devices.set(link.key, device);
      device.catch(() => this.devices.get(link.key) === device && this.devices.delete(link.key));
    }
    return device;
  }

  private drop(link: Link): void {
    this.links.delete(link.device);
    this.homes.forget(link.device);
    this.told.home();
  }

  private on(device: string): Host {
    const link = this.links.get(device);
    if (!link?.host) throw new Error(`Not connected to ${link?.name ?? "that computer"} right now`);
    return link.host;
  }

  /** The computer that holds `workspace`. */
  private holding(workspace: string): string {
    const device = this.holds.get(workspace) ?? this.homes.deviceOf(workspace);
    if (!device) throw new Error("No computer here holds that workspace");
    return device;
  }

  /** Answer what `agent` waits on the person for, once: never sent again. Whether it landed: not
   *  when it waits on that no more; null when the computer did not say (it may have). */
  async answer(agent: Agent, reply: Reply): Promise<boolean | null> {
    if (!agent.waiting) return false;
    const sent = this.on(agent.device).answer(agent.workspace, agent.tile, agent.waiting.since, reply);
    return within(sent, REACH, "no answer").catch(() => null);
  }

  /** Send `agent` a message, typed in at its prompt, or into its turn when it reads one there.
   *  Whether it went, and whether it waits for the turn to end. */
  async send(agent: Agent, text: string, photos: Photo[] = []): Promise<Sent | false> {
    return ((await this.on(agent.device).send(agent.workspace, agent.tile, text, photos)) as Sent | null) ?? false;
  }

  /** Stop `agent`'s turn. Whether it was in one. */
  async stop(agent: Agent): Promise<boolean> {
    return this.on(agent.device).stop(agent.workspace, agent.tile);
  }

  /** Close `agent`. Whether it was open. */
  async close(agent: Agent): Promise<boolean> {
    return this.on(agent.device).closeAgent(agent.workspace, agent.tile);
  }

  /** The workspaces the computers reached hold, each named with its computer when there are more. */
  async workspaces(): Promise<Held[]> {
    const live = [...this.links.values()].filter((l) => l.host);
    const lists = await Promise.all(live.map(async (l) => {
      const held = (await l.host!.workspaces()) as Held[];
      for (const w of held) this.holds.set(w.workspace, l.device);
      return live.length > 1 ? held.map((w) => ({ ...w, name: `${w.name} · ${l.name}` })) : held;
    }));
    return lists.flat();
  }

  /** Where an agent may be started in `workspace`. */
  async places(workspace: string): Promise<Places> {
    return (await this.on(this.holding(workspace)).places(workspace)) as Places;
  }

  /** The folders in `folder`, inside one of `workspace`'s projects. */
  async folders(workspace: string, folder: string): Promise<Folders> {
    return (await this.on(this.holding(workspace)).folders(workspace, folder)) as Folders;
  }

  /** Start an agent in `workspace`: its tile. */
  async start(workspace: string, start: Start): Promise<string> {
    return this.on(this.holding(workspace)).start(workspace, start);
  }

  /** The tool use `use` of `agent`, unfolded. */
  async tool(agent: Agent, use: string): Promise<Unfolded> {
    return (await this.on(agent.device).tool(agent.workspace, agent.tile, use)) as Unfolded;
  }

  /** The views the computer holding `workspace` offers there. */
  async views(workspace: string): Promise<Offered[]> {
    return (await this.on(this.holding(workspace)).views(workspace)) as Offered[];
  }

  /** The file `path` of the view `view` in `workspace`. */
  async viewFile(workspace: string, view: string, path: string): Promise<ViewFile> {
    return (await this.on(this.holding(workspace)).viewFile(workspace, view, path)) as ViewFile;
  }

  /** Open the view `view` on `workspace`, shown on `screen`. */
  async openView(workspace: string, view: string, screen: Screen): Promise<ViewSession> {
    return this.on(this.holding(workspace)).openView(workspace, view, screen);
  }

  /** Watch the terminal of `tile` in `workspace`, again after each reconnection: its screen is
   *  `term`'s, `changed` when it may have changed, `ended` how it ended. `stop` stops it. */
  watch(workspace: string, tile: string, changed: () => void, ended: (why: string) => void): { term: Term; stop: () => void } {
    const w = new Watched(new Term(), workspace, tile, changed, ended);
    const link = this.links.get(this.holds.get(workspace) ?? this.homes.deviceOf(workspace) ?? "");
    link?.followed.add(w);
    if (link?.host) w.start(link.host);
    return {
      term: w.term,
      stop: () => {
        link?.followed.delete(w);
        w.stop();
        w.term.free();
      },
    };
  }

  /** Follow what `agent` and the person said, from the last of its session, again after each
   *  reconnection: `said` gets each piece, `ended` why it stopped. What it returns stops it. */
  conversation(agent: Agent, said: (p: Piece) => void, ended: (why: string) => void): () => void {
    const f = new Followed(agent, said, ended);
    const link = this.links.get(agent.device);
    link?.followed.add(f);
    if (link?.host) f.start(link.host);
    return () => {
      link?.followed.delete(f);
      f.stop();
    };
  }
}

class Watched {
  private end: (() => void) | null = null;

  constructor(
    readonly term: Term,
    private readonly workspace: string,
    private readonly tile: string,
    private readonly changed: () => void,
    private readonly ended: (why: string) => void,
  ) {}

  start(host: Host): void {
    this.stop();
    const until = new Promise<void>((resolve) => (this.end = resolve));
    host.watch(this.workspace, this.tile, this.term, this.changed, until).then(
      (how: { code: number | null } | null) => how && this.ended(how.code === null ? "No session runs there." : `The session ended (${how.code}).`),
      (e: unknown) => this.ended(message(e)),
    );
  }

  stop(): void {
    this.end?.();
    this.end = null;
  }
}

class Followed {
  private end: (() => void) | null = null;

  constructor(
    private readonly agent: Agent,
    private readonly said: (p: Piece) => void,
    private readonly ended: (why: string) => void,
  ) {}

  start(host: Host): void {
    this.stop();
    const until = new Promise<void>((resolve) => (this.end = resolve));
    host.conversation(this.agent.workspace, this.agent.tile, this.said, until).catch((e: unknown) => this.ended(message(e)));
  }

  stop(): void {
    this.end?.();
    this.end = null;
  }
}
