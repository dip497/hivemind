#!/usr/bin/env bun
// HiveHub's listings + their manifests → docs/src/data/plugins.json
//
// The site cannot import @hivemind/agents (docs is its own npm project, outside the pnpm
// workspace), and a second copy of the disclosure rules would drift from the one the app
// enforces. So the real validator runs here, at build time, and the site reads the result:
// what a plugin is, what it will tell you before it installs, and the file itself.
//   bun scripts/build-site-catalog.mjs          (HIVEHUB_URL to read another registry)
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { defFromManifest, agentDisclosures } from "../packages/hive-agents/src/manifest.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const hub = (process.env.HIVEHUB_URL || "https://hivehub.griiken.workers.dev").replace(/\/$/, "");
// Every listing, with the manifest it was published with: the site says what HiveHub serves.
const catalog = await (await fetch(`${hub}/api/v1/plugins?limit=500`)).json();

const entries = catalog.plugins.map((p) => {
  const base = {
    id: p.id, type: p.type, name: p.name, description: p.description,
    author: p.author, version: p.version,
    ...(p.homepage ? { homepage: p.homepage } : {}),
    ...(p.bin ? { bin: p.bin } : {}),
    ...(p.icon ? { icon: p.icon } : {}),
  };
  if (p.type !== "agent") return { ...base, does: [], reads: [] };

  const source = p.manifest;
  if (!source) return { ...base, does: [], reads: [] };
  // Exactly as a stranger's machine reads it: untrusted, no daemon half.
  const def = defFromManifest(YAML.parse(source), { trusted: false, nodeHalf: false });
  return {
    ...base,
    manifest: source,
    worker: def.caps.turnSignal,
    resumes: def.caps.resume !== "none",
    supervises: def.caps.supervise !== "human",
    // The same words the app shows in its install review.
    does: agentDisclosures(def),
    options: (def.options ?? []).map((o) => ({ id: o.id, label: o.label, flag: o.flag ?? null })),
    install: def.install ?? null,
    note: def.note ?? null,
  };
});

const out = JSON.stringify({ generated: `scripts/build-site-catalog.mjs from ${hub}`, plugins: entries }, null, 2) + "\n";
const dest = path.join(root, "docs", "src", "data", "plugins.json");
writeFileSync(dest, out);
console.log(`site catalog: ${entries.length} plugins from ${hub}`);
