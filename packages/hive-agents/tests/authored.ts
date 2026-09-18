// Every agent Hivemind wrote, wherever it ships from.
//
// Which agents are compiled into the app is a product decision that changes; what they answer
// must not. So the detector corpus and its golden are taken over this union — an agent moved
// out of the bundle and into the catalog keeps its hashes and keeps being tested, instead of
// quietly leaving the suite on the day it stops being bundled.
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = join(HERE, "..", "manifests");
const CATALOG_DIR = join(HERE, "..", "..", "..", "examples", "agents");

export interface AuthoredAgent { id: string; file: string; bundled: boolean }

function scan(): AuthoredAgent[] {
  const out: AuthoredAgent[] = [];
  for (const f of readdirSync(BUNDLED_DIR).filter((n) => n.endsWith(".yaml"))) {
    out.push({ id: f.replace(/\.yaml$/, ""), file: join(BUNDLED_DIR, f), bundled: true });
  }
  try {
    for (const d of readdirSync(CATALOG_DIR, { withFileTypes: true })) {
      if (d.isDirectory()) out.push({ id: d.name, file: join(CATALOG_DIR, d.name, "agent.yaml"), bundled: false });
    }
  } catch { /* a checkout without the examples is still a working package */ }
  // Sorted by id, never by directory order: the pool feeds a seeded shuffle, so the order
  // of this list is part of every hash in detector-golden.json.
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const AUTHORED: readonly AuthoredAgent[] = scan();
export const authoredYaml = (a: AuthoredAgent): string => readFileSync(a.file, "utf8");
