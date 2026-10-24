/**
 * The Issues tile: a filter bar (search, state, label and assignee filters) with group-by, a
 * Board/List switch and New, over a board or a list. The board's cards drag between columns
 * only while the tile is focused, so a drag never fights the canvas's pan. A card opens the issue
 * panel; "work" starts an agent on it. How the tile is set (view, grouping) is the tile's own.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Inbox } from "@hivemind/app-ui";
import type { TileProps } from "@hivemind/tile-sdk";
import type { ViewClient, ViewIssuesStatus } from "@hivemind/view-sdk";
import { Button, Input, Label, Loading, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@hivemind/app-ui";
import { useIssueList, useIssuesPlugin, write, type IssueSummary } from "./data";
import { FilterBar, emptyFilters, applyFilters, type Filters } from "./FilterBar";
import { ViewSwitcher, type ViewKind } from "./ViewSwitcher";
import { BoardView } from "./BoardView";
import { ListView } from "./ListView";
import { GROUP_BY_LABEL, GROUP_BY_ORDER, type GroupBy } from "./grouping";
import { DEFAULT_TRACKER_ASSIGNEE, isTrackerAssignee, matchesTrackerAssignee, type TrackerAssignee } from "./tracker";

/** Centered, teaching empty/placeholder state. */
function TileEmpty({
  icon,
  title,
  hint,
  action,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex-1 grid place-items-center px-6 text-center">
      <div className="flex flex-col items-center gap-2 max-w-[240px]">
        <div className="text-[var(--color-fg3)]">{icon}</div>
        <div className="text-body font-medium text-[var(--color-fg)]">{title}</div>
        <p className="text-label text-[var(--color-fg2)] leading-relaxed">{hint}</p>
        {action && (
          <Button size="sm" className="mt-1" onClick={action.onClick}>
            {action.label}
          </Button>
        )}
      </div>
    </div>
  );
}

function GroupByMenu({ value, onChange }: { value: GroupBy; onChange: (g: GroupBy) => void }) {
  return (
    <label className="nodrag inline-flex items-center gap-1 text-count text-[var(--color-fg2)]">
      <span className="text-[var(--color-fg3)]">Group</span>
      <Select value={value} onValueChange={(v) => onChange(v as GroupBy)}>
        <SelectTrigger size="sm" aria-label="Group issues by"><SelectValue /></SelectTrigger>
        <SelectContent>
          {GROUP_BY_ORDER.map((g) => <SelectItem key={g} value={g}>{GROUP_BY_LABEL[g]}</SelectItem>)}
        </SelectContent>
      </Select>
    </label>
  );
}

/** A workspace that keeps no issues yet: where they would live, and the prefix of their ids. */
function SetUpIssues({ hm, status, onReady }: { hm: ViewClient; status: ViewIssuesStatus; onReady: (s: ViewIssuesStatus) => void }) {
  const [prefix, setPrefix] = useState(status.suggested);
  const [busy, setBusy] = useState(false);
  if (!status.folder) {
    return <TileEmpty icon={<Inbox size={26} strokeWidth={1.5} />} title="No folder here" hint="Issues live in a folder on this computer. Open one, then set them up here." />;
  }
  const submit = async () => {
    setBusy(true);
    const next = await write("Setting up issues", hm.issues.setUp(prefix));
    setBusy(false);
    if (next) onReady(next);
  };
  return (
    <div className="flex-1 grid place-items-center px-6" data-issues-setup>
      <form className="flex flex-col gap-3 w-full max-w-[280px]" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="text-[var(--color-fg3)]"><Inbox size={26} strokeWidth={1.5} /></div>
          <div className="text-body font-medium text-[var(--color-fg)]">Keep issues in {status.folder}</div>
          <p className="text-label text-[var(--color-fg2)] leading-relaxed">
            They live in a <code className="font-mono text-count">.hivemind</code> folder there, numbered {prefix || "…"}-1, -2, …, and agents read and update them with <code className="font-mono text-count">hive</code>.
          </p>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="issues-prefix">Issue prefix</Label>
          <Input id="issues-prefix" font="mono" value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} placeholder="e.g. PAY" data-issues-prefix />
        </div>
        <Button type="submit" size="sm" disabled={busy || !prefix} data-issues-setup-go>{busy ? "Setting up…" : "Set up issues"}</Button>
      </form>
    </div>
  );
}

interface Saved { view?: ViewKind; groupBy?: GroupBy; trackerAssignee?: TrackerAssignee }

/** "Work on it" from a host before the start-work guard (protocol 1.17): an agent in this tile's
 *  frame, told the issue (the person sends or cancels it). */
export function workPrompt(issue: Pick<IssueSummary, "id" | "title">): string {
  return `Work on ${issue.id}: load it with \`hive show ${issue.id} --json\`, complete the acceptance criteria, and end with \`hive ctl set-state\`. Title: "${issue.title}".`;
}

export function IssuesTile({ hm, selected, workflowError }: TileProps & { workflowError?: string | null }) {
  const { openPanel, workOn, answerFor, saveLayout, layout } = useIssuesPlugin();
  const list = useIssueList();
  const issues = list ?? [];
  const saved = layout as Saved;
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [view, setView] = useState<ViewKind>(saved.view ?? "board");
  const [groupBy, setGroupBy] = useState<GroupBy>(saved.groupBy ?? "state");
  // Whose mirrored issues show, kept with the tile like its view: the Issues tile is one per workspace.
  const [trackerAssignee, setTrackerAssignee] = useState<TrackerAssignee>(isTrackerAssignee(saved.trackerAssignee) ? saved.trackerAssignee : DEFAULT_TRACKER_ASSIGNEE);
  const setViewP = (v: ViewKind) => { setView(v); saveLayout({ view: v }); };
  const setGroupP = (g: GroupBy) => { setGroupBy(g); saveLayout({ groupBy: g }); };
  const setTrackerP = (t: TrackerAssignee) => { setTrackerAssignee(t); saveLayout({ trackerAssignee: t }); };

  // Whether this workspace keeps issues; an older app does not say, and always does.
  const [status, setStatus] = useState<ViewIssuesStatus | null>(null);
  useEffect(() => {
    let live = true;
    hm.issues.status().then((s) => { if (live) setStatus(s); }, () => { if (live) setStatus({ ready: true, folder: null, suggested: "" }); });
    return () => { live = false; };
  }, [hm]);

  const filtered = useMemo(() => applyFilters(issues, filters).filter((i) => matchesTrackerAssignee(i, trackerAssignee)), [issues, filters, trackerAssignee]);
  const newIssue = () => openPanel("new");

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {list === null || status === null ? (
        <Loading label="Loading the issues" className="flex-1" />
      ) : !status.ready ? (
        <SetUpIssues hm={hm} status={status} onReady={setStatus} />
      ) : (
        <>
          {workflowError && (
            <div role="alert" className="px-4 py-1.5 text-count text-[var(--color-warn)] border-b border-[var(--color-line)] bg-[var(--color-bg2)]" data-workflow-error>
              The workflow could not be read, so the board shows the six states: {workflowError}. Run <code className="font-mono">hive statuses validate</code>.
            </div>
          )}
          <FilterBar
            issues={issues}
            filters={filters}
            onChange={setFilters}
            tracker={{ value: trackerAssignee, onChange: setTrackerP }}
            rightSlot={
              <>
                <span className="text-count text-[var(--color-fg3)] tabular-nums">{issues.length}</span>
                <GroupByMenu value={groupBy} onChange={setGroupP} />
                <ViewSwitcher value={view} onChange={setViewP} views={["board", "list"]} />
                <Button size="sm" className="nodrag" onClick={newIssue}>+ New</Button>
              </>
            }
          />
          {issues.length === 0 ? (
            <TileEmpty
              icon={<Inbox size={26} strokeWidth={1.5} />}
              title="No issues yet"
              hint="Create your first issue to plan work and hand it to an agent."
              action={{ label: "New issue", onClick: newIssue }}
            />
          ) : filtered.length === 0 ? (
            <TileEmpty icon={<Inbox size={26} strokeWidth={1.5} />} title="No matches" hint="No issues match the current filters." />
          ) : (
            <div className="flex-1 overflow-auto p-2">
              {view === "board" ? (
                <BoardView issues={filtered} groupBy={groupBy} showCancelled={filters.showCancelled} selected={selected} onWork={workOn} answerFor={answerFor} />
              ) : (
                <ListView issues={filtered} groupBy={groupBy} showCancelled={filters.showCancelled} onWork={workOn} />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
