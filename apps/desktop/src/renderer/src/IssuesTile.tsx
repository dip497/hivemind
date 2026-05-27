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
import type { IssueState, IssueSummary } from "@hivemind/core/types";
import { STATE_LABEL, STATE_ORDER, StateIcon } from "./components/StateMeta";
import { useIssues, useUpdateState } from "./queries";

interface Props {
  root: string | null;
  onClose?: () => void;
}

export function IssuesTile({ root, onClose }: Props) {
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
    window.dispatchEvent(new CustomEvent("hivemind:spawn-claude"));
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent<string>("hivemind:send-to-claude", {
          detail: `Work on ${issue.id}: load it via hive_get_issue, complete the acceptance criteria, and end with hive_set_state. Title: "${issue.title}".`,
        }),
      );
    }, 2500);
  };

  return (
    <div className="flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[0_8px_22px_rgba(0,0,0,0.45)]">
      <div className="tile-drag-handle h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-[11px] font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
        <span aria-hidden className="text-[var(--color-fg3)] tracking-tighter">⋮⋮</span>
        <span className="font-semibold text-[var(--color-fg)]">Issues</span>
        <span className="ml-1 text-[var(--color-fg3)] tabular-nums">{issues.length}</span>
        <button
          className="nodrag ml-auto size-4 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)]"
          aria-label="close tile"
          title="close"
          onClick={onClose}
        >×</button>
      </div>

      <div className="flex-1 overflow-auto nowheel p-2">
        {!root ? (
          <div className="p-3 text-[11px] text-[var(--color-fg3)]">no workspace — open a project with a .hivemind/ folder</div>
        ) : isLoading ? (
          <div className="p-3 flex items-center gap-2 text-[11px] text-[var(--color-fg3)]">
            <span className="hm-spinner" aria-hidden />
            <span>Loading issues…</span>
          </div>
        ) : issues.length === 0 ? (
          <div className="p-3 text-[11px] text-[var(--color-fg3)]">no issues yet — ⌘N to create one</div>
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
                  <div className="flex flex-col gap-1.5">
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
  return (
    <div
      className="nodrag group rounded-md border border-[var(--color-line2)] bg-[var(--color-bg3)] p-2 cursor-pointer hover:border-[var(--color-accent)] transition-colors"
      onClick={() => window.dispatchEvent(new CustomEvent<string>("hivemind:open-issue", { detail: issue.id }))}
      title={`open ${issue.id}`}
    >
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[9.5px] text-[var(--color-fg3)] tabular-nums">{issue.id}</span>
        <button
          className="ml-auto opacity-70 group-hover:opacity-100 transition-opacity text-[9.5px] px-1 py-0.5 rounded text-white bg-[var(--color-brand)] hover:opacity-90"
          title="spawn claude + work on this"
          onClick={(e) => { e.stopPropagation(); onWork(); }}
        >▶ work</button>
      </div>
      <div className="mt-1 text-[11.5px] text-[var(--color-fg)] leading-snug line-clamp-3">{issue.title}</div>
      <select
        value={issue.state}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onChangeState(e.target.value as IssueState)}
        className="mt-1.5 w-full bg-[var(--color-bg)] border border-[var(--color-line2)] rounded text-[9.5px] font-mono text-[var(--color-fg2)] px-1 py-0.5 outline-none cursor-pointer"
      >
        {columns.map((s) => (
          <option key={s} value={s}>{STATE_LABEL[s]}</option>
        ))}
      </select>
    </div>
  );
}
