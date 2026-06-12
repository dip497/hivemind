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
import type { Issue, IssueSummary, IssueState, LinkType } from "@hivemind/core/types";
import type {
  DiffPayload,
  DiffScope,
  GitStatusSnapshot,
  IssuePatch,
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

export function useIssues(root: string | null | undefined) {
  return useQuery<IssueSummary[]>({
    queryKey: ["issues", root],
    queryFn: () => (root ? window.hive.listIssues(root) : Promise.resolve([])),
    enabled: !!root,
  });
}

export function useIssue(root: string | null | undefined, id: string | undefined) {
  return useQuery<Issue | null>({
    queryKey: ["issue", root, id],
    queryFn: () =>
      root && id ? window.hive.readIssue(root, id) : Promise.resolve(null),
    enabled: !!root && !!id,
  });
}

export function useUpdateState() {
  const qc = useQueryClient();
  return useMutation<
    Issue,
    Error,
    { root: string; id: string; state: IssueState; note?: string },
    { prev?: IssueSummary[] }
  >({
    mutationFn: ({ root, id, state, note }) =>
      window.hive.updateIssueState(root, id, state, note),
    onError: (e, vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["issues", vars.root], ctx.prev);
      toast.error(`state update failed: ${vars.id}`, { description: e.message });
    },
    // Optimistic: paint new state immediately + sync peek cache so IssuePeek
    // dropdown updates instantly on drag-drop.
    onMutate: async ({ root, id, state }) => {
      await qc.cancelQueries({ queryKey: ["issues", root] });
      await qc.cancelQueries({ queryKey: ["issue", root, id] });
      const prev = qc.getQueryData<IssueSummary[]>(["issues", root]);
      qc.setQueryData<IssueSummary[]>(["issues", root], (old) =>
        old?.map((i) => (i.id === id ? { ...i, state } : i)) ?? old,
      );
      // Also patch the open peek cache so IssuePeek's state dropdown is instant.
      qc.setQueryData<Issue | null>(["issue", root, id], (old) =>
        old ? { ...old, state } : old,
      );
      return { prev };
    },
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: ["issues", vars.root] });
      qc.invalidateQueries({ queryKey: ["issue", vars.root, vars.id] });
    },
  });
}

// ── issue create / update / delete / comment ─────────────────────────────

type CreateIssueVars = {
  root: string;
  opts: Parameters<typeof window.hive.createIssue>[1];
};
export function useCreateIssue() {
  const qc = useQueryClient();
  return useMutation<Issue, Error, CreateIssueVars>({
    mutationFn: ({ root, opts }) => window.hive.createIssue(root, opts),
    onSuccess: (issue, { root }) => {
      qc.invalidateQueries({ queryKey: ["issues", root] });
      toast.success(`created ${issue.id}`, { description: issue.title });
    },
    onError: (e) => toast.error("create failed", { description: e.message }),
  });
}

type UpdateIssueVars = { root: string; id: string; patch: IssuePatch };
export function useUpdateIssue() {
  const qc = useQueryClient();
  return useMutation<Issue, Error, UpdateIssueVars, { prevList?: IssueSummary[]; prevIssue?: Issue | null }>({
    mutationFn: ({ root, id, patch }) => window.hive.updateIssue(root, id, patch),
    // Optimistic patch into both caches.
    onMutate: async ({ root, id, patch }) => {
      await qc.cancelQueries({ queryKey: ["issues", root] });
      await qc.cancelQueries({ queryKey: ["issue", root, id] });
      const prevList = qc.getQueryData<IssueSummary[]>(["issues", root]);
      const prevIssue = qc.getQueryData<Issue | null>(["issue", root, id]);
      qc.setQueryData<IssueSummary[]>(["issues", root], (old) =>
        old?.map((i) => {
          if (i.id !== id) return i;
          return {
            ...i,
            title: patch.title ?? i.title,
            state: patch.state ?? i.state,
            labels: patch.labels ?? i.labels,
            assignee: patch.assignee !== undefined ? patch.assignee : i.assignee,
          };
        }) ?? old,
      );
      qc.setQueryData<Issue | null>(["issue", root, id], (old) =>
        old
          ? {
              ...old,
              title: patch.title ?? old.title,
              state: patch.state ?? old.state,
              labels: patch.labels ?? old.labels,
              assignee: patch.assignee !== undefined ? patch.assignee : old.assignee,
              sections: {
                ...old.sections,
                description: patch.description ?? old.sections.description,
                acceptanceCriteria:
                  patch.acceptanceCriteria ?? old.sections.acceptanceCriteria,
                extra: patch.extra ?? old.sections.extra,
              },
            }
          : old,
      );
      return { prevList, prevIssue };
    },
    onError: (e, vars, ctx) => {
      if (ctx?.prevList) qc.setQueryData(["issues", vars.root], ctx.prevList);
      if (ctx?.prevIssue !== undefined)
        qc.setQueryData(["issue", vars.root, vars.id], ctx.prevIssue);
      toast.error(`update failed: ${vars.id}`, { description: e.message });
    },
    onSettled: (_d, _e, vars) => {
      qc.invalidateQueries({ queryKey: ["issues", vars.root] });
      qc.invalidateQueries({ queryKey: ["issue", vars.root, vars.id] });
    },
  });
}

export function useDeleteIssue() {
  const qc = useQueryClient();
  return useMutation<void, Error, { root: string; id: string }>({
    mutationFn: ({ root, id }) => window.hive.deleteIssue(root, id),
    onSuccess: (_d, { root, id }) => {
      qc.invalidateQueries({ queryKey: ["issues", root] });
      qc.removeQueries({ queryKey: ["issue", root, id] });
      toast.success(`deleted ${id}`);
    },
    onError: (e, { id }) => toast.error(`delete failed: ${id}`, { description: e.message }),
  });
}

export function useCommentOnIssue() {
  const qc = useQueryClient();
  return useMutation<Issue, Error, { root: string; id: string; message: string }>({
    mutationFn: ({ root, id, message }) => window.hive.commentOnIssue(root, id, message),
    onSuccess: (_d, { root, id }) => {
      qc.invalidateQueries({ queryKey: ["issue", root, id] });
      qc.invalidateQueries({ queryKey: ["issues", root] });
    },
    onError: (e, { id }) => toast.error(`comment failed: ${id}`, { description: e.message }),
  });
}

// ── cross-repo: workspaces, transfer, links ───────────────────────────────

export function useWorkspaces() {
  return useQuery<import("../../shared/ipc").WorkspaceInfo[]>({
    queryKey: ["workspaces"],
    queryFn: () => window.hive.listWorkspaces(),
    staleTime: 30_000,
  });
}

export function useMoveIssue() {
  const qc = useQueryClient();
  return useMutation<
    { newId: string; mode: "move" | "copy"; from: string },
    Error,
    { root: string; id: string; destPrefix: string; mode: "move" | "copy" }
  >({
    mutationFn: ({ root, id, destPrefix, mode }) =>
      window.hive.moveIssue(root, id, destPrefix, mode),
    onSuccess: (res, { root, id }) => {
      // Source board changes on move (issue gone) or copy (reciprocal link).
      qc.invalidateQueries({ queryKey: ["issues", root] });
      qc.invalidateQueries({ queryKey: ["issue", root, id] });
      qc.invalidateQueries({ queryKey: ["issues"] }); // dest repo board too
      toast.success(`${res.mode === "copy" ? "copied" : "moved"} ${id} → ${res.newId}`);
    },
    onError: (e, { id }) => toast.error(`transfer failed: ${id}`, { description: e.message }),
  });
}

export function useLinkIssue() {
  const qc = useQueryClient();
  return useMutation<
    { from: string; to: string; type: LinkType; reciprocal: LinkType },
    Error,
    { root: string; id: string; otherId: string; type: LinkType }
  >({
    mutationFn: ({ root, id, otherId, type }) => window.hive.linkIssue(root, id, otherId, type),
    onSuccess: (_res, { root, id }) => {
      qc.invalidateQueries({ queryKey: ["issue", root, id] });
      qc.invalidateQueries({ queryKey: ["issues"] });
      toast.success(`linked ${id}`);
    },
    onError: (e, { id }) => toast.error(`link failed: ${id}`, { description: e.message }),
  });
}

export function useUnlinkIssue() {
  const qc = useQueryClient();
  return useMutation<
    { removed: number },
    Error,
    { root: string; id: string; otherId: string }
  >({
    mutationFn: ({ root, id, otherId }) => window.hive.unlinkIssue(root, id, otherId),
    onSuccess: (_res, { root, id }) => {
      qc.invalidateQueries({ queryKey: ["issue", root, id] });
      qc.invalidateQueries({ queryKey: ["issues"] });
    },
    onError: (e, { id }) => toast.error(`unlink failed: ${id}`, { description: e.message }),
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
        qc.invalidateQueries({ queryKey: ["git:status", repoPath] });
        qc.invalidateQueries({ queryKey: ["git:diff", repoPath] });
        qc.invalidateQueries({ queryKey: ["git:list-files", repoPath] });
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
