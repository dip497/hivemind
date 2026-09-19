// Nothing agent-specific is compiled in any more, so specs that need the familiar six
// install the published manifests where a HiveHub auto-install would: the user agents
// folder. Copying the fixtures reproduces exactly what the app shipped before the
// bundle was removed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLISHED = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../../../../..",
  "packages/hive-agents/tests/fixtures/published-agents",
);

export const DEFAULT_AGENT_IDS = ["claude", "codex", "cursor", "droid", "pi", "kiro"] as const;

/** Copy fixture agent manifests into `<xdg>/hivemind/agents/<id>/`. */
export function seedAgents(xdgConfigHome: string, ids: readonly string[] = DEFAULT_AGENT_IDS): void {
  for (const id of ids) {
    fs.cpSync(path.join(PUBLISHED, id), path.join(xdgConfigHome, "hivemind", "agents", id), { recursive: true });
  }
}
