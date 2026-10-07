/**
 * The issues, as this plugin reads and changes them: through its `hm` (view protocol 1.9), never
 * the app. The list is the workspace's, live; one issue is read again whenever the list says it
 * changed. Every write tells the person when it fails.
 */
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ViewClient } from "@hivemind/view-sdk";
import type { ViewIssue, ViewIssueSummary } from "@hivemind/view-sdk/protocol";
import { toast } from "@hivemind/app-ui";

export type { ViewIssue as Issue, ViewIssueSummary as IssueSummary };
export type IssueState = ViewIssueSummary["state"];
export type Assignee = NonNullable<ViewIssueSummary["assignee"]>;
export type AcceptanceItem = ViewIssue["sections"]["acceptanceCriteria"][number];

/** What every part of the plugin reaches: its `hm`, and opening its dialogs over the tile. */
export interface Issues {
  hm: ViewClient;
  openPanel(id: "issue" | "new", params?: unknown): void;
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
