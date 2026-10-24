/**
 * Starting work on an issue through the host's start-work guard (protocol 1.17, design jira-sync
 * §10): "Work on this" and a drag into an in-progress column ask it first. When it has something to
 * say (a warning or a block), one dialog lists every finding with what can be done about it:
 * Assign to me and start, Start anyway (Reopen, Start locally only), Open blocker, Focus that tile,
 * or Cancel. "Don't warn me for unassigned issues" turns off the unassigned check alone, for this
 * tile's workspace.
 */
import { useState } from "react";
import type { ViewClient } from "@hivemind/view-sdk";
import type { ViewStartCheck, ViewStartFinding, ViewStartPlan } from "@hivemind/view-sdk/protocol";
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Info, Label, Switch, TriangleAlert, CircleAlert,
} from "@hivemind/app-ui";
import { toast } from "@hivemind/app-ui";
import { write, type IssueSummary } from "./data";

/** What the person answered: the checks they said yes to, and whether to assign them first. */
export interface StartAnswer { ack: ViewStartCheck[]; assignMe: boolean }

const ASSIGNMENT: readonly ViewStartCheck[] = ["unassigned", "assigned-other", "in-progress-other"];
/** Whether the guard has something the person must answer: a warning or a block. Information alone
 *  never stops a start. */
export const needsAnswer = (findings: ViewStartFinding[]): boolean => findings.some((f) => f.severity !== "info");

/** The findings the person still wants to hear of: `unassigned` gone once they said not to. */
export const shown = (findings: ViewStartFinding[], quietUnassigned: boolean): ViewStartFinding[] =>
  quietUnassigned ? findings.filter((f) => f.check !== "unassigned") : findings;

/** Ask the guard about `issue`; null when this host has none (an older app) or the ask failed. */
export async function checkStart(hm: ViewClient, issue: Pick<IssueSummary, "id">): Promise<ViewStartPlan | null> {
  if (!hm.supports("startWork")) return null;
  return write("Checking the issue", hm.issues.checkStart(issue.id));
}

const SEVERITY_ICON = { info: Info, warn: TriangleAlert, block: CircleAlert } as const;
const SEVERITY_COLOUR = { info: "var(--color-fg3)", warn: "var(--color-warn)", block: "var(--color-danger, var(--color-warn))" } as const;

export function StartWorkDialog({
  hm, issue, plan, quietUnassigned, onQuietUnassigned, onAnswer, onCancel, onOpenIssue, verb,
}: {
  hm: ViewClient;
  issue: Pick<IssueSummary, "id" | "title">;
  plan: ViewStartPlan;
  quietUnassigned: boolean;
  onQuietUnassigned(quiet: boolean): void;
  onAnswer(answer: StartAnswer): void;
  onCancel(): void;
  onOpenIssue(id: string): void;
  /** What starting does here: "start" (an agent) or "move" (a drag). */
  verb: "start" | "move";
}) {
  const [quiet, setQuiet] = useState(quietUnassigned);
  const findings = shown(plan.findings, quiet);
  const blocked = findings.filter((f) => f.severity === "block");
  const warned = findings.filter((f) => f.severity === "warn");
  const actions = new Set(findings.flatMap((f) => f.actions));
  // Starting past every warning needs each to offer a way on (a closed issue with no way out offers none).
  const canStart = blocked.length === 0 && warned.every((f) => f.actions.some((a) => a === "start" || a === "reopen" || a === "start-local" || a === "assign-me"));
  const canAssign = canStart && actions.has("assign-me");
  const reopen = warned.some((f) => f.check === "closed");
  const acked = warned.map((f) => f.check);
  const go = (assignMe: boolean) => {
    if (quiet !== quietUnassigned) onQuietUnassigned(quiet);
    onAnswer({ ack: assignMe ? acked.filter((c) => !ASSIGNMENT.includes(c)) : acked, assignMe });
  };
  const startLabel = verb === "move" ? (reopen ? "Reopen and move" : "Move anyway") : reopen ? "Reopen and start" : "Start anyway";
  const primary = warned.length ? startLabel : actions.has("start-local") ? "Start locally only" : verb === "move" ? "Move" : "Start";
  const tile = blocked.find((f) => f.check === "agent-active")?.target;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="sm:max-w-[480px]" data-start-dialog={issue.id}>
        <DialogHeader>
          <DialogTitle>{blocked.length ? `${issue.id} can't be started now` : `Start ${issue.id}?`}</DialogTitle>
          <DialogDescription>{issue.title}</DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2 py-1" aria-label="What to know first">
          {findings.map((f) => {
            const Icon = SEVERITY_ICON[f.severity];
            return (
              <li key={f.check} className="flex items-start gap-2 text-label" data-finding={f.check} data-severity={f.severity}>
                <Icon size={14} className="mt-0.5 shrink-0" style={{ color: SEVERITY_COLOUR[f.severity] }} />
                <span className="flex-1 text-[var(--color-fg)]">{f.message}</span>
                {f.actions.includes("open-blocker") && f.target && (
                  <Button size="xs" variant="link" onClick={() => onOpenIssue(f.target!)} data-open-blocker={f.target}>Open {f.target}</Button>
                )}
              </li>
            );
          })}
        </ul>
        {plan.findings.some((f) => f.check === "unassigned") && (
          <div className="flex items-center gap-2 pt-1">
            <Switch id="start-quiet-unassigned" size="sm" checked={quiet} onCheckedChange={setQuiet} data-quiet-unassigned />
            <Label htmlFor="start-quiet-unassigned" className="text-count text-[var(--color-fg2)]">Don't warn me for unassigned issues in this workspace</Label>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} data-start-cancel>Cancel</Button>
          {tile && actions.has("focus-tile") && (
            <Button variant="secondary" onClick={() => { hm.commands.focusTile(tile); onCancel(); }} data-focus-tile={tile}>Focus that tile</Button>
          )}
          {canStart && (
            <Button variant={canAssign ? "secondary" : "default"} onClick={() => go(false)} data-start-anyway>{primary}</Button>
          )}
          {canAssign && (
            <Button onClick={() => go(true)} data-assign-me>Assign to me and {verb === "move" ? "move" : "start"}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Starting work, as the whole plugin does it: `workOn` ("Work on this", from a card or the issue
 *  panel) and `answerFor` (a drag into progress) ask the guard, show the dialog when it has
 *  something to say, and start with the person's answer. A host before 1.17 has no guard: "Work on
 *  this" then starts an agent in the tile's frame, told the issue, as it always did. */
export function useStartWork(hm: ViewClient, o: {
  frameId: string | null;
  quietUnassigned: boolean;
  onQuietUnassigned(quiet: boolean): void;
  onOpenIssue(id: string): void;
  legacyPrompt(issue: IssueSummary): string;
}) {
  const [asking, setAsking] = useState<{ issue: Pick<IssueSummary, "id" | "title">; plan: ViewStartPlan; verb: "start" | "move"; resolve(a: StartAnswer | null): void } | null>(null);
  const ask = (issue: Pick<IssueSummary, "id" | "title">, plan: ViewStartPlan, verb: "start" | "move") =>
    new Promise<StartAnswer | null>((resolve) => setAsking({ issue, plan, verb, resolve }));
  const done = (a: StartAnswer | null) => { asking?.resolve(a); setAsking(null); };

  /** The person's answer on starting `issue`; nothing to answer is an empty one; null when they
   *  cancelled or the guard could not be asked; "legacy" from a host with no guard. */
  const answerFor = async (issue: IssueSummary, verb: "start" | "move"): Promise<StartAnswer | null | "legacy"> => {
    if (!hm.supports("startWork")) return "legacy";
    const plan = await checkStart(hm, issue);
    if (!plan) return null;
    const a = needsAnswer(shown(plan.findings, o.quietUnassigned)) ? await ask(issue, plan, verb) : { ack: [] as ViewStartCheck[], assignMe: false };
    // Unassigned is answered for good once the person said not to be warned of it.
    return a && (o.quietUnassigned && !a.ack.includes("unassigned") ? { ...a, ack: [...a.ack, "unassigned"] } : a);
  };
  const workOn = async (issue: IssueSummary): Promise<void> => {
    const answer = await answerFor(issue, "start");
    if (answer === "legacy") {
      void write("Starting an agent", Promise.resolve().then(() => hm.commands.spawnAgent(null, o.frameId, { prompt: o.legacyPrompt(issue), name: issue.id })));
      return;
    }
    if (!answer) return;
    const r = await write("Starting work", hm.issues.start(issue.id, { ack: answer.ack, assignMe: answer.assignMe, agent: {} }));
    // Something changed between the dialog and the start (another agent took it): say what.
    if (r && !r.started && r.left.length) toast.error(`${issue.id} wasn't started`, { description: r.left.map((f) => f.message).join("; ") });
  };
  const dialog = asking && (
    <StartWorkDialog
      hm={hm} issue={asking.issue} plan={asking.plan} verb={asking.verb}
      quietUnassigned={o.quietUnassigned} onQuietUnassigned={o.onQuietUnassigned}
      onAnswer={(a) => done(a)} onCancel={() => done(null)} onOpenIssue={(id) => { done(null); o.onOpenIssue(id); }}
    />
  );
  return { workOn, answerFor, dialog };
}
