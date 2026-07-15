/**
 * Electron-free decision/format core for native agent notifications. Lives in
 * its own module so it can be unit-tested without loading electron (agent-
 * notify.ts, which imports electron, only adds the side-effecting wrapper).
 */
import path from "node:path";
import type { AgentNotice } from "../shared/ipc.js";

export interface ComposedNotice {
  title: string;
  body: string;
  urgency: "critical" | "normal";
}

/** What (if anything) to show for a notice given the window focus state.
 *  Returns null to stay quiet (focused → the in-app toast already covers it,
 *  or the record is malformed). */
export function composeNotice(rec: AgentNotice, focused: boolean): ComposedNotice | null {
  if (!rec || typeof rec.tileId !== "string") return null;
  if (rec.kind !== "needs" && rec.kind !== "done" && rec.kind !== "error") return null;
  if (focused) return null;

  const needs = rec.kind === "needs";
  const error = rec.kind === "error";
  // Frame (workspace) name is the most useful context — which project wants you.
  // Fall back to the repo basename. This is what disambiguates two same-named
  // agents, so it always goes in the body (see below).
  const ctx = (rec.frame || (rec.repo ? path.basename(rec.repo) : "")).trim();
  // TITLE is the agent's IDENTITY only (its session title / spawn name / "claude
  // #2"), never "<name> needs you" — the verb belongs in the body. This matches
  // the in-app toast (identity on top, action beneath) so the two surfaces read
  // the same. Falls back to "agent" only if we truly have no label.
  const label = rec.label?.trim();
  const who = label && !label.startsWith("tile-") ? label : "agent";
  // For an error, prefer the explicit detail/signal, then the exit code, so the
  // body tells you HOW it died (137 = OOM-kill, 143 = SIGTERM, …) without a tab-back.
  const how = rec.detail?.trim() || (rec.exitCode !== undefined ? `exit code ${rec.exitCode}` : "");
  // BODY = "<action> · <how?> · <where?>" — the action, the failure detail (errors
  // only), and the project context, joined so nothing empty leaves a stray "· ".
  const action = needs ? "Needs your input" : error ? "Crashed" : "Finished";
  const body = [action, error ? how : "", ctx].filter(Boolean).join(" · ");
  return {
    title: who,
    body,
    // A crash is as time-critical as a permission prompt — wake the dock/taskbar.
    urgency: needs || error ? "critical" : "normal",
  };
}
