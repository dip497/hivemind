import { useState } from "react";
import type { IssueSummary } from "@hivemind/core/types";
import { StateIcon } from "./components/StateMeta";

export type SidebarScope = { kind: "all" };

interface Props {
  root: string | null;
  cwd: string;
  issues: IssueSummary[];
  scope: SidebarScope;
  onScope: (s: SidebarScope) => void;
  onSelectIssue: (id: string) => void;
  selectedId: string | null;
  // Workspace switcher.
  recents: string[];
  onOpenFolder: () => void;
  onOpenRecent: (path: string) => void;
  onInitWorkspace: () => void;
}

export function Sidebar({
  root,
  cwd,
  issues,
  scope,
  onScope,
  onSelectIssue,
  selectedId,
  recents,
  onOpenFolder,
  onOpenRecent,
  onInitWorkspace,
}: Props) {
  const inProgress = issues.filter((i) => i.state === "in_progress").slice(0, 8);
  const inReview = issues.filter((i) => i.state === "in_review").slice(0, 8);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  const hasWorkspace = !!root;
  const projName = root ? root.split("/").slice(-2, -1)[0] ?? "project" : "No workspace";
  const repoPath = root ?? cwd;
  const otherRecents = recents.filter((p) => p !== repoPath).slice(0, 6);

  return (
    <aside className="border-r border-[var(--color-line)] bg-[var(--color-bg2)] flex flex-col overflow-hidden">
      {/* Workspace switcher — VSCode/Linear-style. Click the header to open
          folder / pick a recent / initialize. */}
      <div className="relative border-b border-[var(--color-line)]">
        <button
          onClick={() => setSwitcherOpen((o) => !o)}
          className="w-full px-4 pt-4 pb-3 text-left hover:bg-[var(--color-bg3)] transition-colors group"
          title="Switch workspace"
        >
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={`size-1.5 rounded-full shrink-0 ${hasWorkspace ? "bg-[var(--color-ok)]" : "bg-[var(--color-warn)]"}`}
            />
            <span className="text-[15px] font-semibold text-[var(--color-fg)] truncate tracking-tight flex-1">
              {projName}
            </span>
            <span aria-hidden className="text-[10px] text-[var(--color-fg3)] group-hover:text-[var(--color-fg2)] transition-colors">
              ▾
            </span>
          </div>
          <div className="font-mono text-[10.5px] text-[var(--color-fg3)] mt-0.5 truncate pl-3.5" title={repoPath}>
            {hasWorkspace ? repoPath.split("/").slice(-3).join("/") : "click to open a folder"}
          </div>
        </button>

        {switcherOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setSwitcherOpen(false)} />
            <div className="absolute left-2 right-2 top-full z-40 mt-1 bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded-md shadow-xl py-1">
              <button
                onClick={() => { setSwitcherOpen(false); onOpenFolder(); }}
                className="w-full text-left flex items-center gap-2 px-2.5 py-1.5 text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-bg4)] transition-colors"
              >
                <span aria-hidden>📁</span>
                <span className="flex-1">Open folder…</span>
                <kbd className="font-mono text-[9.5px] text-[var(--color-fg3)]">⌃O</kbd>
              </button>
              {!hasWorkspace && (
                <button
                  onClick={() => { setSwitcherOpen(false); onInitWorkspace(); }}
                  className="w-full text-left flex items-center gap-2 px-2.5 py-1.5 text-[12px] text-[var(--color-brand)] hover:bg-[var(--color-bg4)] transition-colors"
                >
                  <span aria-hidden>✦</span>
                  <span className="flex-1">Initialize workspace here</span>
                </button>
              )}
              {otherRecents.length > 0 && (
                <>
                  <div className="my-1 border-t border-[var(--color-line)]" />
                  <div className="px-2.5 py-1 text-[10px] uppercase tracking-wider text-[var(--color-fg3)] font-semibold">
                    Recent
                  </div>
                  {otherRecents.map((p) => (
                    <button
                      key={p}
                      onClick={() => { setSwitcherOpen(false); onOpenRecent(p); }}
                      className="w-full text-left flex flex-col px-2.5 py-1 hover:bg-[var(--color-bg4)] transition-colors"
                    >
                      <span className="text-[12px] text-[var(--color-fg)] truncate">{p.split("/").slice(-1)[0]}</span>
                      <span className="text-[10px] text-[var(--color-fg3)] truncate font-mono">{p}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          </>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto py-3">
        <NavSection title="Workspace">
          <NavItem
            label="All issues"
            count={issues.length}
            active={scope.kind === "all"}
            onClick={() => onScope({ kind: "all" })}
            icon={
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                <rect x="1.5" y="3" width="11" height="2" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
                <rect x="1.5" y="6" width="11" height="2" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
                <rect x="1.5" y="9" width="11" height="2" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            }
          />
        </NavSection>

        {(inProgress.length > 0 || inReview.length > 0) && (
          <NavSection title="Active work">
            {inProgress.map((i) => (
              <IssueQuick key={i.id} issue={i} selected={selectedId === i.id} onClick={() => onSelectIssue(i.id)} />
            ))}
            {inReview.map((i) => (
              <IssueQuick key={i.id} issue={i} selected={selectedId === i.id} onClick={() => onSelectIssue(i.id)} />
            ))}
          </NavSection>
        )}
      </nav>

      <div className="px-4 py-2.5 border-t border-[var(--color-line)] flex items-center gap-2 text-[10.5px] text-[var(--color-fg3)]">
        <span aria-hidden className="size-1.5 rounded-full bg-[var(--color-ok)]" />
        <span>connected</span>
        <span className="ml-auto font-mono tabular-nums">{issues.length}i</span>
      </div>
    </aside>
  );
}

function NavSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-4 first:mt-0 px-2">
      <div className="u-eyebrow px-2 mb-1">{title}</div>
      <div className="space-y-px">{children}</div>
    </section>
  );
}

function NavItem({
  label,
  count,
  active,
  onClick,
  icon,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-[12px] transition-colors ${
        active
          ? "bg-[var(--color-bg4)] text-[var(--color-fg)]"
          : "text-[var(--color-fg2)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)]"
      }`}
    >
      {icon && <span className="text-[var(--color-fg3)] shrink-0">{icon}</span>}
      <span className="truncate flex-1 text-left">{label}</span>
      {count != null && (
        <span className="font-mono text-[10.5px] text-[var(--color-fg3)] tabular-nums">{count}</span>
      )}
    </button>
  );
}

function IssueQuick({
  issue: i,
  selected,
  onClick,
}: {
  issue: IssueSummary;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors ${
        selected ? "bg-[var(--color-bg4)]" : "hover:bg-[var(--color-bg3)]"
      }`}
    >
      <StateIcon state={i.state} size={11} />
      <span className="font-mono text-[10px] text-[var(--color-fg3)] tabular-nums shrink-0">{i.id}</span>
      <span className="text-[12px] text-[var(--color-fg)] truncate flex-1">{i.title}</span>
    </button>
  );
}
