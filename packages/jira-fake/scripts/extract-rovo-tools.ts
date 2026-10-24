// Builds ../fixtures/rovo-mcp-tools.json, the fake Rovo MCP server's tool list, from two captures
// of the live https://mcp.atlassian.com/v2/mcp:
//
//   bun scripts/extract-rovo-tools.ts <tools-v2.json> <operations-v2.json>
//
// - tools-v2.json: a `tools/list` answer from plain /v2/mcp (the primary tools, full inputSchema),
//   as clssck/atl-cli commits it at mcp/tools-v2.json.
// - operations-v2.json: `discover` run on every operation name (name, product, runner, inputs),
//   as clssck/atl-cli commits it at mcp/operations-v2.json.
//
// Descriptions are cut to their first sentence: the fake needs the names, inputs and runners, not
// the prose. fixtures/README.md records the capture dates.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Json = Record<string, unknown>;
const [toolsPath, opsPath] = process.argv.slice(2);
if (!toolsPath || !opsPath) throw new Error("usage: bun scripts/extract-rovo-tools.ts <tools-v2.json> <operations-v2.json>");

const firstSentence = (s: unknown) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  const m = /^(.{20,}?[.!?])(\s|$)/.exec(t);
  return (m ? m[1]! : t).slice(0, 240);
};
function trimSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(trimSchema);
  if (!s || typeof s !== "object") return s;
  return Object.fromEntries(Object.entries(s as Json).map(([k, v]) => [k, k === "description" ? firstSentence(v) : k === "properties" ? Object.fromEntries(Object.entries(v as Json).map(([p, d]) => [p, trimSchema(d)])) : trimSchema(v)]));
}

const tools = JSON.parse(readFileSync(toolsPath, "utf8")) as { endpoint: string; serverInfo: Json; protocolVersion: string; tools: Json[] };
const ops = JSON.parse(readFileSync(opsPath, "utf8")) as { generatedAt: string; endpoint: string; operations: Json[] };

const out = {
  source: {
    primary: `tools/list on ${tools.endpoint} (clssck/atl-cli mcp/tools-v2.json)`,
    operations: `discover on ${ops.endpoint}, ${ops.generatedAt} (clssck/atl-cli mcp/operations-v2.json)`,
  },
  serverInfo: tools.serverInfo,
  protocolVersion: tools.protocolVersion,
  primary: tools.tools.map((t) => ({ name: t.name, description: firstSentence(t.description), inputSchema: trimSchema(t.inputSchema), annotations: t.annotations })),
  // Inputs as `name*:type` (`*` = required), one operation per line, to keep the file small and diffable.
  operations: ops.operations.map((o) => ({
    name: o.name, product: o.product, executeTool: o.executeTool, description: firstSentence(o.description),
    inputs: (o.inputs as { name: string; type: string; required?: boolean }[]).map((i) => `${i.name}${i.required ? "*" : ""}:${i.type}`),
  })),
};
const lines = (xs: unknown[]) => xs.map((x) => `  ${JSON.stringify(x)}`).join(",\n");
const { primary, operations, ...head } = out;
const text = `${JSON.stringify(head).slice(0, -1)},\n"primary": [\n${lines(primary)}\n],\n"operations": [\n${lines(operations)}\n]}\n`;
JSON.parse(text);
writeFileSync(join(import.meta.dirname, "..", "fixtures", "rovo-mcp-tools.json"), text);
console.log(`${out.primary.length} primary tools, ${out.operations.length} operations`);
