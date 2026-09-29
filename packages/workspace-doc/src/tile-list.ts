/**
 * A workspace as the control plane lists it (docs/design/multiplayer-2026-09-28.md, R5): which
 * frame a name means, what a tile is called, and the tiles grouped by frame. One copy, used by
 * the window now and by main once the control plane's canvas verbs run there, so `hive ctl list`
 * and every surface that names a tile agree. No Node and no Loro: the window imports it.
 */

/** A frame, as far as the list reads it. */
export interface FrameListing {
  id: string;
  title: string;
  /** The branch its tiles run on, when it is a worktree's. */
  branch?: string;
  worktreePath?: string;
  workspacePath?: string;
}

/** A tile, as far as the list reads it. */
export interface TileListing {
  id: string;
  kind: string;
  label: string;
  /** What an agent was started to do, from its first prompt. */
  task?: string;
}

/** What a workspace holds that the list reads. */
export interface ListedWorkspace<T extends TileListing = TileListing> {
  frames: readonly FrameListing[];
  tiles: readonly T[];
  /** The frame each tile is in, by tile. */
  frameOf: Readonly<Record<string, string>>;
  /** The names people gave tiles, by tile. */
  names: Readonly<Record<string, string>>;
}

/** What only the running app knows about its tiles. */
export interface TileFacts<T extends TileListing = TileListing> {
  /** What a tile is doing now; null before anything is known. */
  status: (tileId: string) => string | null;
  /** What each tile's agent says it is doing, by tile. */
  titles: Readonly<Record<string, string>>;
  /** The agent that runs in a tile, when one does. */
  agent: (tile: T) => string | undefined;
}

export interface ListedTile {
  tileId: string;
  kind: string;
  label: string;
  status: string | null;
  name: string;
  agent?: string;
}

export interface ListedFrame {
  frameId: string;
  title: string;
  /** The folder its tiles run in: its worktree, else the repository it is bound to. */
  repo: string | null;
  branch: string | null;
  tiles: ListedTile[];
}

export interface FrameSummary {
  id: string;
  title: string;
  repo: string | null;
  branch: string | null;
  /** How many tiles it holds. */
  tiles: number;
}

type Named = { id: string; label?: string; task?: string };

/** What a tile is called, everywhere it is shown: the name someone gave it, else what it is
 *  doing (what its agent says, else what it was started to do), else its label. The label is
 *  the fallback, not a prefix: "claude #3" says nothing a glance at the tile does not. */
export function tileName(names: Readonly<Record<string, string>>, titles: Readonly<Record<string, string>>, t: Named & { label: string }): string;
export function tileName(names: Readonly<Record<string, string>>, titles: Readonly<Record<string, string>>, t: Named): string | undefined;
export function tileName(names: Readonly<Record<string, string>>, titles: Readonly<Record<string, string>>, t: Named): string | undefined {
  return names[t.id] || titles[t.id] || t.task || t.label;
}

/** The frame `query` names, the most specific reading first: its id, its title in any case, the
 *  folder it is bound to, then a title that contains it. */
export function frameFor<F extends FrameListing>(frames: readonly F[], query: string): F | undefined {
  const byId = frames.find((f) => f.id === query);
  if (byId) return byId;
  const q = query.toLowerCase();
  const folder = (p?: string) => p?.split("/").filter(Boolean).pop()?.toLowerCase();
  return frames.find((f) => f.title.toLowerCase() === q)
    ?? frames.find((f) => folder(f.worktreePath) === q || folder(f.workspacePath) === q)
    ?? frames.find((f) => f.title.toLowerCase().includes(q));
}

const repoOf = (f: FrameListing): string | null => f.worktreePath ?? f.workspacePath ?? null;

/** The tiles, grouped by the frame each is in: a frame with none is left out, and a tile in no
 *  frame, or in one that is gone, is loose. Given a frame, that frame alone, even with none. */
export function listTiles<T extends TileListing>(
  ws: ListedWorkspace<T>, facts: TileFacts<T>, only?: FrameListing,
): { frames: ListedFrame[]; loose: ListedTile[] } {
  const listed = (t: T): ListedTile => {
    const agent = facts.agent(t);
    return { tileId: t.id, kind: t.kind, label: t.label, status: facts.status(t.id), name: tileName(ws.names, facts.titles, t), ...(agent ? { agent } : {}) };
  };
  const group = (f: FrameListing): ListedFrame => ({
    frameId: f.id, title: f.title, repo: repoOf(f), branch: f.branch ?? null,
    tiles: ws.tiles.filter((t) => ws.frameOf[t.id] === f.id).map(listed),
  });
  if (only) return { frames: [group(only)], loose: [] };
  const frameIds = new Set(ws.frames.map((f) => f.id));
  return {
    frames: ws.frames.map(group).filter((g) => g.tiles.length > 0),
    loose: ws.tiles.filter((t) => !frameIds.has(ws.frameOf[t.id] ?? "")).map(listed),
  };
}

/** Every frame: where its tiles run, and how many it holds. */
export function listFrames(ws: Pick<ListedWorkspace, "frames" | "tiles" | "frameOf">): FrameSummary[] {
  return ws.frames.map((f) => ({
    id: f.id, title: f.title, repo: repoOf(f), branch: f.branch ?? null,
    tiles: ws.tiles.filter((t) => ws.frameOf[t.id] === f.id).length,
  }));
}
