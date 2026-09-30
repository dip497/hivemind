/**
 * The app's one path for effects (R7): the host's intents, and the audit log they write,
 * `<userData>/audit.jsonl`. The control plane's verbs and the window's channels both go through it.
 */
import path from "node:path";
import { app } from "electron";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";

let intents: Intents | null = null;

export function hostIntents(): Intents {
  return (intents ??= new Intents(new AuditLog({
    file: path.join(app.getPath("userData"), "audit.jsonl"),
    onWarn: (m) => console.warn(`[audit] ${m}`),
  })));
}
