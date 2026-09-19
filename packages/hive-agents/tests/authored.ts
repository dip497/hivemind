// Every agent Hivemind wrote, from the fixture snapshot of what we publish.
//
// One directory is the whole corpus: a snapshot of the agents we publish, built-ins included.
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { defFromManifest } from "../src/manifest.js";
import type { AgentProviderDef } from "../src/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_DIR = join(HERE, "fixtures", "published-agents");

export interface AuthoredAgent { id: string; file: string }

function scan(): AuthoredAgent[] {
  const out: AuthoredAgent[] = [];
  for (const d of readdirSync(CATALOG_DIR, { withFileTypes: true })) {
    if (d.isDirectory()) out.push({ id: d.name, file: join(CATALOG_DIR, d.name, "agent.yaml") });
  }
  // Sorted by id, never by directory order: the pool feeds a seeded shuffle, so the order
  // of this list is part of every hash in detector-golden.json.
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const AUTHORED: readonly AuthoredAgent[] = scan();
export const authoredYaml = (a: AuthoredAgent): string => readFileSync(a.file, "utf8");

/** The published agents as defs — what a machine that installed them all would have. */
export function authoredDefs(): AgentProviderDef[] {
  return AUTHORED.map((a) => defFromManifest(YAML.parse(authoredYaml(a)) as unknown));
}
