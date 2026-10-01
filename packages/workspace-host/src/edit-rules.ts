/**
 * What someone may change in a workspace's layout by their role (design §6), on the machine that
 * keeps it: the host, for a peer's changes to its document, and a guest's own app, for the changes
 * its windows make to its copy, so that they are not refused later.
 *
 * Editing the board is moving, sizing, naming and grouping what is on it. A tile that runs
 * something on the host (a terminal, an agent, a browser page) is started by placing it: adding
 * one, taking one away, or changing what it runs or which frame it is in is driving agents. Where
 * a frame's tiles run (its folder, its worktree, the frame it is nested in) is the owner's to say.
 * The owner, at any of their devices, may change anything.
 *
 * But anyone who may edit the board may put a frame of their own on their own machine (M4, design
 * §5.4): a new frame whose folder is on their device and says nothing else of where it runs, and
 * the tiles in it, which run there, by them, and on nobody else's machine.
 */
import { parseDeviceUri } from "@hivemind/core/remote-uri";
import { ROLES, type Access } from "./access.js";
import type { CoreLayout, FrameRecord, TileRecord } from "@hivemind/workspace-doc/shapes";

/** Tiles that run nothing: they show the workspace's files, history, issues or a plan. */
const INERT = new Set(["editor", "diff", "issues", "planReview", "workbench"]);
/** What a tile that runs something runs: changing one starts something else. */
const RUNS = ["kind", "cmd", "args", "session", "url"] as const;
/** Where a frame's tiles run. */
const WHERE = ["workspacePath", "worktreePath", "workspaceRoot", "branch", "parentFrameId"] as const;

type Fields = Record<string, unknown>;
const runs = (tile: TileRecord): boolean => !INERT.has(tile.kind);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const drives = (access: Access): boolean => access === "owner" || ROLES.indexOf(access) >= ROLES.indexOf("agents");
const placed = (frame: FrameRecord): boolean => WHERE.some((f) => (frame as unknown as Fields)[f] != null);
/** The records of a layout's list, whatever it was given: a layout not yet checked may be anything. */
const records = <T extends { id: string }>(list: unknown): Map<string, T> =>
  new Map((Array.isArray(list) ? list : []).filter((r): r is T => typeof r?.id === "string").map((r) => [r.id, r]));

/** Why `access` may not make the layout `after` of `before` (null: it may), `device` being the
 *  device they make it from. Someone who may not edit the board at all is not asked about: their
 *  changes are not taken. */
export function refusedEdit(before: CoreLayout | null, after: CoreLayout | null, access: Access, device?: string): string | null {
  if (access === "owner") return null;
  const was = { frames: records<FrameRecord>(before?.frames), tiles: records<TileRecord>(before?.tiles) };
  const now = { frames: records<FrameRecord>(after?.frames), tiles: records<TileRecord>(after?.tiles) };
  /** A frame on their own machine, and nothing else said of where it runs. */
  const theirs = (frame: FrameRecord | undefined): boolean => {
    if (!frame || !device || typeof frame.workspacePath !== "string") return false;
    return parseDeviceUri(frame.workspacePath)?.device === device && WHERE.every((f) => f === "workspacePath" || (frame as unknown as Fields)[f] == null);
  };

  for (const [id, frame] of now.frames) {
    const old = was.frames.get(id);
    const moved = old ? WHERE.some((f) => !same((old as unknown as Fields)[f], (frame as unknown as Fields)[f])) : placed(frame);
    // Their own frame on their own machine: a new one, or one that was theirs already.
    if (moved && !(theirs(frame) && (!old || theirs(old)))) return `where frame ${id} runs is the owner's to say`;
  }
  for (const [id, frame] of was.frames) {
    if (!now.frames.has(id) && placed(frame) && !theirs(frame)) return `frame ${id} runs its tiles in a folder: taking it away is the owner's`;
  }

  if (drives(access)) return null;
  /** A tile in a frame of theirs, before and after: it runs on their machine. */
  const onTheirs = (id: string): boolean => {
    const wasIn = was.frames.get(before?.frameOf?.[id] ?? "");
    const isIn = now.frames.get(after?.frameOf?.[id] ?? "");
    return (!was.tiles.has(id) || theirs(wasIn)) && (!now.tiles.has(id) || theirs(isIn));
  };
  for (const [id, tile] of now.tiles) {
    const old = was.tiles.get(id);
    if (onTheirs(id)) continue;
    if (!old) {
      if (runs(tile)) return `adding tile ${id}, which runs on the host, is driving agents`;
      continue;
    }
    if (!runs(old) && !runs(tile)) continue;
    const changed = RUNS.find((f) => !same((old as unknown as Fields)[f], (tile as unknown as Fields)[f]));
    if (changed) return `changing what tile ${id} runs (${changed}) is driving agents`;
    if (!same(before?.frameOf?.[id], after?.frameOf?.[id])) return `moving tile ${id} to another frame changes where it runs: that is driving agents`;
  }
  for (const [id, tile] of was.tiles) {
    if (!now.tiles.has(id) && runs(tile) && !onTheirs(id)) return `closing tile ${id}, which runs on the host, is driving agents`;
  }
  return null;
}
