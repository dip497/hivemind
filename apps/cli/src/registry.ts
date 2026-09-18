/** Installing by name from HiveHub: `hive views install @owner/name`, `hive agents install gemini`. The catalog and the
 *  download are the app's own (`@hivemind/core/plugin-catalog`), so every file is checked
 *  against the hash HiveHub recorded when it was published — the same check the app makes. */
import pkg from "../package.json" with { type: "json" };

/** A view's name on the registry; anything else is a folder or a repository. */
export const REGISTRY_NAME = /^@[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9-]{0,63}$/;
/** An agent's name on the registry: one word, no scope — the same rule as an agent id. */
export const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export async function stageFromRegistry(id: string, type: "agent" | "view") {
  const { appMeetsMinVersion, catalogIndexUrl, fetchCatalog, stageEntry } = await import("@hivemind/core/plugin-catalog");
  const entry = (await fetchCatalog()).find((e) => e.id === id);
  if (!entry) throw new Error(`${id} is not on the registry (${catalogIndexUrl()})`);
  if (entry.type !== type) throw new Error(`${id} is a${entry.type === "agent" ? "n" : ""} ${entry.type} — use \`hive ${entry.type}s install ${id}\``);
  if (!appMeetsMinVersion(pkg.version, entry.minAppVersion)) {
    throw new Error(`${id} needs Hivemind ${entry.minAppVersion} or newer; this is ${pkg.version}`);
  }
  return { dir: await stageEntry(entry), entry };
}
