/** Installing by name from HiveHub: `hive plugins install <id>`, `hive agents install amp`. The
 *  catalog and the download are the app's own (`@hivemind/core/plugin-catalog`), so every file is
 *  checked against the hash HiveHub recorded when it was published — the same check the app makes. */
import pkg from "../package.json" with { type: "json" };

/** An agent's name on the registry: one word, no scope — the same rule as an agent id. */
export const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Staged in a temporary folder; `type`, when given, is the kind it must be. */
export async function stageFromRegistry(id: string, type?: "agent" | "view" | "widget" | "tool") {
  const { catalogIndexUrl, fetchCatalog, needsNewerApp, stageEntry } = await import("@hivemind/core/plugin-catalog");
  const { plugins, skipped } = await fetchCatalog();
  const entry = plugins.find((e) => e.id === id);
  if (!entry) {
    const unreadable = skipped.find((s) => s.id === id);
    if (unreadable) throw new Error(`${id} is on the registry, but this Hivemind cannot read its entry: ${unreadable.reason}`);
    throw new Error(`${id} is not on the registry (${catalogIndexUrl()})`);
  }
  if (type && entry.type !== type) throw new Error(`${id} is a${entry.type === "agent" ? "n" : ""} ${entry.type} — use \`hive ${entry.type === "agent" ? "agents" : "plugins"} install ${id}\``);
  const tooNew = needsNewerApp(entry, pkg.version);
  if (tooNew) throw new Error(tooNew);
  return { dir: await stageEntry(entry), entry };
}
