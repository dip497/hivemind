/**
 * The changed-files sidebar of a diff.
 */
import { useEffect, useMemo, useRef } from "react";
import { FileTree as PierreFileTree, useFileTree } from "@pierre/trees/react";
import type { ContextMenuItem, ContextMenuOpenContext, FileTreeRowDecoration } from "@pierre/trees";

// ── changed-files TREE ──────────────────────────────────────────────────
// @pierre/diffs ships no file-navigation component, but @pierre/trees DOES —
// the same <FileTree> the editor's FileTreeTile uses. We reuse it here (fed the
// changed-file paths) so the diff sidebar gets compact folders, file icons,
// virtualization, and ⌘P search for free instead of a bespoke tree. `viewed` is
// surfaced via the main pane (reviewed files collapse) + the sidebar header
// count; the per-file toggle lives in the row context menu (Pierre owns row
// rendering, so we can't inject a checkbox — its decoration slot is text-only).
export const clampFilesW = (w: number) => Math.max(180, Math.min(560, Math.round(w)));

export interface FileRow { id: string; file: string; adds: number; dels: number }

export function FileTree({
  rows, onJump, onToggleViewed,
}: {
  rows: FileRow[];
  viewed: Set<string>;
  onJump: (id: string) => void;
  onToggleViewed: (file: string) => void;
}) {
  const norm = (p: string) => p.replace(/\/+$/, "");
  const paths = useMemo(() => rows.map((r) => norm(r.file)), [rows]);
  // path → row, for jump-on-select + the +adds/−dels decoration.
  const byPath = useMemo(() => {
    const m = new Map<string, FileRow>();
    for (const r of rows) m.set(norm(r.file), r);
    return m;
  }, [rows]);
  // The model is built once; its callbacks must read the latest maps/handlers.
  const byPathRef = useRef(byPath); byPathRef.current = byPath;
  const onJumpRef = useRef(onJump); onJumpRef.current = onJump;
  const onToggleRef = useRef(onToggleViewed); onToggleRef.current = onToggleViewed;

  const { model } = useFileTree({
    paths,
    flattenEmptyDirectories: true,   // VS Code-style compact folders
    initialExpansion: "open",        // only the changed files — show them all
    search: true,
    fileTreeSearchMode: "expand-matches",
    density: "compact",              // tighter rows + indent for deep change-sets
    itemHeight: 22,
    onSelectionChange: (sel) => {
      const p = sel[0];
      const r = p ? byPathRef.current.get(p.replace(/\/+$/, "")) : undefined;
      if (r) onJumpRef.current(r.id); // directory selections resolve to no row
    },
    renderRowDecoration: ({ item }): FileTreeRowDecoration | null => {
      if (item.kind === "directory") return null;
      const r = byPathRef.current.get(item.path.replace(/\/+$/, ""));
      return r ? { text: `+${r.adds} −${r.dels}`, title: `+${r.adds} −${r.dels}` } : null;
    },
  });

  useEffect(() => { model.resetPaths(paths); }, [model, paths]);

  return (
    <PierreFileTree
      model={model}
      className="h-full w-full nowheel"
      renderContextMenu={(item: ContextMenuItem, ctx: ContextMenuOpenContext) => {
        const r = byPathRef.current.get(item.path.replace(/\/+$/, ""));
        if (!r) return <></>;
        const btn = "w-full text-left px-2 py-1 rounded text-[var(--color-fg)] hover:bg-[var(--color-bg4)]";
        return (
          <div className="min-w-[180px] bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded-md shadow-2xl p-1 text-[12px]">
            <button className={btn} onClick={() => { onJumpRef.current(r.id); ctx.close(); }}>Jump to file</button>
            <button className={btn} onClick={() => { onToggleRef.current(r.file); ctx.close(); }}>Toggle reviewed</button>
          </div>
        );
      }}
    />
  );
}
