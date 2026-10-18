/**
 * Frames opened and closed by whoever drives a workspace (0.20; spec/workspace-api.md `frame.*`):
 * one bound to a folder of the workspace, or to a git worktree of it on a branch, made when it is
 * not there yet.
 */

/** What `frame.open` opens: `path`, a folder; or `worktree`, a branch of the repo in a worktree of
 *  its own (`base`: where a new branch starts). `machine`: the machine `path` is on, a saved machine
 *  or another of the person's devices, by its id or its name (0.30; default: this one). `title`:
 *  its name (default: the folder's or the branch's). `parent`: the frame to nest it in (default for
 *  a worktree: the workspace's own). */
export interface FrameSpec {
  path?: string;
  machine?: string;
  worktree?: { branch: string; base?: string };
  title?: string;
  parent?: string;
}

/** The frame, the folder it runs in (`machine://<machine>/<path>` on another machine), and
 *  whether this call made the frame or the worktree. */
export interface FrameOpened {
  frame: string;
  path: string;
  opened: boolean;
  created: boolean;
}

/** `closeTiles`: end the frame's tiles too (otherwise a frame that holds tiles is not closed).
 *  `removeWorktree`: remove its worktree from disk (git refuses one with changes unless `force`). */
export interface FrameClose {
  closeTiles?: boolean;
  removeWorktree?: boolean;
  force?: boolean;
}

export interface FrameClosed {
  closed: string[];
  tilesClosed: number;
  worktreeRemoved: boolean;
}
