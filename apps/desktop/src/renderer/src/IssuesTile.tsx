/**
 * IssuesTile — the issue tracker as a first-class CANVAS tile (board-lite).
 *
 * Research (council, see research/council-findings.md) found that embedding a
 * full drag-drop kanban inside a pannable/zoomable canvas is fragile — intra-
 * tile card DnD fights canvas drag-to-pan and zoom transforms break DnD coords
 * (confirmed by OpenCove's bug history). So this is a NO-DRAG board: issues are
 * grouped by state in columns; state changes via a per-card dropdown; clicking a
 * card opens the full peek; "▶" dispatches the same spawn+send-to-claude flow as
 * IssuePeek. The heavy drag-drop board stays as the dedicated full-screen view.
 */
import { GripVertical, Play, Inbox, FolderGit2 } from "lucide-react";
import { useTileFont, FontStepper, handleFontKey } from "./tile-font";
import type { IssueState, IssueSummary } from "@hivemind/core/types";
import { STATE_LABEL, STATE_ORDER, StateIcon } from "./components/StateMeta";
import { useIssues, useUpdateState } from "./queries";

/** Centered, teaching empty/placeholder state (icon · headline · hint · optional action). */
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
    <div className="h-full grid place-items-center px-6 text-center">
      <div className="flex flex-col items-center gap-2 max-w-[240px]">
        <div className="text-[var(--color-fg3)]">{icon}</div>
        <div className="text-[12.5px] font-medium text-[var(--color-fg)]">{title}</div>
        <p className="text-[11.5px] text-[var(--color-fg2)] leading-relaxed">{hint}</p>
        {action && (
          <button
            onClick={action.onClick}
            className="mt-1 inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11.5px] font-medium text-white bg-[var(--color-brand)] hover:opacity-90 cursor-pointer"
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}

interface Props {
  root: string | null;
  onClose?: () => void;
}

export function IssuesTile({ root, onClose }: Props) {
  // Per-tile font (A−/A+ + Ctrl/Cmd +/−/0). Issues is a fixed-px card UI, so we
  // scale the whole board with CSS zoom (13 = 1.0) rather than a font-size.
  const font = useTileFont(`issues:${root ?? "none"}`, 13);
  const { data: issues = [], isLoading } = useIssues(root);
  const update = useUpdateState();
  // Only show columns that have issues (empty columns wasted ~200px each and
  // pushed the populated ones off-screen with no scroll affordance). If the
  // board is totally empty we still show the default set so it reads as a board.
  const allColumns = STATE_ORDER.filter((s) => s !== "cancelled");
  const columns = (() => {
    const nonEmpty = allColumns.filter((s) => issues.some((i) => i.state === s));
    return nonEmpty.length > 0 ? nonEmpty : allColumns;
  })();

  const workOn = async (issue: IssueSummary) => {
    // Ensure the repo has the hive MCP + hive-work skill so claude can actually
    // work the issue (idempotent — installs on first use). Status is owned by
    // the AGENT via the skill (in_progress on pickup → in_review/done/blocked).
    const repoDir = root ? root.replace(/\/\.hivemind\/?$/, "") : null;
    if (repoDir) {
      try { await window.hive.installAgentic(repoDir); } catch { /* best-effort */ }
    }
    // Spawn claude with the work prompt ATTACHED — it delivers it to itself once
    // ready (survives the workspace picker; no startup race). See claude-bus.
    const work = `Work on ${issue.id}: load it via hive_get_issue, complete the acceptance criteria, and end with hive_set_state. Title: "${issue.title}".`;
    window.dispatchEvent(new CustomEvent("hivemind:deliver-to-claude", { detail: { text: work } }));
  };

  return (
    <div
      className="flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[0_8px_22px_rgba(0,0,0,0.45)]"
      onKeyDownCapture={(e) => handleFontKey(e, font)}
    >
      <div className="tile-drag-handle h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-[11px] font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
        <GripVertical aria-hidden size={13} className="text-[var(--color-fg3)] -ml-1 shrink-0" />
        <span className="font-semibold text-[var(--color-fg)]">Issues</span>
        <span className="ml-1 text-[var(--color-fg3)] tabular-nums">{issues.length}</span>
        <span className="ml-auto">
          <FontStepper {...font} />
        </span>
        <button
          className="nodrag size-5 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)] cursor-pointer"
          aria-label="close tile"
          title="close"
          onClick={onClose}
        >
          <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
      </div>

      <div className="flex-1 overflow-auto p-2" style={{ zoom: font.size / 13 }}>
        {!root ? (
          <TileEmpty
            icon={<FolderGit2 size={26} strokeWidth={1.5} />}
            title="No workspace"
            hint="Open a project with a .hivemind/ folder to start tracking issues."
          />
        ) : isLoading ? (
          <div className="h-full grid place-items-center text-[11.5px] text-[var(--color-fg2)]">
            <span className="flex items-center gap-2"><span className="hm-spinner" aria-hidden />Loading issues…</span>
          </div>
        ) : issues.length === 0 ? (
          <TileEmpty
            icon={<Inbox size={26} strokeWidth={1.5} />}
            title="No issues yet"
            hint="Create your first issue to plan work and hand it to an agent."
            action={{ label: "New issue", onClick: () => window.dispatchEvent(new CustomEvent("hivemind:new-issue")) }}
          />
        ) : (
          <div className="flex gap-2 min-w-fit h-full">
            {columns.map((state) => {
              const items = issues.filter((i) => i.state === state);
              return (
                <div key={state} className="flex flex-col w-[200px] shrink-0">
                  <div className="flex items-center gap-1.5 px-1.5 py-1 text-[10.5px] font-mono text-[var(--color-fg2)]">
                    <StateIcon state={state} size={12} />
                    <span>{STATE_LABEL[state]}</span>
                    <span className="text-[var(--color-fg3)] tabular-nums">{items.length}</span>
                  </div>
                  <div className="flex flex-col gap-2">
                    {items.map((issue) => (
                      <IssueCard key={issue.id} issue={issue} root={root} columns={allColumns} onChangeState={(s) => root && update.mutate({ root, id: issue.id, state: s, note: `moved to ${s} via canvas` })} onWork={() => workOn(issue)} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function IssueCard({
  issue,
  root,
  columns,
  onChangeState,
  onWork,
}: {
  issue: IssueSummary;
  root: string;
  columns: IssueState[];
  onChangeState: (s: IssueState) => void;
  onWork: () => void;
}) {
  // Carry THIS tile's root — it's authoritative (the tile read the issue from
  // it). Without it the peek re-guesses the root via the workspace registry,
  // which misses for unregistered repos / shared prefixes → "issue not found".
  const open = () => window.dispatchEvent(new CustomEvent("hivemind:open-issue", { detail: { id: issue.id, root } }));
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open issue ${issue.id}`}
      className="nodrag group rounded-md border border-[var(--color-line2)] bg-[var(--color-bg3)] p-2.5 cursor-pointer hover:border-[var(--color-accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-brand)] transition-colors"
      onClick={open}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}
      title={`open ${issue.id}`}
    >
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[11px] text-[var(--color-fg2)] tabular-nums">{issue.id}</span>
        <button
          className="nodrag ml-auto inline-flex items-center gap-1 opacity-90 group-hover:opacity-100 transition-opacity text-[11px] px-1.5 py-1 rounded-md text-white bg-[var(--color-brand)] hover:opacity-90 cursor-pointer"
          aria-label={`Spawn claude to work on ${issue.id}`}
          title="spawn claude + work on this"
          onClick={(e) => { e.stopPropagation(); onWork(); }}
        ><Play size={8} fill="currentColor" strokeWidth={0} aria-hidden />work</button>
      </div>
      <div className="mt-1.5 text-[11.5px] text-[var(--color-fg)] leading-snug line-clamp-3">{issue.title}</div>
      <select
        value={issue.state}
        aria-label={`State of ${issue.id}`}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onChangeState(e.target.value as IssueState)}
        className="nodrag mt-2 w-full bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-md text-[11px] font-mono text-[var(--color-fg2)] px-1.5 py-1 outline-none cursor-pointer"
      >
        {columns.map((s) => (
          <option key={s} value={s}>{STATE_LABEL[s]}</option>
        ))}
      </select>
    </div>
  );
}
