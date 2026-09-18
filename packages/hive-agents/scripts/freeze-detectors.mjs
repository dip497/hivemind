#!/usr/bin/env bun
// Record what the agents Hivemind wrote DO, so a rewrite of how they are written cannot
// change it: what each detector answers over the whole corpus (one hash), and the argv and
// tile label each produces across every option combination. Bundled or catalog — which is
// which is a packaging choice, and moving one must not drop it out of the suite.
//   bun scripts/freeze-detectors.mjs
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { spawnArgsFor, spawnLabelFor } from "../src/catalog.js";
import { defFromManifest } from "../src/manifest.js";
import { NODE_PARTS } from "../src/node.js";
import { AUTHORED, authoredYaml } from "../tests/authored.js";
import { CORPUS } from "../tests/corpus.js";

const MODES = [undefined, "default", "plan", "acceptEdits", "bypassPermissions", "ask", "yolo", "high"];
const MODELS = [undefined, "default", "opus", "gpt-5"];

const golden = {
  screens: CORPUS.length,
  // What the hashes below were taken over, so a moved corpus says so instead of looking
  // like every detector changed at once.
  corpus: CORPUS.reduce((h, s) => h.update(s).update("\u0000"), createHash("sha256")).digest("hex"),
  detectors: {}, spawn: {},
};
for (const agent of AUTHORED) {
  const def = defFromManifest(YAML.parse(authoredYaml(agent)), { trusted: agent.bundled, nodeHalf: !!NODE_PARTS[agent.id] });
  if (def.detect) {
    const states = CORPUS.map((screen) => def.detect(screen)).join(",");
    golden.detectors[def.id] = createHash("sha256").update(states).digest("hex");
  }
  const rows = [];
  for (const mode of MODES) {
    for (const model of MODELS) {
      const opts = { ...(mode ? { mode } : {}), ...(model ? { model } : {}) };
      rows.push({ opts, args: spawnArgsFor(def, opts), label: spawnLabelFor(def, 2, opts) });
    }
  }
  golden.spawn[def.id] = rows;
}
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "detector-golden.json");
writeFileSync(out, JSON.stringify(golden, null, 2) + "\n");
console.log(`froze ${Object.keys(golden.detectors).length} detectors over ${CORPUS.length} screens, and argv for ${Object.keys(golden.spawn).length} agents`);
