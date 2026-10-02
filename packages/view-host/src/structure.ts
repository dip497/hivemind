/**
 * What a view is told the workspace holds (view protocol `structure`): its frames, each with its
 * colour, the machine it runs on, the frame it nests in, its branch and its folder; its tiles, each
 * with its frame, its name and the agent it runs; and the links between agents. One builder for
 * every host of a view: the window's, from its model, and a device's for a remote screen, from its
 * store (docs/design/phone-app-2026-10-02.md §6.1). No DOM and no Node: each host says how it
 * resolves a frame's colour and names its machine.
 */
import type { HostMessage, ViewFrameFolder, ViewFrameMachine } from "@hivemind/view-sdk/protocol";
import type { FrameListing, TileListing } from "@hivemind/workspace-doc/tile-list";

/** A frame, as `structure` reads it. */
export interface StructureFrame extends FrameListing {
  parentFrameId?: string;
}

/** A tile, as `structure` reads it. */
export type StructureTile = Pick<TileListing, "id" | "kind" | "label">;

export interface StructureSource<F extends StructureFrame, T extends StructureTile> {
  frames: readonly F[];
  tiles: readonly T[];
  /** The frame each tile is in, by tile. */
  frameOf: Readonly<Record<string, string>>;
  /** What a tile is called; none: its label. */
  name(tile: T): string | undefined;
  /** The agent an agent's tile runs, its catalog id. */
  agent(tile: T): string | undefined;
  links: { pipes: readonly { src: string; dst: string }[]; spawns: readonly { parent: string; child: string }[] };
  /** A frame's colour, `#rrggbb`. */
  color(frame: F): string;
  /** Where a frame runs, when that is another machine. */
  machine(frame: F): ViewFrameMachine | undefined;
}

export type Structure = Extract<HostMessage, { type: "structure" }>;

const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

/** The folder a frame is bound to, by its last path segment: the path itself stays with the host. */
function folderOf(f: StructureFrame): { folder?: ViewFrameFolder } {
  if (f.worktreePath) return { folder: { name: baseName(f.worktreePath), kind: "worktree" } };
  if (f.workspacePath) return { folder: { name: baseName(f.workspacePath), kind: "folder" } };
  return {};
}

/** The `structure` message for what `s` holds. */
export function viewStructure<F extends StructureFrame, T extends StructureTile>(s: StructureSource<F, T>): Structure {
  return {
    type: "structure",
    frames: s.frames.map((f) => {
      const machine = s.machine(f);
      return {
        id: f.id, title: f.title, color: s.color(f), ...(machine ? { machine } : {}),
        ...(f.parentFrameId ? { parentId: f.parentFrameId } : {}),
        ...(f.branch ? { branch: f.branch } : {}),
        ...folderOf(f),
      };
    }),
    tiles: s.tiles.map((t) => {
      const agent = s.agent(t);
      return { id: t.id, frameId: s.frameOf[t.id] ?? null, kind: t.kind, name: s.name(t) ?? t.label, ...(agent ? { agent } : {}) };
    }),
    links: { pipes: s.links.pipes.map(({ src, dst }) => ({ src, dst })), spawns: s.links.spawns.map(({ parent, child }) => ({ parent, child })) },
  };
}
