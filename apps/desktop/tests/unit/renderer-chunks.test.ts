// Build-size guard for the lazy World view: three.js must not be in the
// default renderer path. Reads the built bundle (out/renderer) — CI builds
// before unit tests; locally, run `pnpm build` first (the test skips with a
// message when there is no build to inspect, never silently).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out/renderer");
/** The entry chunk size when the World view landed (bytes). A growth beyond
 *  the margin means something heavy joined the default path. Update the
 *  baseline deliberately, in the same commit as the change that moved it. */
// Re-baselined at milestone 6b: settings.json plumbing (schema, settings +
// theme stores) is on the default path by design — the theme must paint on the
// first frame. The Settings dialog's own pages are a lazy chunk.
const ENTRY_BASELINE = 813_910;
const ENTRY_MARGIN = 0.04;

test("the default renderer path does not carry three.js; the three chunk exists and is lazy", (t) => {
  const html = path.join(OUT, "index.html");
  if (!fs.existsSync(html)) { t.skip("no renderer build in out/ — run `pnpm build` first"); return; }
  const index = fs.readFileSync(html, "utf8");
  const eager = [...index.matchAll(/assets\/([^"']+\.js)/g)].map((m) => m[1]!);
  const entry = eager.find((f) => f.startsWith("index-"));
  assert.ok(entry, "index.html references an entry chunk");
  const entrySize = fs.statSync(path.join(OUT, "assets", entry)).size;
  assert.ok(entrySize <= ENTRY_BASELINE * (1 + ENTRY_MARGIN), `entry chunk grew to ${entrySize} bytes (baseline ${ENTRY_BASELINE} +${ENTRY_MARGIN * 100}%)`);
  const assets = fs.readdirSync(path.join(OUT, "assets"));
  const three = assets.find((f) => /^vendor-three-.*\.js$/.test(f));
  assert.ok(three, "a vendor-three-*.js chunk exists");
  assert.ok(!eager.some((f) => f.startsWith("vendor-three-")), "index.html does not preload/reference the three chunk");
  // The entry may NAME the chunk inside its dynamic-import preload map (Vite
  // lists a lazy chunk's dependencies there); a STATIC import is the failure.
  const entrySrc = fs.readFileSync(path.join(OUT, "assets", entry), "utf8");
  assert.ok(!/(from|import)\s*["']\.\/vendor-three-/.test(entrySrc), "the entry chunk does not import the three chunk statically");
  const world = assets.find((f) => /^WorldView-.*\.js$/.test(f));
  assert.ok(world, "the World view is its own lazy chunk");
});
