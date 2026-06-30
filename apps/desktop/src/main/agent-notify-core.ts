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
  // Fall back to the repo basename, then to a bare verb.
  const ctx = (rec.frame || (rec.repo ? path.basename(rec.repo) : "")).trim();
  const who = rec.label || "agent";
  // For an error, prefer the explicit detail/signal, then the exit code, so the
  // popup body tells you HOW it died (137 = OOM-kill, 143 = SIGTERM, …) without
  // making you tab back to read the terminal.
  const how = rec.detail?.trim() || (rec.exitCode !== undefined ? `exit code ${rec.exitCode}` : "");
  return {
    title: needs ? `${who} needs you` : error ? `${who} failed` : `${who} finished`,
    body: ctx
      ? `${needs ? "Waiting for you" : error ? `Crashed · ${how || "non-zero exit"}` : "Done"} · ${ctx}`
      : needs
        ? "Waiting for your input"
        : error
          ? how || "Agent exited unexpectedly"
          : "Task finished",
    // A crash is as time-critical as a permission prompt — wake the dock/taskbar.
    urgency: needs || error ? "critical" : "normal",
  };
}
