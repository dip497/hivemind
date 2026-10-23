/**
 * Each tile's last line (docs/design/last-line-2026-10-23.md §1), for whoever watches it: what its
 * screen last showed with text, as the daemon that runs its session read it (`tile.line`, through
 * the control plane), on this machine or another. A client says which tiles it watches
 * (`tile.watchLines`), in place of those it watched, and is answered their lines now; then it is
 * sent `tile.lines` with those whose line changed, to it alone, at most every 250 ms: 50 tiles
 * printing are at most four messages a second to each client that watches them. A client that
 * watches nothing (a window with no Layers panel, a peer) is sent nothing, and once nothing is left
 * to tell, nothing runs. Electron-free: main and `hive host` each make one.
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

/** A client is told the lines that changed at most this often. */
export const LINES_EVERY_MS = 250;
/** A client watches at most this many tiles. */
const WATCHED_MAX = 1024;

export interface TileLinesOptions {
  /** Where the clients that watch a tile are told. */
  server(): Pick<WorkspaceServer, "publishTo">;
  /** A tile's line changed (the person's phone's Home is told). */
  changed?(): void;
}

export class TileLines {
  /** Each tile's line, by its bare id: "" once its screen shows none. */
  private readonly lines = new Map<string, string>();
  /** The tiles each client watches. */
  private readonly watches = new Map<Connection, Set<string>>();
  /** Who watches each tile: every client's watch, together. */
  private readonly watchers = new Map<string, Set<Connection>>();
  /** The tiles whose line changed since each client was last told. */
  private readonly changed = new Map<Connection, Set<string>>();
  private due: ReturnType<typeof setTimeout> | null = null;
  private toldAt = -Infinity;
  readonly domain: Domain<"tile.watchLines">;

  constructor(private readonly o: TileLinesOptions) {
    this.domain = {
      answers: {
        "tile.watchLines": (from, tiles) => ({ lines: this.linesOf(this.watch(from, texts(tiles, "tiles").slice(0, WATCHED_MAX))) }),
      },
      effects: {},
      gone: (connection) => { this.watch(connection, []); },
    };
  }

  /** The line `bare` shows now; none before its screen showed one. */
  get(bare: string): string | undefined {
    return this.lines.get(bare);
  }

  /** `bare`'s screen shows `said`, kept as one line of plain text: each client that watches it is
   *  told, unless it showed that already. */
  set(bare: string, said: string): void {
    const line = oneLine(said);
    if (this.lines.get(bare) === line) return;
    this.lines.set(bare, line);
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

  /** `bare` is closed: its line goes with it. */
  forget(bare: string): void {
    this.lines.delete(bare);
  }

  /** `from` watches `tiles` from now on, and no others: the tiles it watches. What it was yet to be
   *  told goes, as the answer holds each one's line now. */
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
      if (!watchers) this.watchers.set(tile, (watchers = new Set()));
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
      const line = this.lines.get(tile);
      if (line !== undefined) lines[tile] = line;
    }
    return lines;
  }

  /** Tell each client what changed, with whatever else changes this moment: at once after a quiet
   *  spell, else 250 ms after it was last told. */
  private tellSoon(): void {
    if (this.due) return;
    this.due = setTimeout(() => this.tell(), Math.max(0, LINES_EVERY_MS - (Date.now() - this.toldAt)));
    (this.due as { unref?: () => void }).unref?.();
  }

  private tell(): void {
    this.due = null;
    this.toldAt = Date.now();
    const server = this.o.server();
    for (const [to, tiles] of this.changed) {
      const lines = this.linesOf(tiles);
      if (Object.keys(lines).length > 0) server.publishTo((c) => c === to, "tile.lines", { lines });
    }
    this.changed.clear();
  }
}
