/**
 * TanStack Query bindings over the real IPC bridge.
 *
 * `window.hive` is either the Electron preload IPC (production) or an
 * HTTP shim that hits a local dev backend (for browser testing — the
 * backend still runs the REAL git-adapter and hive-core, just over HTTP
 * instead of IPC). Either way, nothing here is mocked.
 */
import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  DiffPayload,
  DiffScope,
  GitStatusSnapshot,
  WorktreeCreateOpts,
  WorktreeEntry,
} from "../../shared/ipc";

/// <reference path="./preload-types.d.ts" />

/** True when running inside Electron (preload-bridged `window.hive` exists). */
export const inElectron =
  typeof window !== "undefined" && !!(window as unknown as { hive?: unknown }).hive;

// ── project / issues ────────────────────────────────────────────

export function useProject(rootHint?: string | null) {
  return useQuery<{ root: string | null; cwd: string; repoPath: string | null }>({
    // Including rootHint in the key means picking a different folder
    // refetches automatically.
    queryKey: ["project", rootHint ?? null],
    queryFn: () => window.hive.resolveProject(rootHint ?? undefined),
  });
}

// ── git status / diff ────────────────────────────────────────────────────

export function useGitStatus(repoPath: string | null | undefined) {
  return useQuery<GitStatusSnapshot | null>({
    queryKey: ["git:status", repoPath],
    queryFn: () => (repoPath ? window.hive.gitStatus(repoPath) : Promise.resolve(null)),
    enabled: !!repoPath,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/** Current branch ONLY — a SEPARATE query from useGitStatus on purpose. The
 *  branch changes only on checkout, so this carries a long staleTime and stays
 *  OUT of the 200ms fs-changed invalidation storm that hammers git:status while
 *  an agent writes files. Refreshed only when .git/HEAD changes (see
 *  useFsChangedInvalidation). Safe to call per frame node — React-Query dedupes
 *  by key, so N frames on one repo share one fetch and re-render only when the
 *  branch actually changes, NOT on every file write. */
export function useGitBranch(repoPath: string | null | undefined) {
  return useQuery<string | null>({
    queryKey: ["git:branch", repoPath],
    queryFn: async () => (repoPath ? (await window.hive.gitStatus(repoPath)).branch : null),
    enabled: !!repoPath,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useGitListFiles(repoPath: string | null | undefined) {
  return useQuery<string[]>({
    queryKey: ["git:list-files", repoPath],
    queryFn: () => (repoPath ? window.hive.gitListFiles(repoPath) : Promise.resolve([])),
    enabled: !!repoPath,
    // Path list changes only on fs add/remove — invalidated by useFsChangedInvalidation.
    staleTime: 30_000,
  });
}

export function useGitDiff(
  repoPath: string | null | undefined,
  scope: DiffScope,
  file?: string
) {
  return useQuery<DiffPayload | null>({
    queryKey: ["git:diff", repoPath, scope, file ?? null],
    queryFn: () =>
      repoPath ? window.hive.gitDiff(repoPath, scope, file) : Promise.resolve(null),
    enabled: !!repoPath,
    // Git diff errors are deterministic (bad base ref, detached HEAD) — retrying
    // just leaves the tile on "loading…" for seconds. Fail fast.
    retry: false,
  });
}

export function useStageFiles() {
  const qc = useQueryClient();
  return useMutation<void, Error, { repoPath: string; files: string[] }>({
    mutationFn: ({ repoPath, files }) => window.hive.gitStage(repoPath, files),
    onSuccess: (_d, { repoPath, files }) => {
      qc.invalidateQueries({ queryKey: ["git:status", repoPath] });
      toast.success(`staged ${files.length === 1 ? files[0] : `${files.length} files`}`);
    },
    onError: (e, { files }) => toast.error(`stage failed: ${files[0] ?? ""}`, { description: e.message }),
  });
}

export function useUnstageFiles() {
  const qc = useQueryClient();
  return useMutation<void, Error, { repoPath: string; files: string[] }>({
    mutationFn: ({ repoPath, files }) => window.hive.gitUnstage(repoPath, files),
    onSuccess: (_d, { repoPath, files }) => {
      qc.invalidateQueries({ queryKey: ["git:status", repoPath] });
      toast.success(`unstaged ${files.length === 1 ? files[0] : `${files.length} files`}`);
    },
    onError: (e, { files }) => toast.error(`unstage failed: ${files[0] ?? ""}`, { description: e.message }),
  });
}

export function useDiscardFiles() {
  const qc = useQueryClient();
  return useMutation<void, Error, { repoPath: string; files: string[] }>({
    mutationFn: ({ repoPath, files }) => window.hive.gitDiscard(repoPath, files),
    onSuccess: (_d, { repoPath, files }) => {
      qc.invalidateQueries({ queryKey: ["git:status", repoPath] });
      qc.invalidateQueries({ queryKey: ["git:diff", repoPath] });
      toast.success(`discarded ${files.length === 1 ? files[0] : `${files.length} files`}`);
    },
    onError: (e, { files }) => toast.error(`discard failed: ${files[0] ?? ""}`, { description: e.message }),
  });
}

export function useGitCommit() {
  const qc = useQueryClient();
  return useMutation<{ sha: string }, Error, { repoPath: string; message: string }>({
    mutationFn: ({ repoPath, message }) => window.hive.gitCommit(repoPath, message),
    onSuccess: (d, { repoPath }) => {
      qc.invalidateQueries({ queryKey: ["git:status", repoPath] });
      qc.invalidateQueries({ queryKey: ["git:diff", repoPath] });
      toast.success(`committed ${d.sha.slice(0, 7)}`);
    },
    onError: (e) => toast.error("commit failed", { description: e.message }),
  });
}

export function useGitPush() {
  const qc = useQueryClient();
  return useMutation<void, Error, { repoPath: string; setUpstream?: boolean }>({
    mutationFn: ({ repoPath, setUpstream }) => window.hive.gitPush(repoPath, setUpstream),
    onSuccess: (_d, { repoPath }) => {
      qc.invalidateQueries({ queryKey: ["git:status", repoPath] });
      toast.success("pushed");
    },
    onError: (e) => toast.error("push failed", { description: e.message }),
  });
}

export function useGitPull() {
  const qc = useQueryClient();
  return useMutation<void, Error, { repoPath: string }>({
    mutationFn: ({ repoPath }) => window.hive.gitPull(repoPath),
    onSuccess: (_d, { repoPath }) => {
      // A pull can change files, the branch head, and ahead/behind — refresh
      // status, branch, diff, and the file list so every git-aware tile updates.
      qc.invalidateQueries({ queryKey: ["git:status", repoPath] });
      qc.invalidateQueries({ queryKey: ["git:branch", repoPath] });
      qc.invalidateQueries({ queryKey: ["git:diff", repoPath] });
      qc.invalidateQueries({ queryKey: ["git:list-files", repoPath] });
      toast.success("pulled");
    },
    // --ff-only fails when the branch has diverged; say so instead of a raw
    // git error, since the fix (reconcile in a terminal) isn't obvious.
    onError: (e) =>
      toast.error("pull failed", {
        description: /not possible to fast-forward|diverg/i.test(e.message)
          ? "Branch has diverged — reconcile in a terminal (merge/rebase)."
          : e.message,
      }),
  });
}

// ── worktree ─────────────────────────────────────────────────────────────

export function useWorktrees(repoPath: string | null | undefined) {
  return useQuery<WorktreeEntry[]>({
    queryKey: ["worktrees", repoPath],
    queryFn: () => (repoPath ? window.hive.worktreeList(repoPath) : Promise.resolve([])),
    enabled: !!repoPath,
  });
}

export function useCreateWorktree() {
  const qc = useQueryClient();
  return useMutation<
    { path: string; branch: string },
    Error,
    { repoPath: string; opts: WorktreeCreateOpts }
  >({
    mutationFn: ({ repoPath, opts }) => window.hive.worktreeCreate(repoPath, opts),
    onSuccess: (d, { repoPath }) => {
      qc.invalidateQueries({ queryKey: ["worktrees", repoPath] });
      toast.success(`worktree created`, { description: `${d.branch} → ${d.path}` });
    },
    onError: (e) => toast.error("worktree create failed", { description: e.message }),
  });
}

export function useRemoveWorktree() {
  const qc = useQueryClient();
  return useMutation<void, Error, { repoPath: string; worktreePath: string; force?: boolean }>({
    mutationFn: ({ repoPath, worktreePath, force }) =>
      window.hive.worktreeRemove(repoPath, worktreePath, force),
    onSuccess: (_d, { repoPath, worktreePath }) => {
      qc.invalidateQueries({ queryKey: ["worktrees", repoPath] });
      toast.success(`worktree removed`, { description: worktreePath });
    },
    onError: (e) => toast.error("worktree remove failed", { description: e.message }),
  });
}

// ── fs:changed subscription → Query cache invalidation ───────────────────

export function useFsChangedInvalidation(
  repoPath: string | null | undefined,
  root?: string | null,
) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!repoPath) return;
    // Coalesce bursts: when an agent rewrites many files, the watcher fires
    // repeatedly. Without this, each event re-fetches git status/diff and the
    // DiffTile re-parses every file — a refetch storm that stutters typing /
    // agent output. Batch the work flags and flush once per ~200ms idle window.
    let gitPending = false;
    let hivePending = false;
    let headPending = false;
    let projectPending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      if (projectPending) {
        // A `.hivemind/` appeared in a folder that resolved to "No workspace"
        // (e.g. you just ran `hive init`). Re-run the project resolution so the
        // freshly-created tracker is picked up live — no app restart needed.
        qc.invalidateQueries({ queryKey: ["project"] });
        projectPending = false;
      }
      if (gitPending) {
        // A diff tile on this repo invalidates the same keys: share its fetch.
        const join = { cancelRefetch: false };
        qc.invalidateQueries({ queryKey: ["git:status", repoPath] }, join);
        qc.invalidateQueries({ queryKey: ["git:diff", repoPath] }, join);
        qc.invalidateQueries({ queryKey: ["git:list-files", repoPath] }, join);
        qc.invalidateQueries({ queryKey: ["worktrees", repoPath] });
        gitPending = false;
      }
      if (headPending) {
        // Branch only — kept off the every-file-write path; HEAD moves only on
        // checkout/commit, so this refreshes the frame branch badge rarely.
        qc.invalidateQueries({ queryKey: ["git:branch", repoPath] });
        headPending = false;
      }
      if (hivePending) {
        // Scope to THIS workspace's root. A bare ["issues"] prefix-nukes every
        // open workspace board on a single .hivemind write — pathological with
        // the multi-workspace canvas while an agent edits issues. Fall back to
        // the broad invalidation only when we don't know the root.
        if (root) {
          qc.invalidateQueries({ queryKey: ["issues", root] });
          qc.invalidateQueries({ queryKey: ["issue", root] });
        } else {
          qc.invalidateQueries({ queryKey: ["issues"] });
          qc.invalidateQueries({ queryKey: ["issue"] });
        }
        hivePending = false;
      }
    };
    const unsub = window.hive.onFsChanged(repoPath, ({ paths }) => {
      // Match `.hivemind/` (issue files an AGENT writes via hive_set_state) and
      // `.git/` anywhere in the path, not just at exactly repoPath — robust when
      // the workspace root differs from the git root.
      const touchedGit = paths.some((p) => p.includes("/.git/"));
      const touchedHive = paths.some((p) => p.includes("/.hivemind/"));
      // HEAD moves on checkout/commit (a branch change). Match `.git/HEAD` and a
      // worktree's `.git` file pointer flips too — keep it narrow.
      const touchedHead = paths.some((p) => p.endsWith("/.git/HEAD") || p.endsWith("/HEAD"));
      // .git change OR any working-tree change ⇒ git views are stale.
      if (touchedGit || !touchedHive) gitPending = true;
      if (touchedHive) hivePending = true;
      if (touchedHead) headPending = true;
      // No workspace resolved yet + a `.hivemind/` just appeared ⇒ re-resolve the
      // project. Gated on `!root` so once a workspace exists we don't re-resolve on
      // every agent issue-write (that path only refreshes the issues board above).
      if (touchedHive && !root) projectPending = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 200);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, [repoPath, root, qc]);
}
