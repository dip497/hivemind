/**
 * IssuesTile — the issue tracker as a first-class CANVAS tile.
 *
 * Linear/Plane-grade shell: a FilterBar (search + state/label/assignee filters)
 * with a toolbar (group-by, Board/List view switch, New), over a BoardView or
 * ListView. The board supports drag-between-columns ONLY when the tile is focused
 * (`selected`), so it never fights canvas drag-to-pan (the original reason DnD was
 * left out). Cards open the full IssuePeek; "work" spawns claude + delivers the
 * work prompt. Per-tile view + group-by persist in localStorage.
 */
import { useMemo, useState } from "react";
import { GripVertical, Inbox, FolderGit2 } from "lucide-react";
import { HeaderPinButton, type PinRect } from "./canvas-nodes";
import { useTileFont, FontStepper, handleFontKey } from "./tile-font";
import type { IssueSummary } from "@hivemind/core/types";
import { useIssues } from "./queries";
import { FilterBar, emptyFilters, applyFilters, type Filters } from "./components/FilterBar";
import { ViewSwitcher, type ViewKind } from "./components/ViewSwitcher";
import { BoardView } from "./issues/BoardView";
import { ListView } from "./issues/ListView";
import { GROUP_BY_LABEL, GROUP_BY_ORDER, type GroupBy } from "./issues/grouping";

/** Centered, teaching empty/placeholder state. */
function TileEmpty({
  icon,
  title,
  hint,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex-1 grid place-items-center px-6 text-center">
      <div className="flex flex-col items-center gap-2 max-w-[240px]">
        <div className="text-[var(--color-fg3)]">{icon}</div>
        <div className="text-[12.5px] font-medium text-[var(--color-fg)]">{title}</div>
        <p className="text-[11.5px] text-[var(--color-fg2)] leading-relaxed">{hint}</p>
        {action && (
          <button
            onClick={action.onClick}
            className="mt-1 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11.5px] font-medium text-white bg-[var(--color-brand)] hover:opacity-90 cursor-pointer hm-soft"
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}

function GroupByMenu({ value, onChange }: { value: GroupBy; onChange: (g: GroupBy) => void }) {
  return (
    <label className="nodrag inline-flex items-center gap-1 text-[11px] text-[var(--color-fg2)]">
      <span className="text-[var(--color-fg3)]">Group</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as GroupBy)}
        aria-label="Group issues by"
        className="bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded-md text-[11.5px] text-[var(--color-fg)] px-2 py-1 outline-none cursor-pointer hm-soft focus:border-[var(--color-brand)]"
      >
        {GROUP_BY_ORDER.map((g) => (
          <option key={g} value={g}>
            {GROUP_BY_LABEL[g]}
          </option>
        ))}
      </select>
    </label>
  );
}

interface Props {
  root: string | null;
  onClose?: () => void;
  /** Tile focus — gates board drag-and-drop so it doesn't fight canvas pan. */
  selected?: boolean;
  /** Pin state + toggle (injected via node data) — docked in the header. */
  pinned?: boolean;
  onTogglePin?: (id: string, rect: PinRect) => void;
}

const viewKey = (root: string) => `hm:issues:view:${root}`;
const groupKey = (root: string) => `hm:issues:group:${root}`;
const readLS = <T extends string>(k: string, fallback: T): T => {
  try {
    return (localStorage.getItem(k) as T) || fallback;
  } catch {
    return fallback;
  }
};

export function IssuesTile({ root, onClose, selected = false, pinned, onTogglePin }: Props) {
  const font = useTileFont(`issues:${root ?? "none"}`, 13);
  const { data: issues = [], isLoading } = useIssues(root);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [view, setView] = useState<ViewKind>(() => (root ? readLS<ViewKind>(viewKey(root), "board") : "board"));
  const [groupBy, setGroupBy] = useState<GroupBy>(() => (root ? readLS<GroupBy>(groupKey(root), "state") : "state"));

  const setViewP = (v: ViewKind) => {
    setView(v);
    if (root) try { localStorage.setItem(viewKey(root), v); } catch { /* ignore */ }
  };
  const setGroupP = (g: GroupBy) => {
    setGroupBy(g);
    if (root) try { localStorage.setItem(groupKey(root), g); } catch { /* ignore */ }
  };

  const filtered = useMemo(() => applyFilters(issues, filters), [issues, filters]);

  const workOn = async (issue: IssueSummary) => {
    // Ensure the repo has the hive MCP + work skill (idempotent), then spawn claude
    // with the work prompt attached (delivered once it's ready — see claude-bus).
    const repoDir = root ? root.replace(/\/\.hivemind\/?$/, "") : null;
    if (repoDir) {
      try { await window.hive.installAgentic(repoDir); } catch { /* best-effort */ }
    }
    const work = `Work on ${issue.id}: load it via hive_get_issue, complete the acceptance criteria, and end with hive_set_state. Title: "${issue.title}".`;
    window.dispatchEvent(new CustomEvent("hivemind:deliver-to-claude", { detail: { text: work } }));
  };

  return (
    <div
      className="hm-glass-surface flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[0_8px_22px_rgba(0,0,0,0.45)]"
      onKeyDownCapture={(e) => handleFontKey(e, font)}
    >
      <div className="tile-drag-handle h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-[11px] font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
        <GripVertical aria-hidden size={13} className="text-[var(--color-fg3)] -ml-1 shrink-0" />
        <span className="font-semibold text-[var(--color-fg)]">Issues</span>
        <span className="ml-1 text-[var(--color-fg3)] tabular-nums">{issues.length}</span>
        <span className="ml-auto">
          <FontStepper {...font} />
        </span>
        <HeaderPinButton pinned={pinned} onToggle={onTogglePin} />
        <button
          className="nodrag size-5 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)] cursor-pointer"
          aria-label="close tile"
          title="close"
          onClick={onClose}
        >
          <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
      </div>

      {!root ? (
        <TileEmpty
          icon={<FolderGit2 size={26} strokeWidth={1.5} />}
          title="No workspace"
          hint="Open a project with a .hivemind/ folder to start tracking issues."
        />
      ) : isLoading ? (
        <div className="flex-1 grid place-items-center text-[11.5px] text-[var(--color-fg2)]">
          <span className="flex items-center gap-2"><span className="hm-spinner" aria-hidden />Loading issues…</span>
        </div>
      ) : (
        <>
          <FilterBar
            issues={issues}
            filters={filters}
            onChange={setFilters}
            rightSlot={
              <>
                <GroupByMenu value={groupBy} onChange={setGroupP} />
                <ViewSwitcher value={view} onChange={setViewP} views={["board", "list"]} />
                <button
                  onClick={() => window.dispatchEvent(new CustomEvent("hivemind:new-issue"))}
                  className="nodrag inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11.5px] font-semibold text-white bg-[var(--color-brand)] hover:opacity-90 cursor-pointer hm-soft"
                >
                  + New
                </button>
              </>
            }
          />
          {issues.length === 0 ? (
            <TileEmpty
              icon={<Inbox size={26} strokeWidth={1.5} />}
              title="No issues yet"
              hint="Create your first issue to plan work and hand it to an agent."
              action={{ label: "New issue", onClick: () => window.dispatchEvent(new CustomEvent("hivemind:new-issue")) }}
            />
          ) : filtered.length === 0 ? (
            <TileEmpty
              icon={<Inbox size={26} strokeWidth={1.5} />}
              title="No matches"
              hint="No issues match the current filters."
            />
          ) : (
            <div className="flex-1 overflow-auto p-2" style={{ zoom: font.size / 13 }}>
              {view === "board" ? (
                <BoardView
                  issues={filtered}
                  root={root}
                  groupBy={groupBy}
                  showCancelled={filters.showCancelled}
                  selected={selected}
                  onWork={workOn}
                />
              ) : (
                <ListView
                  issues={filtered}
                  root={root}
                  groupBy={groupBy}
                  showCancelled={filters.showCancelled}
                  onWork={workOn}
                />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
