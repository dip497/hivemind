/**
 * Each tile's last line, for the rows that show it (docs/design/last-line-2026-10-23.md §1): what
 * its screen last showed with text, as main tells this window. The window watches the tiles a row
 * listens to now, all of them together (`tile.watchLines`, which replaces what it watched before):
 * one call when a row comes or goes, none while the tiles are the same, and an empty watch once
 * the last row goes, so main sends nothing to a window whose Layers panel is hidden. A tile no
 * longer watched forgets its line here; main answers a new watch with each tile's line now.
 */
import type { LastLines } from "@hivemind/workspace-api/terminals";

class LineStore {
  private readonly lines = new Map<string, string>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private queued = false;
  /** The tiles main was last told, as one key; null before it was told any. */
  private watched: string | null = null;
  private following: (() => void) | null = null;

  /** `tile`'s line: "" while its screen shows none, undefined before main told one. */
  get(tile: string): string | undefined {
    return this.lines.get(tile);
  }

  /** Called each time `tile`'s line changes; the tile is watched while anything listens to it. */
  subscribe(tile: string, l: () => void): () => void {
    let set = this.listeners.get(tile);
    if (!set) {
      this.listeners.set(tile, (set = new Set()));
      this.sync();
    }
    set.add(l);
    return () => {
      set!.delete(l);
      if (set!.size > 0 || this.listeners.get(tile) !== set) return;
      this.listeners.delete(tile);
      this.sync();
    };
  }

  /** A window that reloads keeps its connection (workspace-ipc.ts), and main the watch it had: as
   *  the window loads, main is told what it watches now, nothing until a row asks. */
  start(): void {
    this.sync();
  }

  /** After the rows that mount or unmount together, main is told the tiles listened to now. */
  private sync(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      const tiles = [...this.listeners.keys()].sort();
      const key = tiles.join("\n");
      if (key === this.watched) return;
      this.watched = key;
      for (const tile of this.lines.keys()) if (!this.listeners.has(tile)) this.lines.delete(tile);
      if (tiles.length) this.following ??= window.hive.onTileLines(({ lines }) => this.apply(lines));
      else { this.following?.(); this.following = null; }
      void window.hive.tileLinesWatch(tiles).then(({ lines }) => this.apply(lines), () => { /* an older host has no lines */ });
    });
  }

  private apply(lines: LastLines): void {
    for (const [tile, line] of Object.entries(lines)) {
      const set = this.listeners.get(tile);
      if (!set || this.lines.get(tile) === line) continue;
      this.lines.set(tile, line);
      for (const l of set) l();
    }
  }
}

export const tileLines = new LineStore();
// Not where the renderer's modules run without a window (unit tests).
if (typeof window !== "undefined" && window.hive) tileLines.start();
