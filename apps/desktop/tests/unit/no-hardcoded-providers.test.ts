// Guard: no agent provider is named outside its own catalog def. The desktop
// UI, the daemon, HCP, the CLI and hive-core must read @hivemind/agents — a
// provider id, binary or alias appearing as a string literal in their source
// means a registry has drifted back into being hand-maintained.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUTHORED_DEFS } from "./authored-agents.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..", "..");
/** The host library: what any client or agent plugin builds on. */
const HOST = [path.join(ROOT, "packages/agent-host/src"), path.join(ROOT, "packages/agent-sdk/src")];
// Every app's sources and the shared core package (templates, installer). Tests
// and the catalog package itself are the only places a provider may be named.
const SCAN = [path.join(ROOT, "apps/desktop/src"), path.join(ROOT, "apps/cli/src"), path.join(ROOT, "packages/hive-core/src"), ...HOST];

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
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p); // tests may name providers
  }
  return out;
}

/** Strip // line comments and /* block comments *\/ — prose may name agents. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("no provider id or binary is hard-coded outside @hivemind/agents", () => {
  const names = new Set<string>();
  for (const d of AUTHORED_DEFS) { names.add(d.id); names.add(d.bin); for (const a of d.aliases ?? []) names.add(a); }
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

test("the host library names no agent at all — not in code, not in prose, not a vendor's directory", () => {
  const names = new Set<string>();
  for (const d of AUTHORED_DEFS) { names.add(d.id); names.add(d.bin); for (const a of d.aliases ?? []) names.add(a); }
  // Ids that are also ordinary words (a JS keyword, a terminal's cursor) are held to the
  // string-literal rule above only.
  for (const w of ["continue", "cursor"]) names.delete(w);
  const words = [...names].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // A name as a word of its own, a vendor's env prefix, or a home directory an agent keeps.
  const re = new RegExp(`\\b(${words.join("|")})\\b|\\b(${words.map((w) => w.toUpperCase()).join("|")})_|~?/\\.(${words.join("|")})\\b`, "gi");
  const hits: string[] = [];
  for (const dir of HOST) {
    for (const file of walk(dir)) {
      const src = fs.readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) hits.push(`${path.relative(ROOT, file)}:${src.slice(0, m.index).split("\n").length} ${m[0]}`);
    }
  }
  assert.deepEqual(hits, [], `agent names in the host library:\n  ${hits.join("\n  ")}`);
});
