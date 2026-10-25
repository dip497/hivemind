/**
 * Each tile's last line (docs/design/last-line-2026-10-23.md §1), for whoever watches it. For a
 * tile whose agent keeps a conversation, what it last said there ("" until it says something), as
 * its session file says; for any other, what its screen last showed with text, as the daemon that
 * runs its session read it (`tile.line`, through the control plane), on this machine or another.
 *
 * A client says which tiles it watches (`tile.watchLines`), in place of those it watched, and is
 * answered their lines now; then it is sent `tile.lines` with those whose line changed, to it
 * alone, at most every 250 ms: 50 tiles printing are at most four messages a second to each client
 * that watches them. `tile.readLines` is a one-shot read, for a toast or the CLI, that waits for a
 * read of what an agent said already under way. A client that watches nothing (a window with no
 * Layers panel, a peer) is sent nothing, and once nothing is left to tell, nothing runs.
 *
 * What an agent said is read only for a tile someone follows (a client's watch, or Home while a
 * phone follows it, `followAll`), when its own agent reports (`reported`: each tool use, each
 * reply; for an agent that reports nothing, each change of its screen), and only what it wrote
 * since (`LastSaid`). A report of a tile no one follows marks it,
 * and it is read before its line is next told: to a one-shot read, to Home, to a new watch. An agent
 * that runs on another machine keeps no conversation here: its line is its screen's, as that
 * machine's daemon read it. Electron-free: main and `hive host` each make one.
 *
 * A line is kept as one line of plain text at most 160 characters long (one-line.ts) whoever sent
 * it: the daemon that read it, a tile's own process (the control-plane socket lets a tile set its
 * own line) or a daemon of an older version, which strips nothing.
 */
import { oneLine } from "@hivemind/agent-host/one-line";
import { texts } from "@hivemind/workspace-api/protocol";
import type { Connection, Domain, WorkspaceServer } from "@hivemind/workspace-api/server";
import type { LastLines } from "@hivemind/workspace-api/terminals";
import { toBareId } from "@hivemind/workspace-api/tile-id";
import { LastSaid, type Transcript } from "./conversations.js";

/** A client is told the lines that changed at most this often. */
export const LINES_EVERY_MS = 250;
/** A client watches, or reads at once, at most this many tiles. */
const WATCHED_MAX = 1024;

export interface TileLinesOptions {
  /** Where the clients that watch a tile are told. */
  server(): Pick<WorkspaceServer, "publishTo">;
  /** A tile's line changed (the person's phone's Home is told). */
  changed?(): void;
  /** The session the agent of a tile keeps its conversation in, and its file; null when it keeps
   *  none. None given: no tile's line is what its agent said. */
  transcriptOf?(bare: string): Transcript | null;
  /** Whether the agent of a tile runs on this machine, so its session file is here: one that runs
   *  elsewhere keeps no conversation here. None given: every one does. */
  runsHere?(bare: string): boolean;
  /** Whether the agent of a tile reports what it does (its hooks signal its turns): what it said
   *  is read as it reports. One that reports nothing is read as its screen changes. None given:
   *  every one does. */
  reports?(bare: string): boolean;
}

export class TileLines {
  /** What each tile's screen last showed, by its bare id: "" once it shows none. */
  private readonly screens = new Map<string, string>();
  /** What each agent that keeps a conversation last said. */
  private readonly said: LastSaid;
  /** The tiles each client watches. */
  private readonly watches = new Map<Connection, Set<string>>();
  /** Who watches each tile: every client's watch, together. */
  private readonly watchers = new Map<string, Set<Connection>>();
  /** The tiles whose line changed since each client was last told. */
  private readonly changed = new Map<Connection, Set<string>>();
  /** Home follows every tile, while a phone follows it. */
  private all = false;
  private due: ReturnType<typeof setTimeout> | null = null;
  /** When clients were last told, on the clock the timers run on: the wall clock set back would
   *  hold every line back as long. */
  private toldAt = -Infinity;
  readonly domain: Domain<"tile.watchLines" | "tile.readLines">;

  constructor(private readonly o: TileLinesOptions) {
    const { transcriptOf, runsHere } = o;
    this.said = new LastSaid({
      transcriptOf: (bare) => (transcriptOf && runsHere?.(bare) !== false ? transcriptOf(bare) : null),
      said: (bare) => this.lineChanged(bare),
    });
    this.domain = {
      answers: {
        "tile.watchLines": (from, tiles) => ({ lines: this.linesOf(this.watch(from, texts(tiles, "tiles").slice(0, WATCHED_MAX))) }),
        "tile.readLines": async (_from, tiles) => ({ lines: await this.read(texts(tiles, "tiles").slice(0, WATCHED_MAX).map(toBareId)) }),
      },
      effects: {},
      gone: (connection) => { this.watch(connection, []); },
    };
  }

  /** The line `bare` shows now: what its agent last said, when it keeps a conversation ("" until
   *  it says something there, and before it was read); else what its screen shows, none before
   *  its screen showed one. While Home follows every tile, a tile asked for whose agent's words
   *  were never read, or reported since, is read, and told once it is. */
  get(bare: string): string | undefined {
    if (!this.said.keeps(bare)) return this.screens.get(bare);
    if (this.all && this.said.unread(bare)) this.said.refresh(bare);
    return this.said.line(bare) ?? "";
  }

  /** The lines of `tiles` now, each read first when no one follows it, or its agent's words are
   *  being read or were never read: what a one-shot reader (a toast, the CLI) is answered. */
  async read(tiles: string[]): Promise<LastLines> {
    const reading = tiles.filter((t) => this.said.keeps(t));
    for (const t of reading) if (!this.followed(t) || this.said.unread(t)) this.said.refresh(t);
    await Promise.all(reading.map((t) => this.said.settled(t)));
    return this.linesOf(tiles);
  }

  /** `bare`'s screen shows `said`, kept as one line of plain text: each client that watches it is
   *  told, unless it showed that already or its line is what its agent said. For an agent that
   *  reports nothing, its screen changing is its report. */
  set(bare: string, said: string): void {
    const line = oneLine(said);
    if (this.screens.get(bare) === line) return;
    this.screens.set(bare, line);
    if (!this.said.keeps(bare)) this.lineChanged(bare);
    else if (this.o.reports?.(bare) === false) this.reported(bare);
  }

  /** The agent of `bare` reported (a tool used, a turn ended, a reply), from `session`: what it
   *  said since is read while someone follows the tile, else before its line is next told. */
  reported(bare: string, session?: string): void {
    if (!this.followed(bare)) return this.said.stale(bare, session);
    this.said.refresh(bare, session ? { session } : {});
  }

  /** Home follows every tile (`on`), while a phone follows it, or no longer. As it starts to, each
   *  tile whose agent reported while no one followed it is read, and told once it is. */
  followAll(on: boolean): void {
    const was = this.all;
    this.all = on;
    if (on && !was) this.said.refreshStale();
  }

  /** Whether someone follows `bare`: a client's watch, or Home. */
  private followed(bare: string): boolean {
    return this.all || this.watchers.has(bare);
  }

  /** `bare` is closed: its line goes with it. */
  forget(bare: string): void {
    this.screens.delete(bare);
    this.said.forget(bare);
  }

  /** `bare`'s line changed: each client that watches it is told soon, and Home. */
  private lineChanged(bare: string): void {
    this.o.changed?.();
    const watchers = this.watchers.get(bare);
    if (!watchers) return;
    for (const c of watchers) {
      let mine = this.changed.get(c);
      if (!mine) this.changed.set(c, (mine = new Set()));
      mine.add(bare);
    }
    this.tellSoon();
  }

  /** `from` watches `tiles` from now on, and no others: the tiles it watches. What it was yet to be
   *  told goes, as the answer holds each one's line now. For a tile no one watched before, which file
   *  its agent keeps is looked for, and what it said since read, when it keeps one. */
  private watch(from: Connection, tiles: string[]): Set<string> {
    const now = new Set(tiles.map(toBareId));
    for (const tile of this.watches.get(from) ?? []) {
      if (now.has(tile)) continue;
      const watchers = this.watchers.get(tile);
      watchers?.delete(from);
      if (watchers?.size === 0) this.watchers.delete(tile);
    }
    for (const tile of now) {
      let watchers = this.watchers.get(tile);
      if (!watchers) {
        this.watchers.set(tile, (watchers = new Set()));
        this.said.refresh(tile, { resolve: true });
      }
      watchers.add(from);
    }
    if (now.size > 0) this.watches.set(from, now);
    else this.watches.delete(from);
    this.changed.delete(from);
    if (this.changed.size === 0 && this.due) {
      clearTimeout(this.due);
      this.due = null;
    }
    return now;
  }

  /** The lines of those of `tiles` that showed one. */
  private linesOf(tiles: Iterable<string>): LastLines {
    const lines: LastLines = {};
    for (const tile of tiles) {
      const line = this.get(tile);
      if (line !== undefined) lines[tile] = line;
    }
    return lines;
  }

  /** Tell each client what changed, with whatever else changes this moment: at once after a quiet
   *  spell, else 250 ms after it was last told. */
  private tellSoon(): void {
    if (this.due) return;
    this.due = setTimeout(() => this.tell(), Math.max(0, LINES_EVERY_MS - (performance.now() - this.toldAt)));
    (this.due as { unref?: () => void }).unref?.();
  }

  private tell(): void {
    this.due = null;
    this.toldAt = performance.now();
    const server = this.o.server();
    for (const [to, tiles] of this.changed) {
      const lines = this.linesOf(tiles);
      if (Object.keys(lines).length > 0) server.publishTo((c) => c === to, "tile.lines", { lines });
    }
    this.changed.clear();
  }
}
