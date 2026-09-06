// Guard: no agent provider is named outside its own catalog def. The desktop
// UI, the daemon, HCP and the CLI must read @hivemind/agents — a provider id
// or binary appearing as a string literal in their source means a registry has
// drifted back into being hand-maintained.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG } from "@hivemind/agents";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..", "..");
const SCAN = [path.join(ROOT, "apps/desktop/src"), path.join(ROOT, "apps/cli/src")];

/** Files allowed to carry a provider name, each with the reason. */
const ALLOW: Record<string, string> = {
  // The agent tile kind's persisted value is the historical id of the first
  // provider; it is a tile kind, not a provider reference (see the comment there).
  "apps/desktop/src/renderer/src/tile-kinds.ts": "AGENT_TILE_KIND legacy kind value",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Strip // line comments and /* block comments *\/ — prose may name agents. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("no provider id or binary is hard-coded outside @hivemind/agents", () => {
  const names = new Set<string>();
  for (const d of CATALOG) { names.add(d.id); names.add(d.bin); for (const a of d.aliases ?? []) names.add(a); }
  const re = new RegExp(`(["'\`])(${[...names].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\1`, "g");
  const hits: string[] = [];
  for (const dir of SCAN) {
    for (const file of walk(dir)) {
      const rel = path.relative(ROOT, file);
      if (ALLOW[rel]) continue;
      const src = code(fs.readFileSync(file, "utf8"));
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const line = src.slice(0, m.index).split("\n").length;
        hits.push(`${rel}:${line} ${m[0]}`);
      }
    }
  }
  assert.deepEqual(hits, [], `provider names hard-coded outside their catalog def:\n  ${hits.join("\n  ")}`);
});
