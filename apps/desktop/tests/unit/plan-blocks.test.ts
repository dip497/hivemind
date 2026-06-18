/** Plan block parsing + the annotation → feedback formatter (pure). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlanToBlocks, exportAnnotations } from "../../src/renderer/src/plan-review/blocks.ts";
import type { Annotation } from "../../src/renderer/src/plan-review/types.ts";

const PLAN = `# Title

First paragraph.

- item one
- item two

\`\`\`ts
const x = 1;
\`\`\``;

test("parsePlanToBlocks: splits top-level blocks with stable ids", () => {
  const blocks = parsePlanToBlocks(PLAN);
  const types = blocks.map((b) => b.type);
  assert.deepEqual(types, ["heading", "paragraph", "list", "code"]);
  assert.deepEqual(blocks.map((b) => b.id), ["b0", "b1", "b2", "b3"]);
  assert.match(blocks[3].raw, /const x = 1/);
});

test("parsePlanToBlocks: degenerate input still yields a block", () => {
  assert.equal(parsePlanToBlocks("").length, 1);
  assert.equal(parsePlanToBlocks("   \n  ").length, 1);
});

const ann = (p: Partial<Annotation>): Annotation => ({
  id: Math.random().toString(36).slice(2),
  blockId: null,
  kind: "global",
  originalText: "",
  createdAt: 0,
  ...p,
});

test("exportAnnotations: empty → bare 'Changes requested.'", () => {
  assert.equal(exportAnnotations([], []), "Changes requested.");
});

test("exportAnnotations: orders deletions, comments (plan order), then global", () => {
  const blocks = parsePlanToBlocks(PLAN);
  const out = exportAnnotations(blocks, [
    ann({ kind: "global", comment: "Overall too vague", createdAt: 5 }),
    ann({ kind: "comment", blockId: "b2", originalText: "item two", comment: "drop this", createdAt: 2 }),
    ann({ kind: "deletion", blockId: "b3", originalText: "const x = 1;", createdAt: 3 }),
    ann({ kind: "comment", blockId: "b1", originalText: "First paragraph.", quickLabel: "Nit", createdAt: 1 }),
  ]);
  // Deletion first.
  assert.match(out, /## 1\. Remove this/);
  assert.match(out, /const x = 1;/);
  // Comments next, in PLAN order: b1 (Nit) before b2.
  const nitIdx = out.indexOf("[Nit]");
  const dropIdx = out.indexOf("drop this");
  assert.ok(nitIdx > 0 && dropIdx > nitIdx, "b1 comment precedes b2 comment");
  // Global last.
  assert.match(out, /## 4\. General feedback about the plan/);
  assert.match(out, /Overall too vague/);
  assert.match(out, /4 pieces of feedback/);
});

test("exportAnnotations: fences code longer than inner backticks", () => {
  const blocks = parsePlanToBlocks("text");
  const out = exportAnnotations(blocks, [
    ann({ kind: "deletion", blockId: "b0", originalText: "has ``` triple ticks", createdAt: 0 }),
  ]);
  assert.match(out, /````/); // a 4-backtick fence wraps the triple-tick content
});
