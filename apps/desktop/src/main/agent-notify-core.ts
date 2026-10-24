/**
 * Electron-free decision/format core for native agent notifications. Lives in
 * its own module so it can be unit-tested without loading electron (agent-
 * notify.ts, which imports electron, only adds the side-effecting wrapper).
 * Whether a pop-up shows at all (focus, settings, a burst) is the notice desk's
 * (notice-desk-core.ts); this only says what it reads.
 */
import path from "node:path";
import { STATUS_MARKS } from "@hivemind/view-sdk/status";
import type { AgentNotice } from "../shared/ipc.js";
import { NOTICE_TONES, type NoticeKind } from "../shared/notification-settings.js";

export interface ComposedNotice {
  title: string;
  body: string;
  urgency: "critical" | "normal";
}

/** An agent's name in a pop-up: its session title, spawn name or "claude #2"; "agent" when it has
 *  none but its tile id. */
export function whoOf(rec: Pick<AgentNotice, "label">): string {
  const label = rec.label?.trim();
  return label && !label.startsWith("tile-") ? label : "agent";
}

/** A crash is as time-critical as a permission prompt: both wake the dock or taskbar. */
export const urgencyOf = (kind: NoticeKind): ComposedNotice["urgency"] => (kind === "done" ? "normal" : "critical");

/** What one agent's pop-up says; null for a malformed record. */
export function composeNotice(rec: AgentNotice): ComposedNotice | null {
  if (!rec || typeof rec.tileId !== "string") return null;
  if (rec.kind !== "needs" && rec.kind !== "done" && rec.kind !== "error") return null;

  const needs = rec.kind === "needs";
  const error = rec.kind === "error";
  // Frame (workspace) name is the most useful context — which project wants you.
  // Fall back to the repo basename. This is what disambiguates two same-named
  // agents, so it always goes in the body (see below).
  const ctx = (rec.frame || (rec.repo ? path.basename(rec.repo) : "")).trim();
  // For an error, prefer the explicit detail/signal, then the exit code, so the
  // body tells you HOW it died (137 = OOM-kill, 143 = SIGTERM, …) without a tab-back.
  const how = rec.detail?.trim() || (rec.exitCode !== undefined ? `exit code ${rec.exitCode}` : "");
  // BODY = "<action> · <how?> · <where?>" — the action, the failure detail (errors
  // only), and the project context, joined so nothing empty leaves a stray "· ".
  const action = needs ? "Needs your input" : error ? "Crashed" : "Finished";
  const body = [action, error ? how : "", ctx].filter(Boolean).join(" · ");
  // TITLE is the agent's IDENTITY only, never "<name> needs you" — the verb belongs
  // in the body. This matches the in-app toast (identity on top, action beneath).
  return { title: whoOf(rec), body, urgency: urgencyOf(rec.kind) };
}

/** A gathered pop-up (notice-desk-core.ts): "9 more agents finished", "2 more agents need you",
 *  naming the first three. Its click goes to the first. */
export function composeGroup(kind: NoticeKind, notices: readonly AgentNotice[]): ComposedNotice {
  const n = notices.length;
  const word = STATUS_MARKS[NOTICE_TONES[kind]].word;
  return {
    title: `${n} more agent${n === 1 ? "" : "s"} ${n === 1 ? word : word.replace(/^needs /, "need ")}`,
    body: notices.slice(0, 3).map(whoOf).join(", ") + (n > 3 ? ", …" : ""),
    urgency: urgencyOf(kind),
  };
}

/** One agent's pop-up with what it waits on or last showed under it (`text`, one line already),
 *  when the person lets pop-ups say it (`notifications.popupText`). */
export function withText(c: ComposedNotice, text: string | undefined): ComposedNotice {
  return text ? { ...c, body: `${text}\n${c.body}` } : c;
}
