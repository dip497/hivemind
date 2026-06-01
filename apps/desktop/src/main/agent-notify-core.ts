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
  if (rec.kind !== "needs" && rec.kind !== "done") return null;
  if (focused) return null;

  const needs = rec.kind === "needs";
  const repo = rec.repo ? path.basename(rec.repo) : "";
  const who = rec.label || "agent";
  return {
    title: needs ? `${who} needs you` : `${who} finished`,
    body: repo
      ? `${needs ? "Waiting for you" : "Done"} · ${repo}`
      : needs
        ? "Waiting for your input"
        : "Task finished",
    urgency: needs ? "critical" : "normal",
  };
}
