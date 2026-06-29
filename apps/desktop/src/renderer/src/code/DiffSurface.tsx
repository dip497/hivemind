/**
 * DiffSurface — a single-file Pierre `CodeView` diff (working copy vs HEAD),
 * extracted from DiffTile's old local `FileView` so the new Code Workbench and the
 * standalone DiffTile share ONE diff surface instead of two copies.
 *
 * MUST be rendered inside a Pierre `WorkerPoolContextProvider` (the CodeView
 * highlighter/diff workers come from that context) — DiffTile already provides it;
 * the Code Workbench provides its own around the editor area.
 */
import { useQuery } from "@tanstack/react-query";
import { CodeView } from "@pierre/diffs/react";
import type { CodeViewItem } from "@pierre/diffs";

const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;

export function DiffSurface({
  repoPath,
  file,
  onClose,
}: {
  repoPath: string;
  file: string;
  /** Optional close affordance in the surface's own header (DiffTile passes it;
   *  the Workbench closes via its tab bar and omits it). */
  onClose?: () => void;
}) {
  const q = useQuery<string>({
    queryKey: ["git:file", repoPath, file, "WORKING"],
    queryFn: () => window.hive.gitFileContents(repoPath, file, "WORKING"),
  });
  const data = q.data;
  const oversized = data != null && new Blob([data]).size > MAX_PREVIEW_BYTES;
  const binary = data != null && data.slice(0, 8192).indexOf("\0") !== -1;
  const item: CodeViewItem | null =
    data != null && !oversized && !binary
      ? {
          id: `file:${file}`,
          type: "file",
          file: {
            name: file,
            contents: data,
            cacheKey: `${repoPath}:WORKING:${file}:${q.dataUpdatedAt}`,
          },
        }
      : null;
  return (
    <div className="h-full flex flex-col border-b border-[var(--color-line)]">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-[var(--color-bg3)] text-[11px] font-mono shrink-0">
        <span className="text-[var(--color-fg)] truncate" title={file}>{file}</span>
        <span className="text-[var(--color-fg3)]">· working copy</span>
        {onClose && (
          <button className="ml-auto text-[10px] text-[var(--color-fg3)]" onClick={onClose}>close</button>
        )}
      </div>
      <div className="flex-1 overflow-auto">
        {q.isLoading && <div className="p-3 text-[11px] text-[var(--color-fg3)]">loading {file}…</div>}
        {q.error && (
          <div className="p-3 text-[11px] text-[var(--color-err)] font-mono">{(q.error as Error).message}</div>
        )}
        {data != null && oversized && (
          <div className="p-3 text-[11px] text-[var(--color-warn)] font-mono">
            file too large to preview ({(new Blob([data]).size / (1024 * 1024)).toFixed(1)} MB)
          </div>
        )}
        {data != null && !oversized && binary && (
          <div className="p-3 text-[11px] text-[var(--color-warn)] font-mono">binary file — not shown</div>
        )}
        {item && (
          <CodeView
            className="h-full w-full overflow-y-auto"
            items={[item]}
            options={{ theme: { dark: "pierre-dark", light: "pierre-light" }, themeType: "dark", overflow: "scroll" }}
          />
        )}
      </div>
    </div>
  );
}
