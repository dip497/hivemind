/**
 * Every agent this repository writes, loaded into the catalog the way a machine that has
 * installed them would see it.
 *
 * Most of ours ship from the plugin catalog now rather than inside the app, so a test that
 * asks what `gemini` does is asking about an agent this app does not carry — exactly as a
 * user sees it before they install it. Loading the union keeps those tests about detection
 * instead of about packaging.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { BUILTIN_CATALOG, defFromManifest, setCatalog } from "@hivemind/agents";

const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "packages", "hive-agents", "tests", "fixtures", "published-agents");

export function useAuthoredAgents(): void {
  const catalog = readdirSync(EXAMPLES, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({
      // `dir` is where an installed agent's own files (pi's extension, kiro's hook) are
      // read from — in the fixtures it is the fixture folder itself.
      ...defFromManifest(YAML.parse(readFileSync(join(EXAMPLES, d.name, "agent.yaml"), "utf8")) as unknown),
      dir: join(EXAMPLES, d.name),
    }));
  // Fixture entries come last, so a def that now ships from the catalog wins over its
  // still-bundled twin and the tests see what a user who installed it sees.
  setCatalog([...BUILTIN_CATALOG, ...catalog]);
}
