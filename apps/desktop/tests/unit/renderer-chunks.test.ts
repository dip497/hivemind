// Build-size guard for the renderer's default path: what paints the first frame
// must stay small, and the heavy things must stay off it. Reads the built bundle
// (out/renderer) — CI builds before unit tests; locally, run `pnpm build` first
// (the test skips with a message when there is no build to inspect, never silently).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../out/renderer");
/** The entry chunk size to hold (bytes). A growth beyond
 *  the margin means something heavy joined the default path. Update the
 *  baseline deliberately, in the same commit as the change that moved it. */
// Re-baselined at milestone 6b: settings.json plumbing (schema, settings +
// theme stores) is on the default path by design — the theme must paint on the
// first frame. The Settings dialog's own pages are a lazy chunk.
// Re-baselined again for pluggable agents: the catalog, manifest defs and the
// presence store paint the toolbar's agent button on the first frame, so they
// cannot be lazy. Checked: no YAML parser, editor or three.js on this path.
const ENTRY_BASELINE = 861_467;
const ENTRY_MARGIN = 0.04;

test("the default renderer path stays small, and three.js is gone from the build", (t) => {
  const html = path.join(OUT, "index.html");
  if (!fs.existsSync(html)) { t.skip("no renderer build in out/ — run `pnpm build` first"); return; }
  const index = fs.readFileSync(html, "utf8");
  const eager = [...index.matchAll(/assets\/([^"']+\.js)/g)].map((m) => m[1]!);
  const entry = eager.find((f) => f.startsWith("index-"));
  assert.ok(entry, "index.html references an entry chunk");
  const entrySize = fs.statSync(path.join(OUT, "assets", entry)).size;
  assert.ok(entrySize <= ENTRY_BASELINE * (1 + ENTRY_MARGIN), `entry chunk grew to ${entrySize} bytes (baseline ${ENTRY_BASELINE} +${ENTRY_MARGIN * 100}%)`);
  // The World view was three.js's only reader. With it gone the dependency is gone
  // too — this fails if anything quietly brings it back.
  const assets = fs.readdirSync(path.join(OUT, "assets"));
  assert.ok(!assets.some((f) => /three/i.test(f)), "no three.js chunk is built at all");
});
