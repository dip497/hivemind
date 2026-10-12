// This browser as one of the person's devices (docs/design/phone-browser-2026-10-03.md §3): the wasm
// (hive-phone's core) pairs, signs, reads and acts; this keeps one connection to the computer it
// paired with, dialled again when it drops, and hands the screens what it is told.

import init, { Device, type Host, HomeView, deviceId, pair, readLink, readQr } from "../pkg/hive_web.js";
import type { Filter } from "./home.js";
import { deviceKey, get, put, remove } from "./store.js";
import type { Agent, Held, Others, Overview, Paired, Piece, Reply, Shown, Start, Startable } from "./types.js";
import { message } from "./words.js";

export interface Told {
  /** What the computer says of Home changed what this browser holds. */
  home(): void;
  /** Whether the computer is reached; why not, when it is not. */
  status(live: boolean, error: string | null): void;
  /** The person's other devices, as the computer tells of them once reached. */
  others(o: Others): void;
  /** The computer turned this browser away: it is not one of the person's devices there now. The
   *  pairing is forgotten here too. */
  refused(computer: string): void;
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

export class Phone {
  private host: Host | null = null;
  private running = false;
  private wake: (() => void) | null = null;
  private readonly followed = new Set<Followed>();

  private constructor(
    readonly id: string,
    private readonly seed: Uint8Array,
    public paired: Paired | null,
    private readonly told: Told,
    private view: HomeView,
  ) {}

  /** The wasm compiled as it downloads (`instantiateStreaming`, the module from the service
   *  worker's cache once kept), and this browser's key. */
  static async open(paired: Paired | null, told: Told): Promise<Phone> {
    await init();
    const [seed, kept] = await Promise.all([deviceKey(), get<unknown>("home")]);
    return new Phone(deviceId(seed), seed, paired, told, new HomeView(paired ? kept ?? null : null));
  }

  /** Home as it shows, by `filter`. */
  shown(filter: Filter): Shown {
    return this.view.shown(filter.query, filter.machine ?? undefined, this.paired?.with.name ?? "your computer") as Shown;
  }

  /** The agents on the computer, as the agent screen and the needs show them. */
  overview(): Overview {
    return this.view.overview(this.paired?.with.device ?? "", this.paired?.with.name ?? "your computer") as Overview;
  }

  /** What this browser holds of Home, to keep. */
  kept(): unknown {
    return this.view.kept();
  }

  /** The computer the pairing link in `text` names, or null when it is not one. */
  read(text: string): { device: string; name: string } | null {
    return readLink(text) as { device: string; name: string } | null;
  }

  /** The text of a QR code in a camera's frame, or null when none in it reads. */
  readQr(rgba: Uint8Array, width: number, height: number): string | null {
    return readQr(rgba, width, height) ?? null;
  }

  /** Pair with the computer whose link `text` is, as the page's address carries it or as copied. */
  async pair(text: string, name: string): Promise<Paired> {
    const given = (await pair(this.seed, text, name)) as Paired;
    const before = this.paired;
    await put("paired", given);
    this.paired = given;
    // In place of another computer: what it said goes, and its connection with it.
    if (before) {
      this.view = new HomeView(null);
      await remove("home");
      this.host?.close();
      this.wake?.();
    }
    this.connect();
    return given;
  }

  /** Forget the computer, and tell it to forget this browser when it is reached (spec/pairing.md,
   *  "Unpairing"): whether it was told. Pairing again starts afresh. */
  async forget(): Promise<boolean> {
    const host = this.host;
    this.paired = null;
    const told = host ? await within(host.unpair(), REACH, "no answer").catch(() => false) : false;
    await this.forgetHere();
    return told;
  }

  private async forgetHere(): Promise<void> {
    this.paired = null;
    this.view = new HomeView(null);
    await remove("paired");
    await remove("home");
    this.host?.close();
    this.wake?.();
  }

  /** Keep a connection to the computer, while paired. */
  connect(): void {
    if (this.running || !this.paired) return;
    this.running = true;
    void this.keep();
  }

  /** Dial again now rather than after the wait: the page is shown again, or the network is back. */
  retry(): void {
    this.wake?.();
  }

  private async keep(): Promise<void> {
    for (let tries = 0; this.paired; ) {
      const paired = this.paired;
      let device: Device | null = null;
      try {
        const { device: id, relay, name } = paired.with;
        device = await Device.start(this.seed, relay ? [relay] : []);
        // Closing the device, below, ends a dial that took too long.
        const host = await within(device.reach(id, relay ?? undefined), REACH, `no answer in ${REACH / 1000} s`);
        this.host = host;
        tries = 0;
        this.told.status(true, null);
        for (const f of this.followed) f.start(host);
        host.devices(paired.certificate).then((o: Others) => this.paired === paired && this.told.others(o), () => {});
        const view = this.view;
        await host.home(view.at(), (text: string) => view.apply(text) && this.told.home());
        throw new Error(`${name} stopped telling this browser of its agents`);
      } catch (e) {
        if (this.paired !== paired) continue;
        if (e instanceof Error && e.name === "Unpaired") {
          await this.forgetHere();
          this.told.refused(paired.with.name);
        } else this.told.status(false, message(e));
      } finally {
        this.host?.close();
        this.host = null;
        await device?.close();
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(PATIENCE, 1000 * 2 ** tries++));
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
    this.running = false;
  }

  private reached(): Host {
    if (!this.host) throw new Error(`Not connected to ${this.paired?.with.name ?? "your computer"} right now`);
    return this.host;
  }

  /** Answer what `agent` waits on the person for, once: never sent again. Whether it landed: not
   *  when it waits on that no more; null when the computer did not say (it may have). */
  async answer(agent: Agent, reply: Reply): Promise<boolean | null> {
    if (!agent.waiting) return false;
    const sent = this.reached().answer(agent.workspace, agent.tile, agent.waiting.since, reply);
    return within(sent, REACH, "no answer").catch(() => null);
  }

  /** Send `agent` a message, typed in at its prompt. Whether it went. */
  async send(agent: Agent, text: string): Promise<boolean> {
    return this.reached().send(agent.workspace, agent.tile, text);
  }

  /** Stop `agent`'s turn. Whether it was in one. */
  async stop(agent: Agent): Promise<boolean> {
    return this.reached().stop(agent.workspace, agent.tile);
  }

  /** Close `agent`. Whether it was open. */
  async close(agent: Agent): Promise<boolean> {
    return this.reached().closeAgent(agent.workspace, agent.tile);
  }

  /** The workspaces the computer holds. */
  async workspaces(): Promise<Held[]> {
    return (await this.reached().workspaces()) as Held[];
  }

  /** What may be started in `workspace`. */
  async startable(workspace: string): Promise<Startable> {
    return (await this.reached().startable(workspace)) as Startable;
  }

  /** Start an agent in `workspace`: its tile. */
  async start(workspace: string, start: Start): Promise<string> {
    return this.reached().start(workspace, start);
  }

  /** Follow what `agent` and the person said, from the last of its session, again after each
   *  reconnection: `said` gets each piece, `ended` why it stopped. What it returns stops it. */
  conversation(agent: Agent, said: (p: Piece) => void, ended: (why: string) => void): () => void {
    const f = new Followed(agent, said, ended);
    this.followed.add(f);
    if (this.host) f.start(this.host);
    return () => {
      this.followed.delete(f);
      f.stop();
    };
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
