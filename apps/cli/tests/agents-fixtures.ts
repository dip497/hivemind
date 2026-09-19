/** The published agent fixtures, for tests that need a machine with agents installed.
 *  Nothing is compiled in any more, so tests stand in for the auto-install step. */
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defFromManifest, setCatalog, type AgentProviderDef } from "@hivemind/agents";
import YAML from "yaml";

const EXAMPLES = join(import.meta.dir, "..", "..", "..", "packages", "hive-agents", "tests", "fixtures", "published-agents");

/** Load the named fixture agents (all of them by default) into the live catalog,
 *  the way a machine that has installed them would see it. */
export function useFixtureAgents(ids?: readonly string[]): AgentProviderDef[] {
  const all = (ids ?? fixtureIds()).map((id) =>
    defFromManifest(YAML.parse(readFileSync(join(EXAMPLES, id, "agent.yaml"), "utf8")) as unknown));
  setCatalog(all);
  return all;
}

function fixtureIds(): string[] {
  return readdirSync(EXAMPLES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

/** A fresh XDG dir with the named fixture agents installed under hivemind/agents —
 *  hand one as XDG_CONFIG_HOME to a `hive` subprocess. */
export function fixtureXDG(ids: readonly string[]): string {
  const xdg = mkdtempSync(join(tmpdir(), "hive-cli-xdg-"));
  for (const id of ids) {
    const dest = join(xdg, "hivemind", "agents", id);
    mkdirSync(dest, { recursive: true });
    copyFileSync(join(EXAMPLES, id, "agent.yaml"), join(dest, "agent.yaml"));
  }
  return xdg;
}
