/**
 * ChangesPanel — the Code Workbench's "Source Control" side panel: the list of
 * changed files in the working tree (git status), so you can jump straight to a
 * file's diff. The richer per-changeset review (comments, send-to-Claude, mode
 * tabs) still lives in the standalone DiffTile; this is the in-IDE quick view.
 */
import { RowsSkeleton } from "../workspace/tile-skeletons";
import { useGitStatus } from "../queries";
import type { GitFileStatus } from "../../../shared/ipc";
import { MenuItem } from "../components/ui/menu-item";

/** Single-letter badge + color per git status. */
const BADGE: Record<GitFileStatus, { ch: string; cls: string; label: string }> = {
  modified: { ch: "M", cls: "text-[var(--color-warn)]", label: "modified" },
  added: { ch: "A", cls: "text-[var(--color-ok)]", label: "added" },
  deleted: { ch: "D", cls: "text-[var(--color-err)]", label: "deleted" },
  renamed: { ch: "R", cls: "text-[var(--color-accent)]", label: "renamed" },
  copied: { ch: "C", cls: "text-[var(--color-accent)]", label: "copied" },
  untracked: { ch: "U", cls: "text-[var(--color-fg3)]", label: "untracked" },
  conflicted: { ch: "!", cls: "text-[var(--color-err)]", label: "conflicted" },
  ignored: { ch: "·", cls: "text-[var(--color-fg3)]", label: "ignored" },
};

export function ChangesPanel({
  repoPath,
  activePath,
  onOpen,
}: {
  repoPath: string;
  activePath?: string | null;
  onOpen: (path: string) => void;
}) {
  const { data: status, isLoading } = useGitStatus(repoPath);
  const files = (status?.files ?? []).filter((f) => f.status !== "ignored");

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg2)]">
      <div className="h-7 shrink-0 flex items-center gap-1.5 px-2.5 border-b border-[var(--color-line2)] text-[10px] uppercase tracking-wider font-semibold text-[var(--color-fg3)]">
        Changes
        <span className="ml-auto font-mono tabular-nums">{files.length}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto py-1">
        {isLoading && <RowsSkeleton rows={4} />}
        {!isLoading && files.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-[var(--color-fg3)] font-mono">✓ working tree clean</div>
        )}
        {files.map((f) => {
          const b = BADGE[f.status] ?? BADGE.modified;
          const name = f.path.split("/").pop() ?? f.path;
          const dir = f.path.slice(0, f.path.length - name.length);
          const active = f.path === activePath;
          return (
            <MenuItem
              key={f.path}
              variant={active ? "default" : "muted"}
              size="sm"
              selected={active}
              className="nodrag"
              onClick={() => onOpen(f.path)}
              title={f.path}
            >
              <span className={`shrink-0 w-3 text-center font-mono font-semibold ${b.cls}`} title={b.label}>
                {b.ch}
              </span>
              <span className="truncate font-mono">{name}</span>
              {dir && <span className="truncate text-[10px] text-[var(--color-fg3)]">{dir.replace(/\/$/, "")}</span>}
            </MenuItem>
          );
        })}
      </div>
    </div>
  );
}
