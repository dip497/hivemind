/**
 * The changed-files sidebar of a diff.
 */
import { useEffect, useMemo, useRef } from "react";
import { FileTree as PierreFileTree, useFileTree } from "@pierre/trees/react";
import type { ContextMenuItem, ContextMenuOpenContext, FileTreeRowDecoration } from "@pierre/trees";
import { MenuItem } from "../components/ui/menu-item";

// ── changed-files TREE ──────────────────────────────────────────────────
// @pierre/diffs ships no file-navigation component, but @pierre/trees DOES —
// the same <FileTree> the editor's FileTreeTile uses. We reuse it here (fed the
// changed-file paths) so the diff sidebar gets compact folders, file icons,
// virtualization, and ⌘P search for free instead of a bespoke tree. `viewed` is
// surfaced via the main pane (reviewed files collapse) + the sidebar header
// count; the per-file toggle lives in the row context menu (Pierre owns row
// rendering, so we can't inject a checkbox — its decoration slot is text-only).
export const clampFilesW = (w: number) => Math.max(180, Math.min(560, Math.round(w)));

/** A compact folder row ("src / main / java") keeps each name whole and cuts the row once at its
 *  end, as VS Code does; the library clips every segment on its own, leaving "sr / mai / jav". */
export const COMPACT_FOLDER_CSS = `
[data-item-flattened-subitems] { display: block; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
[data-item-flattened-subitem], [data-item-flattened-subitem] * { display: inline; overflow: visible; max-width: none; min-width: auto; }
[data-item-flattened-subitem] [data-truncate-content="overflow"], [data-item-flattened-subitem] [data-truncate-marker-cell] { display: none; }
`;

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
    unsafeCSS: COMPACT_FOLDER_CSS,
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
        return (
          <div className="min-w-[180px] bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded-md shadow-2xl p-1 text-[12px]">
            <MenuItem size="sm" onClick={() => { onJumpRef.current(r.id); ctx.close(); }}>Jump to file</MenuItem>
            <MenuItem size="sm" onClick={() => { onToggleRef.current(r.file); ctx.close(); }}>Toggle reviewed</MenuItem>
          </div>
        );
      }}
    />
  );
}
