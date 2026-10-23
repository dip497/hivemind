/**
 * How busy each watched terminal's output is (view protocol 1.3, `terminal.activity`), for whoever
 * watches it. A client says which tiles it watches (`terminal.watchActivity`), in place of those it
 * watched; each client keeps its own watch, and the meter samples their union, so one window's
 * watch never takes another's place. A client that starts watching a tile already busy is told its
 * level at once; then each change goes to the clients that watch that tile alone. A connection that
 * goes takes its watch with it, and once nothing is watched the meter's timer stops (`pty-activity.ts`).
 * Electron-free.
 */
import { texts } from "@hivemind/workspace-api/protocol";
import type { Connection, Domain, WorkspaceServer } from "@hivemind/workspace-api/server";
import type { ActivityLevels } from "@hivemind/workspace-api/terminals";
import { toBareId } from "@hivemind/workspace-api/tile-id";
import { ActivityMeter, type Level } from "./pty-activity.js";

/** A client watches at most this many tiles. */
const WATCHED_MAX = 1024;

export class TileActivity {
  private readonly meter = new ActivityMeter((levels) => this.changed(levels));
  /** The tiles each client watches. */
  private readonly watches = new Map<Connection, Set<string>>();
  /** How many clients watch each tile. */
  private readonly watched = new Map<string, number>();
  readonly domain: Domain<never, "terminal.watchActivity">;

  constructor(private readonly server: () => Pick<WorkspaceServer, "publishTo">) {
    this.domain = {
      answers: {},
      effects: {},
      notices: { "terminal.watchActivity": (from, tiles) => this.watch(from, texts(tiles, "tiles").slice(0, WATCHED_MAX)) },
      gone: (connection) => this.watch(connection, []),
    };
  }

  /** `bytes` of live output came from `bare` (never a reattach's replay). */
  note(bare: string, bytes: number): void {
    this.meter.note(bare, bytes);
  }

  /** `from` watches `tiles` from now on, and no others; told at once the level of each it did not
   *  watch before that is busy now. */
  private watch(from: Connection, tiles: string[]): void {
    const now = new Set(tiles.map(toBareId));
    const was = this.watches.get(from) ?? new Set<string>();
    for (const tile of was) {
      if (now.has(tile)) continue;
      const n = (this.watched.get(tile) ?? 1) - 1;
      if (n > 0) this.watched.set(tile, n); else this.watched.delete(tile);
    }
    const busy: ActivityLevels = {};
    for (const tile of now) {
      if (was.has(tile)) continue;
      this.watched.set(tile, (this.watched.get(tile) ?? 0) + 1);
      const level = this.meter.level(tile);
      if (level > 0) busy[tile] = level;
    }
    if (now.size > 0) this.watches.set(from, now); else this.watches.delete(from);
    this.meter.setWatched([...this.watched.keys()]);
    if (Object.keys(busy).length > 0) this.server().publishTo((c) => c === from, "terminal.activity", busy);
  }

  /** Levels changed: each client is told those of the tiles it watches. */
  private changed(levels: Record<string, Level>): void {
    const server = this.server();
    for (const [to, tiles] of this.watches) {
      const mine: ActivityLevels = {};
      for (const tile of tiles) if (tile in levels) mine[tile] = levels[tile]!;
      if (Object.keys(mine).length > 0) server.publishTo((c) => c === to, "terminal.activity", mine);
    }
  }
}
