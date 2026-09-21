/**
 * The diff items CodeView renders, per mode: HEAD↔working (or ↔index when
 * staged) built per file so context expansion works, and a branch/unpushed
 * range parsed from one patch.
 */
import { useMemo, useRef } from "react";

/** A blob at a rev never changes; the fs watcher invalidates these by key. */
const IMMUTABLE_BLOB = { staleTime: Infinity, gcTime: 10 * 60_000, refetchOnWindowFocus: false, refetchOnMount: false } as const;
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  parseDiffFromFile,
  parsePatchFiles,
  type CodeViewDiffItem,
  type FileContents,
} from "@pierre/diffs";
import type { DiffScope, GitFileEntry } from "../../../shared/ipc";
import { OVERSIZE_SENTINEL } from "../../../shared/ipc";
import { useGitDiff } from "../queries";
import type { ReviewComment } from "../diff-comments";
import { BINARY_PLACEHOLDER, isBinaryText, oversizeBytes, oversizePlaceholder } from "./oversize";

export interface ItemsResult {
  items: CodeViewDiffItem<ReviewComment>[];
  isLoading: boolean;
  error: Error | null;
}

export function useWorkingItems(repoPath: string, files: GitFileEntry[], staged: boolean): ItemsResult {
  const newRev: "WORKING" | "INDEX" = staged ? "INDEX" : "WORKING";
  const changed = useMemo(
    () => files.filter((f) => f.status !== "ignored" && f.status !== "conflicted"),
    [files],
  );

  const results = useQueries({
    queries: changed.flatMap((f) => {
      // Added/untracked files have no HEAD blob — fetching it throws. Treat
      // the old side as empty so the file renders as all-additions.
      const noHead = f.status === "added" || f.status === "untracked";
      // Deleted files have no working/index blob — old side only.
      const noNew = f.status === "deleted";
      return [
        {
          queryKey: ["git:file", repoPath, f.path, noHead ? "EMPTY" : "HEAD"],
          queryFn: () =>
            noHead ? Promise.resolve("") : window.hive.gitFileContents(repoPath, f.path, "HEAD"),
          retry: false,
          ...IMMUTABLE_BLOB,
        },
        {
          queryKey: ["git:file", repoPath, f.path, noNew ? "EMPTY" : newRev],
          queryFn: () =>
            noNew ? Promise.resolve("") : window.hive.gitFileContents(repoPath, f.path, newRev),
          retry: false,
          ...IMMUTABLE_BLOB,
        },
      ];
    }),
  });

  // Signature gates the parse: only re-parse when a file's content actually
  // refetched (dataUpdatedAt bumps) or the file set changed.
  const sig = changed
    .map((f, i) => `${f.path}:${results[i * 2]?.dataUpdatedAt ?? 0}:${results[i * 2 + 1]?.dataUpdatedAt ?? 0}`)
    .join("|");

  const parsed = useRef(new Map<string, { key: string; item: CodeViewDiffItem<ReviewComment> }>());
  const items = useMemo(() => {
    const out: CodeViewDiffItem<ReviewComment>[] = [];
    const next = new Map<string, { key: string; item: CodeViewDiffItem<ReviewComment> }>();
    changed.forEach((f, i) => {
      const oldR = results[i * 2];
      const newR = results[i * 2 + 1];
      if (oldR?.isLoading || newR?.isLoading) return;
      const oldUpdated = oldR?.dataUpdatedAt ?? 0;
      const newUpdated = newR?.dataUpdatedAt ?? 0;
      // A file the main process refused to load (over DIFF_MAX_FILE_BYTES) comes
      // back as `${OVERSIZE_SENTINEL}${bytes}`. Diff a one-line placeholder on
      // BOTH sides instead of the real content so parse/highlight stay trivial —
      // the raw blob never entered the renderer, and the LCS can't blow up.
      // Empty old + placeholder new so the file still SHOWS (as a one-line note)
      // rather than vanishing (identical sides = no diff = dropped from the list).
      const oversize = oversizeBytes(oldR?.data) ?? oversizeBytes(newR?.data);
      const binary = oversize == null && (isBinaryText(oldR?.data) || isBinaryText(newR?.data));
      const oldContents = oversize != null || binary ? "" : (oldR?.data ?? "");
      const newContents = oversize != null ? oversizePlaceholder(oversize) : binary ? BINARY_PLACEHOLDER : (newR?.data ?? "");
      const oldFile: FileContents = {
        name: f.path,
        contents: oldContents,
        cacheKey: `${repoPath}:HEAD:${f.path}:${oldUpdated}`,
      };
      const newFile: FileContents = {
        name: f.path,
        contents: newContents,
        cacheKey: `${repoPath}:${newRev}:${f.path}:${newUpdated}`,
      };
      // Reuse this file's parse (and its object identity) unless ITS content
      // moved: parseDiffFromFile runs an LCS over both sides, and one agent
      // write used to re-run it for every changed file in the repo.
      const key = `${oldUpdated}:${newUpdated}:${oldContents.length}:${newContents.length}`;
      const prev = parsed.current.get(f.path);
      const item = prev?.key === key
        ? prev.item
        : {
            id: `diff:${f.path}`,
            type: "diff" as const,
            fileDiff: parseDiffFromFile(oldFile, newFile),
            version: oldUpdated + newUpdated,
          };
      next.set(f.path, { key, item });
      out.push(item);
    });
    parsed.current = next;
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, repoPath, newRev]);

  const isLoading = results.some((r) => r.isLoading) && items.length === 0;
  // Per-file content errors degrade gracefully (file renders with empty side),
  // so they're NOT fatal — only report an error when nothing rendered at all.
  const error =
    items.length === 0 && !isLoading ? ((results.find((r) => r.error)?.error as Error) ?? null) : null;
  return { items, isLoading, error };
}

// ── items: branch (`git diff base...HEAD`, partial patch) ─────────────────

export function useBranchItems(repoPath: string, scope: DiffScope, enabled: boolean): ItemsResult {
  const q = useGitDiff(enabled ? repoPath : null, scope);
  const items = useMemo(() => {
    const patch = q.data?.patch;
    if (!patch || !patch.trim()) return [];
    const out: CodeViewDiffItem<ReviewComment>[] = [];
    const base = q.dataUpdatedAt;
    for (const parsed of parsePatchFiles(patch, q.data?.cacheKey)) {
      for (const fileDiff of parsed.files) {
        out.push({ id: `diff:${fileDiff.name}`, type: "diff", fileDiff, version: base });
      }
    }
    return out;
  }, [q.data, q.dataUpdatedAt]);
  return { items, isLoading: q.isLoading, error: (q.error as Error) ?? null };
}

