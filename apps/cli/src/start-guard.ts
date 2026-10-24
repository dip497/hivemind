/**
 * The start-work guard from the command line (design jira-sync §10): `hive ctl set-state … in_progress`,
 * `hive update --state/--status` into an in-progress status and `hive ctl workflow` over issues ask
 * it before they write. With the app or `hive host` running it is asked there, where the agents on
 * the board and the trackers' services are known; with neither, here, from the issue alone. What
 * is left after `--ack` / `--force` refuses with NEEDS_CONFIRM (exit 7), each finding in `warnings`.
 */
import {
  START_CHECKS, checkStartWork, needsConfirm, unacknowledged,
  type Issue, type StartCheck, type StartFinding, type StartPlan,
} from "@hivemind/core";
import { openDrive, type Drive } from "./drive.js";
import { HcpCliError } from "./hcp.js";
import { EXIT, type Failure } from "./exit-codes.js";
import { UsageError } from "./ctl-args.js";
import { isIssueId, rootForIdHere } from "@hivemind/core";

/** What the person said about the findings: the checks they acknowledged, every warning, or
 *  "Assign to me". */
export interface StartAcks {
  ack: StartCheck[];
  force: boolean;
  assignMe: boolean;
}

/** A start the person must confirm first: printed as NEEDS_CONFIRM with its `warnings`. */
export class NeedsConfirmError extends Error {
  constructor(readonly failure: Failure) {
    super(failure.message);
    this.name = "NeedsConfirmError";
  }
}

/** The flags every guarded command takes. */
export const START_FLAGS = {
  ack: { type: "string", description: `starting work: acknowledge these checks of the start-work guard, comma-separated (${START_CHECKS.join(", ")}) — after asking the person` },
  force: { type: "boolean", description: "starting work: acknowledge every warning of the start-work guard (never a block). Only when the person says so" },
  "assign-me": { type: "boolean", description: "starting work: make the person the issue's assignee in its tracker first (Assign to me and start)" },
} as const;

/** `--ack a,b`, `--force`, `--assign-me` as given. */
export function startAcks(a: { ack?: unknown; force?: unknown; "assign-me"?: unknown }): StartAcks {
  const ack = typeof a.ack === "string" && a.ack ? a.ack.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const bad = ack.filter((c) => !(START_CHECKS as readonly string[]).includes(c));
  if (bad.length) throw new UsageError(`--ack takes checks of the start-work guard: ${START_CHECKS.join(", ")} (not ${bad.join(", ")})`);
  return { ack: ack as StartCheck[], force: a.force === true, assignMe: a["assign-me"] === true };
}

/** The findings: asked of the running app over `drive` when there is one, else worked out here. */
async function findingsOver(drive: Pick<Drive, "call"> | null, root: string, id: string, actor: string): Promise<StartFinding[]> {
  if (drive) {
    try {
      return ((await drive.call("issue.checkStart", [root, id])) as StartPlan).findings;
    } catch {
      /* an older app, or this workspace isn't one it serves: the issue alone says what it can */
    }
  }
  return (await checkStartWork(root, id, { actor, activeTiles: [] })).findings;
}

const ASSIGNMENT: readonly StartCheck[] = ["unassigned", "assigned-other", "in-progress-other"];

/**
 * Ask the guard before work on `id` starts. Throws NeedsConfirmError when findings are left after
 * the acks; with `--assign-me`, makes the person the assignee first. The findings it passed with.
 */
export async function guardStart(root: string, id: string, acks: StartAcks, actor: string): Promise<StartFinding[]> {
  const drive = await openDrive().catch(() => null);
  try {
    const findings = await findingsOver(drive, root, id, actor);
    let left = unacknowledged(findings, { checks: acks.ack, force: acks.force });
    if (acks.assignMe) left = left.filter((f) => !ASSIGNMENT.includes(f.check));
    if (left.length) {
      const { message, fix, warnings } = needsConfirm(id, left);
      throw new NeedsConfirmError({ code: "NEEDS_CONFIRM", message, fix, warnings: warnings.map(({ check, severity, message, actions }) => ({ check, severity, message, actions })) });
    }
    if (acks.assignMe) {
      if (!drive) throw new HcpCliError("UNAVAILABLE", `--assign-me goes through ${id}'s tracker, whose plugin runs in the app or \`hive host\`: neither is running`, EXIT.unavailable, "start the hivemind app, or run `hive host`");
      await drive.call("issue.assignMe", [root, id]);
    }
    return findings;
  } finally {
    drive?.close();
  }
}

/** Whether moving `issue` to `state` starts work on it: into the in-progress category from another. */
export const startsWork = (issue: Pick<Issue, "state">, state: string | undefined): boolean => state === "in_progress" && issue.state !== "in_progress";

/** `hive ctl workflow` over issues: each item that is an issue here is asked of the guard first, and
 *  one with findings left after the acks is left out, listed in `skipped` with why. */
export async function guardItems(d: Pick<Drive, "call">, items: string[], acks: StartAcks, actor: string): Promise<{ items: string[]; skipped: { item: string; findings: StartFinding[] }[] }> {
  const kept: string[] = [];
  const skipped: { item: string; findings: StartFinding[] }[] = [];
  for (const item of items) {
    const root = isIssueId(item.trim()) ? await rootForIdHere(item.trim()).catch(() => null) : null;
    if (!root) { kept.push(item); continue; }
    const findings = await findingsOver(d, root, item.trim(), actor).catch(() => null);
    if (!findings) { kept.push(item); continue; }
    const left = unacknowledged(findings, { checks: acks.ack, force: acks.force });
    if (left.length) skipped.push({ item, findings: left }); else kept.push(item);
  }
  return { items: kept, skipped };
}
