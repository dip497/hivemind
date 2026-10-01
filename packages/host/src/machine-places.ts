/**
 * What this machine's person placed on it in workspaces hosted elsewhere (M4, design §5.4): the
 * tiles they put in a frame of theirs on this machine, and what each runs, as they put it there.
 * Nothing in a workspace's document starts anything on this machine: the document is its host's,
 * whose owner may change it. A tile in a frame here runs only as this person placed it, and one
 * someone else put there does not run at all, until this person lets the people in that workspace
 * run terminals and agents here: then it is theirs to start (`othersRun`), as the document says.
 *
 * What is placed is learned from this machine's own windows' writes to their copy of the
 * workspace, never from the host's: a tile a window here adds to a frame on this machine is this
 * person's, with what it runs; what runs in it changes only by a window here too; and it is
 * forgotten when a window here takes it away, or puts it in a frame that is not on this machine.
 *
 * And what this person lets the people in that workspace do on this machine (`Grant`): watch what
 * they placed here, as everyone may; type into it too; or run terminals and agents here as well.
 * Theirs alone to give and take back, here. Kept in a file of this machine's (0600), so it holds
 * across restarts.
 */
import fs from "node:fs";
import path from "node:path";
import { parseDeviceUri } from "@hivemind/core/remote-uri";
import { isTerminalKind, type CoreLayout, type FrameRecord, type TileRecord } from "@hivemind/workspace-doc/shapes";
import { GRANTS, grants, type Grant } from "./machine-share.js";

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

interface Kept {
  /** By workspace, by tile. */
  placed: Record<string, Record<string, Placed>>;
  /** By workspace; watch where none is said. */
  grants: Record<string, Grant>;
}

export class MachinePlaces {
  private kept: Kept | null = null;
  private readonly granted = new Set<(workspace: string) => void>();

  constructor(private readonly o: MachinePlacesOptions) {}

  /** What the people in `workspace` may do on this machine. */
  grant(workspace: string): Grant {
    return this.read().grants[workspace] ?? "watch";
  }

  /** Let the people in `workspace` do `grant` on this machine from now on; each listener is told. */
  setGrant(workspace: string, grant: Grant): void {
    const kept = this.read();
    if (this.grant(workspace) === grant) return;
    if (grant === "watch") delete kept.grants[workspace];
    else kept.grants[workspace] = grant;
    this.write(kept);
    for (const l of this.granted) l(workspace);
  }

  /** Hear each workspace whose grant changes. */
  onGrant(listener: (workspace: string) => void): () => void {
    this.granted.add(listener);
    return () => { this.granted.delete(listener); };
  }

  /** A window here changed its copy of `workspace` from `before` to `after`: what it placed in a
   *  frame on this machine is this person's; what it took away, or out of this machine, is not. */
  wrote(workspace: string, before: CoreLayout | null, after: CoreLayout): void {
    const kept = this.read();
    const mine = { ...(kept.placed[workspace] ?? {}) };
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
    if (Object.keys(mine).length > 0) kept.placed[workspace] = mine;
    else delete kept.placed[workspace];
    this.write(kept);
  }

  /** What `tile` of `workspace` runs on this machine when someone else put it in a frame of this
   *  person's here, while they let the people there run terminals and agents here: that frame's
   *  folder, and the program `core` (this machine's copy of the workspace's document) says, `shell`
   *  where it names none. Null for any other: one this person placed (it runs as they placed it),
   *  one that shows a session it did not start, one that is not a terminal's or an agent's, one in
   *  a frame elsewhere, and any while they do not let them. */
  othersRun(workspace: string, core: CoreLayout | null, tile: string, shell: { cmd: string; args: string[] }): { cwd: string; cmd: string; args: string[] } | null {
    if (!core || !grants(this.grant(workspace), "agents") || this.placed(workspace, tile)) return null;
    const t = (Array.isArray(core.tiles) ? core.tiles : []).find((x: TileRecord) => x.id === tile);
    const frame = (Array.isArray(core.frames) ? core.frames : []).find((f: FrameRecord) => f.id === core.frameOf?.[tile]);
    const at = typeof frame?.workspacePath === "string" ? parseDeviceUri(frame.workspacePath) : null;
    if (!t || !isTerminalKind(t.kind) || t.session || at?.device !== this.o.device) return null;
    const args = (t as TileRecord & { args?: unknown }).args;
    const cmd = typeof t.cmd === "string" ? t.cmd : null;
    return { cwd: at.path, cmd: cmd ?? shell.cmd, args: Array.isArray(args) && args.every((a) => typeof a === "string") ? args : cmd ? [] : shell.args };
  }

  /** What this person placed as `tile` of `workspace` here, to run as they placed it; null when
   *  nobody here placed it. */
  placed(workspace: string, tile: string): Placed | null {
    return this.read().placed[workspace]?.[tile] ?? null;
  }

  private read(): Kept {
    if (this.kept) return this.kept;
    const map = (v: unknown): Record<string, never> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, never>) : {});
    try {
      const parsed = map(JSON.parse(fs.readFileSync(this.o.file, "utf8")));
      const grants = Object.fromEntries(Object.entries(map(parsed.grants)).filter(([, g]) => GRANTS.includes(g)));
      this.kept = { placed: map(parsed.placed), grants };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.o.onWarn?.(`what was placed here could not be read (${e instanceof Error ? e.message : String(e)}): nothing placed here runs until it is placed again, and nobody else may do more than watch`);
      this.kept = { placed: {}, grants: {} };
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
