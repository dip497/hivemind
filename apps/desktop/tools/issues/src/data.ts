/**
 * The issues, as this plugin reads and changes them: through its `hm` (view protocol 1.9), never
 * the app. The list is the workspace's, live; one issue is read again whenever the list says it
 * changed. Every write tells the person when it fails.
 */
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ViewClient } from "@hivemind/view-sdk";
import type { TileHost } from "@hivemind/tile-sdk";
import { ISSUE_STATES, transitionTargets, type ViewIssue, type ViewIssueSummary, type ViewWorkflow, type ViewWorkflowStatus } from "@hivemind/view-sdk/protocol";
import { toast } from "@hivemind/app-ui";

export { transitionTargets };
export type { ViewIssue as Issue, ViewIssueSummary as IssueSummary, ViewWorkflow as Workflow, ViewWorkflowStatus as WorkflowStatus };
export type IssueState = ViewIssueSummary["state"];
export type Assignee = NonNullable<ViewIssueSummary["assignee"]>;
export type AcceptanceItem = ViewIssue["sections"]["acceptanceCriteria"][number];

/** What every part of the plugin reaches: its `hm`, the workspace's workflow, and opening its
 *  dialogs over the tile. */
export interface Issues {
  hm: ViewClient;
  /** The tile's folder: what `gh` runs in, and the frame's browser a PR opens in. */
  host: TileHost;
  /** The frame the tile is in: where an agent it starts goes. */
  frameId: string | null;
  workflow: ViewWorkflow;
  openPanel(id: "issue" | "new", params?: unknown): void;
  /** "Work on this": the start-work guard first (StartWork.tsx). */
  workOn(issue: ViewIssueSummary): void;
  /** The guard's say on moving an issue into progress: the person's answer, null when they
   *  cancelled, "legacy" from a host with no guard. */
  answerFor(issue: ViewIssueSummary, verb: "move"): Promise<{ ack: string[]; assignMe: boolean } | null | "legacy">;
  /** Save part of how the tile is set (its view, grouping, what not to warn of), the rest kept. */
  saveLayout(patch: Record<string, unknown>): void;
  /** How the tile was set when it opened. */
  layout: Record<string, unknown>;
}
/** What a dialog is handed. */
export interface PanelProps extends Issues {
  params: unknown;
  close(): void;
}
export const IssuesContext = createContext<Issues | null>(null);
export function useIssuesPlugin(): Issues {
  const v = useContext(IssuesContext);
  if (!v) throw new Error("outside the Issues plugin");
  return v;
}

/** Open an issue in the issue panel. */
export const useOpenIssue = (): ((id: string) => void) => {
  const { openPanel } = useIssuesPlugin();
  return useCallback((id: string) => openPanel("issue", { id }), [openPanel]);
};

/** The workspace's issues, live; null until the first list. */
export function useIssueList(): ViewIssueSummary[] | null {
  const { hm } = useIssuesPlugin();
  const [list, setList] = useState<ViewIssueSummary[] | null>(null);
  useEffect(() => hm.onIssues(setList), [hm]);
  return list;
}

/** One issue in full, read again whenever it changed. */
export function useIssue(id: string | null): { issue: ViewIssue | null; loading: boolean; error: string | null } {
  const { hm } = useIssuesPlugin();
  const list = useIssueList();
  const stamp = list?.find((i) => i.id === id)?.updated ?? "";
  const [state, setState] = useState<{ issue: ViewIssue | null; loading: boolean; error: string | null }>({ issue: null, loading: true, error: null });
  useEffect(() => {
    if (!id) return;
    let live = true;
    hm.issues.read(id).then(
      (issue) => { if (live) setState({ issue, loading: false, error: null }); },
      (e: Error) => { if (live) setState({ issue: null, loading: false, error: e.message }); },
    );
    return () => { live = false; };
  }, [hm, id, stamp]);
  return state;
}

/** A write, its failure shown: resolves with what it returned, or null when it failed. */
export async function write<T>(what: string, p: Promise<T>): Promise<T | null> {
  try { return await p; } catch (e) { toast.error(`${what} failed`, { description: e instanceof Error ? e.message : String(e) }); return null; }
}

/** The workflow of a host before protocol 1.16: the six states, as the board has always named them. */
const STATE_NAMES: Record<IssueState, string> = { backlog: "Backlog", todo: "Todo", in_progress: "In progress", in_review: "In review", done: "Done", cancelled: "Cancelled" };
export const STATES_ONLY: ViewWorkflow = {
  custom: false,
  statuses: ISSUE_STATES.map((s) => ({ id: s, name: STATE_NAMES[s], category: s, source: "hive" })),
  issueTypes: {},
};

/** The workspace's workflow (protocol 1.16), read again whenever the issues change, the same object
 *  while it is unchanged; the six states from a host that has none. `error` says why a broken
 *  `workflow.yaml` could not be read (the board then shows the six states). */
export function useWorkflowOf(hm: ViewClient): { workflow: ViewWorkflow; error: string | null } {
  const [got, setGot] = useState<{ workflow: ViewWorkflow; error: string | null }>({ workflow: STATES_ONLY, error: null });
  useEffect(() => {
    if (!hm.supports("workflow")) return;
    let live = true;
    let last = "";
    const load = () => hm.issues.workflow().then(
      (workflow) => {
        const key = JSON.stringify(workflow);
        if (live && key !== last) { last = key; setGot({ workflow, error: null }); }
      },
      (e: Error) => { if (live) { last = ""; setGot({ workflow: STATES_ONLY, error: e.message }); } },
    );
    void load();
    const off = hm.onIssues(() => void load());
    return () => { live = false; off(); };
  }, [hm]);
  return got;
}

export const useWorkflow = (): ViewWorkflow => useIssuesPlugin().workflow;

/** The status an issue is in: the host names it (1.16); before that, its state. */
export const statusOfIssue = (i: Pick<ViewIssueSummary, "state" | "status">): string => i.status ?? i.state;

/** A workflow status by id; one the workflow lacks (retired and gone) is shown under its own id. */
export function statusById(wf: ViewWorkflow, id: string, category: IssueState): ViewWorkflowStatus {
  return wf.statuses.find((s) => s.id === id) ?? { id, name: id, category, source: "hive" };
}

/** The issue type a summary's tracker gives it, keyed as the workflow keys `issueTypes`. */
export function issueTypeOf(wf: ViewWorkflow, i: object): string | undefined {
  const ext = (i as { external?: { provider?: string; type?: { id?: string } } }).external;
  const key = ext?.provider && ext.type?.id ? `${ext.provider}:${ext.type.id}` : undefined;
  return key && wf.issueTypes[key] ? key : undefined;
}

/** Move an issue to a status: a workspace without a workflow sets the state, as it always has, with
 *  `note`; one with a workflow names the status, and core writes its state and the activity. */
export function moveTo(hm: ViewClient, wf: ViewWorkflow, id: string, status: ViewWorkflowStatus, note: string): Promise<unknown> {
  return wf.custom ? hm.issues.update(id, { status: status.id }) : hm.issues.setState(id, status.category, note);
}
