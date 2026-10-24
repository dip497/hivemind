// Extracts the OpenAPI response schemas the fake's schema check needs from Atlassian's specs,
// with every `$ref` they reach and without prose, into ../fixtures/openapi-schemas.json.
//
//   bun scripts/extract-schemas.ts <platform-v3.json> <software-agile.json>
//
// The specs themselves (~3 MB) are not committed; fixtures/README.md names their versions.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Schema = Record<string, unknown>;
type Spec = { info: { version: string }; components: { schemas: Record<string, Schema> }; paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema?: Schema }> }> }>> };

const KEEP = new Set(["type", "properties", "additionalProperties", "required", "items", "enum", "allOf", "oneOf", "anyOf", "$ref", "nullable", "maxItems", "minItems", "maxLength", "minimum", "maximum", "uniqueItems"]);

function strip(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(strip);
  if (!s || typeof s !== "object") return s;
  const out: Schema = {};
  for (const [k, v] of Object.entries(s)) {
    if (!KEEP.has(k)) continue;
    out[k] = k === "properties" ? Object.fromEntries(Object.entries(v as Schema).map(([p, ps]) => [p, strip(ps)])) : strip(v);
  }
  return out;
}

function closure(spec: Spec, roots: Schema[]): Record<string, Schema> {
  const out: Record<string, Schema> = {};
  const visit = (s: unknown) => {
    if (Array.isArray(s)) return s.forEach(visit);
    if (!s || typeof s !== "object") return;
    const ref = (s as Schema).$ref;
    if (typeof ref === "string") {
      const name = ref.split("/").at(-1)!;
      if (!out[name]) { out[name] = strip(spec.components.schemas[name]) as Schema; visit(out[name]); }
    }
    for (const v of Object.values(s)) visit(v);
  };
  roots.forEach(visit);
  return out;
}

const [v3Path, agilePath] = process.argv.slice(2);
if (!v3Path || !agilePath) { console.error("usage: bun scripts/extract-schemas.ts <v3.json> <agile.json>"); process.exit(2); }
const v3 = JSON.parse(readFileSync(v3Path, "utf8")) as Spec;
const agile = JSON.parse(readFileSync(agilePath, "utf8")) as Spec;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const response = (spec: Spec, path: string, method = "get") => strip(spec.paths[path]![method]!.responses["200"]!.content!["application/json"]!.schema) as Schema;

// Responses the test validates. The sprint list has no response schema in the spec, so the test
// wraps SprintBean itself.
const v3Roots: Record<string, Schema> = {
  myself: ref("User"),
  "search/jql": ref("SearchAndReconcileResults"),
  "issue/bulkfetch": ref("BulkIssueResults"),
  transitions: ref("Transitions"),
  "project/statuses": { type: "array", items: ref("IssueTypeWithStatus") },
  StatusDetails: ref("StatusDetails"),
  UserDetails: ref("UserDetails"),
  IssueTypeDetails: ref("IssueTypeDetails"),
};
const agileRoots: Record<string, Schema> = {
  "board/configuration": response(agile, "/rest/agile/1.0/board/{boardId}/configuration"),
  board: response(agile, "/rest/agile/1.0/board"),
  SprintBean: ref("SprintBean"),
};
const out = {
  source: { platform: v3.info.version, software: agile.info.version },
  v3: { roots: v3Roots, components: { schemas: closure(v3, Object.values(v3Roots)) } },
  agile: { roots: agileRoots, components: { schemas: closure(agile, Object.values(agileRoots)) } },
};
writeFileSync(join(import.meta.dirname, "..", "fixtures", "openapi-schemas.json"), `${JSON.stringify(out, null, 1)}\n`);
console.log(`v3: ${Object.keys(out.v3.components.schemas).length} components, agile: ${Object.keys(out.agile.components.schemas).length}`);
