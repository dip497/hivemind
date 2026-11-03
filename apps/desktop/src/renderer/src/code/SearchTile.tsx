/**
 * Search, standalone: the Code tile's Search panel as a tile of its own (find in files), with go to
 * file a click or Ctrl+P away. A result opens in the frame's editor, at its line.
 */
import { useState } from "react";
import { X } from "../components/icons";
import { Button } from "../components/ui/button";
import { HeaderPinButton, type PinRect } from "../canvas-nodes";
import { FindPanel } from "./FindPanel";
import { QuickOpen } from "./QuickOpen";

export function SearchTile({ repoPath, onOpenAt, onClose, pinned, onTogglePin }: {
  repoPath: string;
  onOpenAt: (path: string, line?: number, col?: number) => void;
  onClose: () => void;
  pinned?: boolean;
  onTogglePin?: (id: string, rect: PinRect) => void;
}) {
  const [quickOpen, setQuickOpen] = useState(false);
  const repoName = repoPath.split("/").filter(Boolean).pop() ?? "search";
  return (
    <div
      className="hm-glass-surface flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[var(--hm-shadow-float)]"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "p") { e.preventDefault(); e.stopPropagation(); setQuickOpen(true); }
      }}
    >
      <header className="tile-drag-handle h-8 shrink-0 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-count font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
        <span aria-hidden className="text-[var(--color-fg3)]">⌕</span>
        <span className="font-semibold text-[var(--color-fg)]">Search</span>
        <span className="text-[var(--color-fg3)] truncate">· {repoName}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" size="micro" className="nodrag" onClick={() => setQuickOpen(true)} title="Go to file (Ctrl+P)">Go to file</Button>
          <HeaderPinButton pinned={pinned} onToggle={onTogglePin} />
          <Button variant="ghost" size="icon-micro" className="nodrag" aria-label="close tile" title="close" onClick={onClose}><X /></Button>
        </span>
      </header>
      <div className="nodrag flex-1 min-h-0">
        <FindPanel repoPath={repoPath} onOpen={(p, line, col) => onOpenAt(p, line, col)} />
      </div>
      <QuickOpen repoPath={repoPath} open={quickOpen} onOpenChange={setQuickOpen} onPick={(p) => onOpenAt(p)} />
    </div>
  );
}
