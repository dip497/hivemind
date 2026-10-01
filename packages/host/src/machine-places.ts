/**
 * What this machine's person placed on it in workspaces hosted elsewhere (M4, design §5.4): the
 * tiles they put in a frame of theirs on this machine, and what each runs, as they put it there.
 * Nothing in a workspace's document starts anything on this machine: the document is its host's,
 * whose owner may change it. A tile in a frame here runs only as this person placed it, and one
 * someone else put there does not run at all (until it is theirs to start: M4 step 2).
 *
 * What is placed is learned from this machine's own windows' writes to their copy of the
 * workspace, never from the host's: a tile a window here adds to a frame on this machine is this
 * person's, with what it runs; what runs in it changes only by a window here too; and it is
 * forgotten when a window here takes it away, or puts it in a frame that is not on this machine.
 * Kept in a file of this machine's (0600), so it holds across restarts.
 */
import fs from "node:fs";
import path from "node:path";
import { parseDeviceUri } from "@hivemind/core/remote-uri";
import type { CoreLayout, FrameRecord, TileRecord } from "@hivemind/workspace-doc/shapes";

/** What a tile runs, as its person placed it here. */
export interface Placed {
  kind: string;
  cmd: string | null;
  args: string[] | null;
}

export interface MachinePlacesOptions {
  /** Where they are kept. */
  file: string;
  /** This machine, as a frame's folder names it (`machine://<device>/path`). */
  device: string;
  onWarn?(message: string): void;
}

/** Tiles that run nothing. */
const INERT = new Set(["editor", "diff", "issues", "planReview", "workbench"]);

type Kept = Record<string, Record<string, Placed>>;

export class MachinePlaces {
  private kept: Kept | null = null;

  constructor(private readonly o: MachinePlacesOptions) {}

  /** A window here changed its copy of `workspace` from `before` to `after`: what it placed in a
   *  frame on this machine is this person's; what it took away, or out of this machine, is not. */
  wrote(workspace: string, before: CoreLayout | null, after: CoreLayout): void {
    const kept = this.read();
    const mine = { ...(kept[workspace] ?? {}) };
    const frames = new Map((Array.isArray(after.frames) ? after.frames : []).map((f: FrameRecord) => [f.id, f]));
    const was = new Set((Array.isArray(before?.tiles) ? before!.tiles : []).map((t: TileRecord) => t.id));
    const here = (tile: TileRecord): boolean => {
      const frame = frames.get(after.frameOf?.[tile.id] ?? "");
      return typeof frame?.workspacePath === "string" && parseDeviceUri(frame.workspacePath)?.device === this.o.device;
    };
    const now = new Map((Array.isArray(after.tiles) ? after.tiles : []).map((t: TileRecord) => [t.id, t]));
    let changed = false;
    for (const [id, tile] of now) {
      if (INERT.has(tile.kind) || !here(tile)) continue;
      // A tile someone else put here is not made this person's by a window here keeping it.
      if (was.has(id) && !mine[id]) continue;
      const args = (tile as TileRecord & { args?: unknown }).args;
      const placed: Placed = { kind: tile.kind, cmd: typeof tile.cmd === "string" ? tile.cmd : null, args: Array.isArray(args) && args.every((a) => typeof a === "string") ? args : null };
      if (JSON.stringify(mine[id]) === JSON.stringify(placed)) continue;
      mine[id] = placed;
      changed = true;
    }
    for (const id of Object.keys(mine)) {
      const tile = now.get(id);
      if (tile && here(tile)) continue;
      // Taken away by a window here, or put where it does not run here: forgotten. One the host
      // took away is forgotten too, when a window here next writes.
      delete mine[id];
      changed = true;
    }
    if (!changed) return;
    if (Object.keys(mine).length > 0) kept[workspace] = mine;
    else delete kept[workspace];
    this.write(kept);
  }

  /** What this person placed as `tile` of `workspace` here, to run as they placed it; null when
   *  nobody here placed it. */
  placed(workspace: string, tile: string): Placed | null {
    return this.read()[workspace]?.[tile] ?? null;
  }

  private read(): Kept {
    if (this.kept) return this.kept;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.o.file, "utf8")) as unknown;
      this.kept = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Kept) : {};
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.o.onWarn?.(`what was placed here could not be read (${e instanceof Error ? e.message : String(e)}): nothing placed here runs until it is placed again`);
      this.kept = {};
    }
    return this.kept;
  }

  private write(kept: Kept): void {
    this.kept = kept;
    try {
      fs.mkdirSync(path.dirname(this.o.file), { recursive: true });
      const tmp = `${this.o.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(kept), { mode: 0o600 });
      fs.renameSync(tmp, this.o.file);
    } catch (e) {
      this.o.onWarn?.(`what was placed here could not be kept (${e instanceof Error ? e.message : String(e)})`);
    }
  }
}
