/**
 * FileTreeTile — Pierre `<FileTree>` wired the way the @pierre/trees README
 * shows (header + renderContextMenu as props, useFileTreeSearch hook for the
 * ⌘P quick-open, renderRowDecoration in the useFileTree options).
 *
 * Real data only: paths from `git ls-files`, status from `git status` (both via
 * IPC `window.hive.*`). No mocks.
 */
import { useEffect, useMemo } from "react";
import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react";
import type {
  ContextMenuItem,
  ContextMenuOpenContext,
  FileTreeRowDecoration,
  GitStatusEntry,
  GitStatus,
} from "@pierre/trees";
import { toast } from "sonner";
import { useGitListFiles, useGitStatus } from "./queries";
import type { GitFileStatus } from "../../shared/ipc";

interface Props {
  repoPath: string;
  /** Optional callback when a file row is selected (e.g., open a diff tile). */
  onSelectFile?: (path: string) => void;
  /** When true, render only the tree — no outer tile chrome (border/shadow)
   *  and no internal header (the embedding host supplies its own). Defaults
   *  to false so the standalone tile keeps its full chrome. */
  embedded?: boolean;
}

// hivemind → @pierre/trees status mapping. Pierre's GitStatus union doesn't
// include "conflicted"/"copied" — fold those into the closest visual cue.
const STATUS_MAP: Partial<Record<GitFileStatus, GitStatus>> = {
  modified: "modified",
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
  untracked: "untracked",
  ignored: "ignored",
  copied: "modified",
  conflicted: "modified",
};

const STATUS_LETTER: Record<GitFileStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  untracked: "U",
  ignored: "I",
  conflicted: "!",
};

const STATUS_COLOR: Record<GitFileStatus, string> = {
  modified: "var(--color-warn)",
  added: "var(--color-ok)",
  deleted: "var(--color-err)",
  renamed: "var(--color-info)",
  copied: "var(--color-info)",
  untracked: "var(--color-ok)",
  ignored: "var(--color-fg3)",
  conflicted: "var(--color-err)",
};

export function FileTreeTile({ repoPath, onSelectFile, embedded = false }: Props) {
  const { data: paths = [], isLoading, error: listError } = useGitListFiles(repoPath);
  const { data: status } = useGitStatus(repoPath);

  const gitStatus: GitStatusEntry[] = useMemo(() => {
    if (!status) return [];
    const out: GitStatusEntry[] = [];
    for (const f of status.files) {
      const mapped = STATUS_MAP[f.status];
      if (mapped) out.push({ path: f.path, status: mapped });
    }
    return out;
  }, [status]);

  const statusByPath = useMemo(() => {
    const m = new Map<string, { status: GitFileStatus; staged: boolean }>();
    for (const f of status?.files ?? []) m.set(f.path, { status: f.status, staged: f.staged });
    return m;
  }, [status]);

  // A selected path is a DIRECTORY if some file path lives under it. Leaf files
  // have no children → they open. This is format-robust (works regardless of
  // how Pierre formats the selection vs git ls-files) and keeps us from opening
  // a folder as an editor tab (fileRead → EISDIR).
  const isDirectory = useMemo(() => {
    return (p: string) => paths.some((f) => f.startsWith(p + "/"));
  }, [paths]);

  const repoName = repoPath.split("/").filter(Boolean).pop() ?? "files";

  // useFileTree() creates the model once. Per-row decoration is configured here
  // (Pierre keeps it on the MODEL because the renderer needs it during virtualization).
  const { model } = useFileTree({
    paths,
    gitStatus,
    flattenEmptyDirectories: true,
    // Folders start COLLAPSED (VSCode/Zed default) — "open" expanded the
    // entire tree on mount which is overwhelming for big repos. User clicks
    // to drill in; ⌘P search still expands matches on demand.
    initialExpansion: "closed",
    search: true,
    fileTreeSearchMode: "expand-matches",
    itemHeight: 22,
    initialVisibleRowCount: 20,
    onSelectionChange: (sel) => {
      const first = sel[0];
      if (!first || !onSelectFile) return;
      // Ignore directory selections (else the editor fileRead(<dir>) → EISDIR
      // and poisons the tab). Pierre returns directory paths WITH a trailing
      // slash, so strip it before the children check (the previous bug: a raw
      // "internal/" never matched "internal//").
      if (first.endsWith("/")) return;
      if (isDirectory(first)) return;
      onSelectFile(first);
    },
    renderRowDecoration: ({ item }): FileTreeRowDecoration | null => {
      if (item.kind === "directory") return null;
      const s = statusByPath.get(item.path);
      if (!s) return null;
      return {
        text: STATUS_LETTER[s.status] + (s.staged ? "•" : ""),
        title: `${s.status}${s.staged ? " · staged" : ""}`,
      };
    },
  });

  // Push paths + status into the model when queries refetch.
  useEffect(() => {
    if (paths.length > 0) model.resetPaths(paths);
  }, [model, paths]);
  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [model, gitStatus]);

  // ⌘P / Ctrl+P → open Pierre's built-in search (the README's recommended hook).
  const search = useFileTreeSearch(model);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "p" || e.key === "P") && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        e.preventDefault();
        search.open();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [search]);

  return (
    <div
      className={
        embedded
          ? "flex h-full flex-col bg-[var(--color-bg2)] overflow-hidden min-w-0"
          : "flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[0_8px_22px_rgba(0,0,0,0.45)]"
      }
      style={
        {
          // Theming via Pierre CSS variables (README's "Styling" section recommends this
          // over `unsafeCSS` — the escape hatch).
          "--trees-bg": "var(--color-bg2)",
          "--trees-bg-muted": "var(--color-bg3)",
          "--trees-fg": "var(--color-fg)",
          "--trees-fg-muted": "var(--color-fg3)",
          "--trees-accent": "var(--color-brand)",
          "--trees-border-color": "var(--color-line)",
          "--trees-border-radius": "4px",
          "--trees-item-height": "22px",
          "--trees-theme-sidebar-bg": "var(--color-bg2)",
          "--trees-theme-sidebar-fg": "var(--color-fg)",
          "--trees-theme-sidebar-header-fg": "var(--color-fg3)",
          "--trees-theme-sidebar-border": "var(--color-line)",
          "--trees-theme-list-hover-bg": "var(--color-bg3)",
          "--trees-theme-list-active-selection-bg": "var(--color-bg4)",
          "--trees-theme-list-active-selection-fg": "var(--color-fg)",
          "--trees-theme-input-bg": "var(--color-bg3)",
          "--trees-theme-input-border": "var(--color-line2)",
          "--trees-theme-input-fg": "var(--color-fg)",
          "--trees-theme-focus-ring": "var(--color-brand)",
          "--trees-theme-scrollbar-thumb": "var(--color-line2)",
          "--trees-theme-git-modified-fg": "var(--color-warn)",
          "--trees-theme-git-renamed-fg": "var(--color-info)",
          "--trees-theme-git-untracked-fg": "var(--color-ok)",
          "--trees-theme-git-ignored-fg": "var(--color-fg3)",
          "--trees-theme-row-decoration-fg": "var(--color-fg3)",
          "--trees-theme-row-decoration-bg": "transparent",
        } as React.CSSProperties
      }
    >
      {isLoading ? (
        <div className="px-3 py-4 flex items-center gap-2 text-[11.5px] text-[var(--color-fg3)]">
          <span className="hm-spinner" aria-hidden />
          <span>Loading files…</span>
        </div>
      ) : listError ? (
        // Surface the error from `git ls-files` (most often: not a repo, or
        // the .git dir was unmounted/removed under us). Without this the
        // tile renders an "empty repo" lie.
        <div className="px-3 py-4 text-[11.5px] font-mono text-[var(--color-err)]">
          <div className="font-semibold mb-1">git ls-files failed</div>
          <div className="text-[var(--color-fg3)]">{(listError as Error).message}</div>
          <div className="text-[var(--color-fg3)] mt-1 truncate" title={repoPath}>{repoPath}</div>
        </div>
      ) : paths.length === 0 ? (
        <div className="px-3 py-4 text-[11.5px] text-[var(--color-fg3)]">empty repo</div>
      ) : (
        <FileTree
          model={model}
          className="h-full w-full nowheel"
          // Per README: header lives ON the component (not external markup).
          // When embedded, the WorkbenchTile supplies the chrome — omit ours.
          header={
            embedded ? undefined : (
              <div className="tile-drag-handle flex items-center justify-between px-3 py-2 border-b border-[var(--color-line)] bg-[var(--color-bg3)] cursor-grab active:cursor-grabbing">
                <div className="flex items-center gap-2">
                  <span aria-hidden className="text-[var(--color-fg3)] text-[11px]">⌗</span>
                  <span className="text-[12px] font-semibold text-[var(--color-fg)] truncate">
                    {repoName}
                  </span>
                  <span className="font-mono text-[10.5px] text-[var(--color-fg3)] tabular-nums ml-1">
                    {paths.length}
                  </span>
                </div>
                {gitStatus.length > 0 && (
                  <span className="font-mono text-[10.5px] text-[var(--color-warn)] tabular-nums">
                    {gitStatus.length} changed
                  </span>
                )}
              </div>
            )
          }
          // Per README: renderContextMenu returns ReactNode directly.
          // Pierre positions + portals + handles outside-click + Esc.
          renderContextMenu={(item, ctx) => (
            <CtxMenu
              item={item}
              ctx={ctx}
              repoPath={repoPath}
              statusByPath={statusByPath}
            />
          )}
        />
      )}
    </div>
  );
}

function CtxMenu({
  item,
  ctx,
  repoPath,
  statusByPath,
}: {
  item: ContextMenuItem;
  ctx: ContextMenuOpenContext;
  repoPath: string;
  statusByPath: Map<string, { status: GitFileStatus; staged: boolean }>;
}) {
  const abs = `${repoPath}/${item.path}`;
  const st = statusByPath.get(item.path);

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`copied ${label}`, { description: text });
    } catch (e) {
      toast.error("copy failed", { description: (e as Error).message });
    }
    ctx.close();
  }

  return (
    <div className="min-w-[200px] bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded-md shadow-2xl p-1 text-[12px]">
      <div className="px-2 py-1 flex items-center gap-2 border-b border-[var(--color-line)] mb-1">
        <span className="font-mono text-[10.5px] text-[var(--color-fg2)] truncate flex-1">
          {item.path}
        </span>
        {st && (
          <span
            className="font-mono text-[10px] uppercase tracking-wider"
            style={{ color: STATUS_COLOR[st.status] }}
            title={st.status}
          >
            {st.status[0]}
          </span>
        )}
      </div>
      <Item label="Copy path" hint="abs" onClick={() => copy(abs, "absolute path")} />
      <Item label="Copy relative path" hint="rel" onClick={() => copy(item.path, "relative path")} />
      {item.kind === "file" && (
        <Item label="Copy file name" hint="name" onClick={() => copy(item.name, "file name")} />
      )}
    </div>
  );
}

function Item({ label, hint, onClick }: { label: string; hint?: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center px-2 py-1 rounded text-left text-[var(--color-fg)] hover:bg-[var(--color-bg4)]"
    >
      <span className="flex-1">{label}</span>
      {hint && <span className="font-mono text-[9.5px] text-[var(--color-fg3)]">{hint}</span>}
    </button>
  );
}
