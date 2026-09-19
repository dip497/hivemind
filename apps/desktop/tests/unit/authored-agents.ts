/**
 * Every agent this repository writes, loaded into the catalog the way a machine that
 * has installed them would see it.
 *
 * Nothing ships inside the app any more: every agent — these included — arrives as a
 * manifest from the plugin catalog. A test that asks what `gemini` does is asking about
 * an agent this app does not carry — exactly as a user sees it before they install it.
 * Loading the fixture set keeps those tests about detection instead of about packaging.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { defFromManifest, setCatalog, type AgentProviderDef } from "@hivemind/agents";

const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "packages", "hive-agents", "tests", "fixtures", "published-agents");

function scan(): AgentProviderDef[] {
  return readdirSync(EXAMPLES, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({
      // `dir` is where an installed agent's own files (pi's extension, kiro's hook) are
      // read from — in the fixtures it is the fixture folder itself.
      ...defFromManifest(YAML.parse(readFileSync(join(EXAMPLES, d.name, "agent.yaml"), "utf8")) as unknown),
      dir: join(EXAMPLES, d.name),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const AUTHORED_DEFS: readonly AgentProviderDef[] = scan();

/** One agent's def, with its dir — the tests' stand-in for an installed agent. */
export function authoredDef(id: string): AgentProviderDef {
  const def = AUTHORED_DEFS.find((d) => d.id === id);
  if (!def) throw new Error(`no published fixture agent "${id}"`);
  return def;
}

/** A file an agent ships beside its manifest, as the daemon would read it from its dir. */
export function authoredAsset(id: string, file: string): string {
  return readFileSync(join(EXAMPLES, id, file), "utf8");
}

export function useAuthoredAgents(): void {
  setCatalog(AUTHORED_DEFS);
}
