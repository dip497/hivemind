/**
 * One keyboard per terminal (R4, M2; design §4.2 D): who may type into a session, and whose size
 * it takes. Until the host gives it away, the keyboard is the host's: its own windows type (the
 * last to type sizes the session, as before) and a guest's keys are dropped. A guest who may use
 * terminals asks for it; whoever holds it (or the host) gives it to them; then only they type,
 * and their size is the session's. The host takes it back whenever it likes, it comes back by
 * itself after five idle minutes, and it comes back when its holder goes. Everyone is told who
 * holds each keyboard, and the holder of an ask. Electron-free.
 */
import type { Connection } from "@hivemind/workspace-api/server";
import type { EventParams } from "@hivemind/workspace-api/methods";
import type { Typist } from "@hivemind/workspace-api/terminals";

export interface KeyboardOptions {
  /** Tell every client. */
  publish(event: "terminal.keyboard", ...params: EventParams<"terminal.keyboard">): void;
  /** Tell one client. */
  tell(to: Connection, event: "terminal.keyboard.asked", ...params: EventParams<"terminal.keyboard.asked">): void;
  /** Who is at a connection. */
  who(connection: Connection): { person: string; name: string };
  /** The host's windows showing `tile`: they are asked while the host holds its keyboard. */
  hostWindows(tile: string): Connection[];
}

/** A keyboard left this long by the one it was given to comes back to the host. */
export const KEYBOARD_IDLE_MS = 5 * 60_000;

/** Whether a connection is the host's own: one of its windows, or another device of its owner's
 *  (spec/pairing.md), which is the host's person wherever it is, as at `hive host`, where no
 *  window ever is. */
export const isHost = (c: Connection): boolean => c.actor.kind !== "peer" || c.actor.access === "owner";

interface Lease {
  holder: Connection;
  idle: ReturnType<typeof setTimeout>;
}

export class Keyboards {
  private readonly leases = new Map<string, Lease>();
  /** Who asked for each keyboard, by their id. */
  private readonly asks = new Map<string, Map<string, Connection>>();
  private readonly ids = new WeakMap<Connection, string>();
  private made = 0;

  constructor(private readonly opts: KeyboardOptions, private readonly idleMs = KEYBOARD_IDLE_MS) {}

  /** Whether `from` may type into `tile` now. */
  mayType(tile: string, from: Connection): boolean {
    const lease = this.leases.get(tile);
    return lease ? lease.holder === from : isHost(from);
  }

  /** Whether `from`'s size is the session's: the holder's, when someone else holds it. */
  sizes(tile: string, from: Connection): boolean | "host" {
    const lease = this.leases.get(tile);
    return lease ? lease.holder === from : isHost(from) ? "host" : false;
  }

  /** `from` typed: its lease, if it holds one, is not idle. */
  typed(tile: string, from: Connection): void {
    const lease = this.leases.get(tile);
    if (lease?.holder !== from) return;
    clearTimeout(lease.idle);
    lease.idle = this.idleTimer(tile);
  }

  /** `from` asks for `tile`'s keyboard: whoever holds it is asked (the host's windows while the
   *  host does). */
  ask(tile: string, from: Connection): void {
    if (this.mayType(tile, from)) return;
    let asked = this.asks.get(tile);
    if (!asked) this.asks.set(tile, (asked = new Map()));
    const asker = this.typist(from);
    asked.set(asker.id, from);
    const lease = this.leases.get(tile);
    for (const to of lease ? [lease.holder] : this.opts.hostWindows(tile)) this.opts.tell(to, "terminal.keyboard.asked", tile, asker);
  }

  /** `from`, who holds `tile`'s keyboard (or is the host), gives it to `to`, who asked for it. */
  give(tile: string, from: Connection, to: string): void {
    const lease = this.leases.get(tile);
    if (!(lease ? lease.holder === from || isHost(from) : isHost(from))) return;
    const asker = this.asks.get(tile)?.get(to);
    if (!asker || asker.closed.aborted) return;
    this.asks.get(tile)!.delete(to);
    if (lease) clearTimeout(lease.idle);
    this.leases.set(tile, { holder: asker, idle: this.idleTimer(tile) });
    this.opts.publish("terminal.keyboard", tile, this.typist(asker));
  }

  /** The host takes `tile`'s keyboard back. */
  take(tile: string, from: Connection): void {
    if (isHost(from)) this.release(tile);
  }

  /** Who holds `tile`'s keyboard: null while the host does. */
  holder(tile: string): Typist | null {
    const lease = this.leases.get(tile);
    return lease ? this.typist(lease.holder) : null;
  }

  /** A connection went: the keyboards it held come back to the host, and its asks are dropped. */
  gone(connection: Connection): void {
    for (const [tile, lease] of this.leases) if (lease.holder === connection) this.release(tile);
    const id = this.ids.get(connection);
    if (id) for (const asked of this.asks.values()) asked.delete(id);
  }

  /** The session ended. */
  forget(tile: string): void {
    const lease = this.leases.get(tile);
    if (lease) clearTimeout(lease.idle);
    this.leases.delete(tile);
    this.asks.delete(tile);
  }

  private release(tile: string): void {
    const lease = this.leases.get(tile);
    if (!lease) return;
    clearTimeout(lease.idle);
    this.leases.delete(tile);
    this.opts.publish("terminal.keyboard", tile, null);
  }

  private idleTimer(tile: string): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => this.release(tile), this.idleMs);
    t.unref?.();
    return t;
  }

  /** Who is at `connection`, as the others are told: one id per window, or per peer device. */
  typist(connection: Connection): Typist {
    let id = this.ids.get(connection);
    if (!id) this.ids.set(connection, (id = connection.actor.kind === "peer" ? `peer:${connection.actor.device}` : `window:${++this.made}`));
    return { id, ...this.opts.who(connection) };
  }
}
