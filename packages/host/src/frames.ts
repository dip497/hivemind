/**
 * Frames opened and closed through the workspace API (`frame.open`, `frame.close`; 0.20), so
 * whoever drives a workspace can start agents in a folder of it or in a new worktree of it without
 * a window. The store holds the frame; a window shows it where it has room. A frame is found again
 * by its folder, so opening one twice gives the same frame. Electron-free.
 */
import fs from "node:fs";
import path from "node:path";
import type { FrameRecord, KeptCore } from "@hivemind/workspace-doc/shapes";
import type { FrameClose, FrameClosed, FrameOpened, FrameSpec } from "@hivemind/workspace-api/frames";
import { ApiError, flag, text } from "@hivemind/workspace-api/protocol";
import type { Connection, Domain } from "@hivemind/workspace-api/server";
import { mintId, toBareId } from "@hivemind/workspace-api/tile-id";
import type { WorktreeCreateOpts, WorktreeEntry } from "@hivemind/workspace-api/git";

/** How the store is written by a frame call: its windows hear of it. */
const FRAMES = { writer: "frames" };

export interface FramesOptions {
  store(): {
    repos(): string[];
    getCore(repo: string): KeptCore | null;
    addFrame(repo: string, frame: FrameRecord, from?: { writer?: string }): boolean;
    removeFrame(repo: string, frameId: string, from?: { writer?: string }): string[];
  };
  worktreeList(repo: string): Promise<WorktreeEntry[]>;
  worktreeCreate(repo: string, opts: WorktreeCreateOpts): Promise<{ path: string; branch: string }>;
  worktreeRemove(repo: string, worktree: string, force?: boolean): Promise<void>;
  /** End the session of the tile `bare` and take it off its board. */
  closeTile(bare: string): unknown;
}

/** A folder as it is on disk, links followed; as given when it is not there. */
function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** The folders a workspace's frames run in besides its repo: their worktrees, on this machine. */
export function frameWorktrees(core: KeptCore | null): string[] {
  return (core?.frames ?? []).flatMap((f) => (typeof f.worktreePath === "string" && path.isAbsolute(f.worktreePath) ? [f.worktreePath] : []));
}

/** Whether `p` is `root` or inside it. */
function inside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

const BRANCH = /^[A-Za-z0-9._/-]+$/;
const REV = /^[A-Za-z0-9._/~^-]+$/;

function specOf(value: unknown): FrameSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("BAD_REQUEST", "spec must be an object");
  const s = value as Record<string, unknown>;
  if ((s.path == null) === (s.worktree == null)) throw new ApiError("BAD_REQUEST", "spec names a path or a worktree, one of them");
  const spec: FrameSpec = {};
  if (s.path != null) {
    spec.path = text(s.path, "spec.path");
    if (!path.isAbsolute(spec.path)) throw new ApiError("BAD_REQUEST", "spec.path is a folder, given in full");
  } else {
    const w = s.worktree as Record<string, unknown> | null;
    if (!w || typeof w !== "object") throw new ApiError("BAD_REQUEST", "spec.worktree is {branch, base?}");
    const branch = text(w.branch, "spec.worktree.branch");
    if (branch.startsWith("-") || !BRANCH.test(branch) || branch.includes("..")) throw new ApiError("BAD_REQUEST", `invalid branch name: ${JSON.stringify(branch)}`);
    const base = w.base == null ? undefined : text(w.base, "spec.worktree.base");
    if (base !== undefined && (base.startsWith("-") || !REV.test(base) || base.includes(".."))) throw new ApiError("BAD_REQUEST", `invalid base: ${JSON.stringify(base)}`);
    spec.worktree = { branch, ...(base ? { base } : {}) };
  }
  if (s.title != null) spec.title = text(s.title, "spec.title");
  if (s.parent != null) spec.parent = text(s.parent, "spec.parent");
  return spec;
}

export function framesDomain(o: FramesOptions): Domain<"frame.open" | "frame.close"> {
  /** The layout of the workspace at `repo`; an empty one when it was never saved. */
  const coreOf = (repo: string): KeptCore => {
    if (!o.store().repos().includes(repo)) throw new ApiError("NOT_FOUND", `no workspace is open at ${repo}`);
    return o.store().getCore(repo) ?? { frames: [], tiles: [], tileNames: {}, editorTabs: {}, frameOf: {} };
  };
  /** The frame bound to the folder `folder`, if one is. */
  const boundTo = (core: KeptCore, folder: string): FrameRecord | undefined =>
    core.frames.find((f) => {
      const at = f.worktreePath ?? f.workspacePath;
      return typeof at === "string" && path.isAbsolute(at) && real(at) === real(folder);
    });
  /** The workspace's own frame, the one bound to its repo at the top. */
  const ownFrame = (core: KeptCore, repo: string): FrameRecord | undefined =>
    core.frames.find((f) => !f.parentFrameId && typeof f.workspacePath === "string" && real(f.workspacePath) === real(repo));
  /** A program or a guest names only the workspace's folders; the person, any. */
  const mayName = (from: Connection, repo: string, folder: string): boolean => {
    if (from.actor.kind !== "peer" || from.actor.access === "owner") return true;
    const target = real(folder);
    return [repo, ...frameWorktrees(o.store().getCore(repo))].some((root) => inside(real(root), target));
  };

  return {
    answers: {
      "frame.open": async (from, repo, spec): Promise<FrameOpened> => {
        const r = text(repo, "repo");
        if (!path.isAbsolute(r)) throw new ApiError("BAD_REQUEST", "frames are opened this way in workspaces on this machine");
        const s = specOf(spec);
        const core = coreOf(r);
        if (s.parent !== undefined && !core.frames.some((f) => f.id === s.parent)) throw new ApiError("NOT_FOUND", `no frame ${s.parent} in this workspace`);
        if (s.path !== undefined) {
          if (!mayName(from, r, s.path)) throw new ApiError("FORBIDDEN", "that folder is not of this workspace");
          if (!fs.statSync(s.path, { throwIfNoEntry: false })?.isDirectory()) throw new ApiError("BAD_REQUEST", `${s.path} is not a folder`);
          const there = boundTo(core, s.path);
          if (there) return { frame: there.id, path: s.path, opened: false, created: false };
          const frame: FrameRecord = { id: mintId("frame"), title: s.title ?? path.basename(s.path), workspacePath: s.path, ...(s.parent ? { parentFrameId: s.parent } : {}) };
          o.store().addFrame(r, frame, FRAMES);
          return { frame: frame.id, path: s.path, opened: true, created: false };
        }
        const { branch, base } = s.worktree!;
        // A worktree on that branch already: its frame, or a frame for it.
        const listed = (await o.worktreeList(r)).find((w) => w.branch === branch || w.branch === `refs/heads/${branch}`);
        let folder = listed?.path;
        let created = false;
        if (folder === undefined) {
          folder = (await o.worktreeCreate(r, { branch, ...(base ? { base } : {}) })).path;
          created = true;
        }
        const now = coreOf(r);
        const there = boundTo(now, folder);
        if (there) return { frame: there.id, path: folder, opened: false, created };
        const parent = s.parent ?? ownFrame(now, r)?.id;
        const frame: FrameRecord = { id: mintId("frame-wt"), title: s.title ?? branch, branch, worktreePath: folder, ...(parent ? { parentFrameId: parent } : {}) };
        o.store().addFrame(r, frame, FRAMES);
        return { frame: frame.id, path: folder, opened: true, created };
      },
      "frame.close": async (_from, repo, frameId, opts): Promise<FrameClosed> => {
        const r = text(repo, "repo");
        const id = text(frameId, "frame");
        const c = (opts ?? {}) as FrameClose;
        const closeTiles = flag(c.closeTiles, "opts.closeTiles") ?? false;
        const removeWorktree = flag(c.removeWorktree, "opts.removeWorktree") ?? false;
        const force = flag(c.force, "opts.force") ?? false;
        const core = coreOf(r);
        const frame = core.frames.find((f) => f.id === id);
        if (!frame) throw new ApiError("NOT_FOUND", `no frame ${id} in this workspace`);
        const under = new Set([id]);
        for (let grew = true; grew;) {
          grew = false;
          for (const f of core.frames) if (f.parentFrameId && under.has(f.parentFrameId) && !under.has(f.id)) { under.add(f.id); grew = true; }
        }
        const tiles = Object.entries(core.frameOf ?? {}).filter(([, f]) => under.has(f)).map(([t]) => t);
        if (tiles.length && !closeTiles) throw new ApiError("BAD_REQUEST", `frame ${id} holds ${tiles.length} tile${tiles.length === 1 ? "" : "s"}: close them first, or ask with closeTiles`);
        const worktrees = removeWorktree ? core.frames.filter((f) => under.has(f.id) && typeof f.worktreePath === "string").map((f) => f.worktreePath!) : [];
        // The worktrees go first: git refuses one with changes, and then nothing else is closed.
        for (const wt of worktrees) await o.worktreeRemove(r, wt, force);
        for (const t of tiles) await o.closeTile(toBareId(t));
        const closed = o.store().removeFrame(r, id, FRAMES);
        return { closed, tilesClosed: tiles.length, worktreeRemoved: worktrees.length > 0 };
      },
    },
    effects: {
      "frame.open": (repo, spec) => {
        const s = spec as FrameSpec | null;
        return { target: typeof repo === "string" ? repo : undefined, detail: s?.worktree?.branch ?? (typeof s?.path === "string" ? s.path : undefined) };
      },
      "frame.close": (_repo, frame) => ({ target: typeof frame === "string" ? frame : undefined }),
    },
  };
}
