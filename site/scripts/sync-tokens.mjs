// Vendor the app's design tokens into the site. The renderer's stylesheet is canonical; this
// copies the declarations (and the notes beside them, which carry the reasoning) into JSON the
// brand page can import. Runs before every build, so the page cannot drift from the app.
//
//   node scripts/sync-tokens.mjs [--check]
//
// --check exits non-zero when the committed file is stale, for CI.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const SOURCE = "apps/desktop/src/renderer/src/styles.css";
const OUT = path.resolve(here, "../src/generated/tokens.json");

// A container (or any checkout of docs/ alone) has no app beside it. The vendored JSON is
// committed precisely so a build there still works; only --check insists on the real file.
const sourcePath = path.join(ROOT, SOURCE);
if (!existsSync(sourcePath)) {
  if (process.argv.includes("--check")) {
    console.error(`tokens: ${SOURCE} is missing — run --check where the whole repo is present`);
    process.exit(1);
  }
  if (!existsSync(OUT)) {
    console.error(`tokens: no ${SOURCE} and no vendored copy at ${OUT}`);
    process.exit(1);
  }
  console.log(`tokens: ${SOURCE} not present — keeping the vendored copy`);
  process.exit(0);
}
const css = readFileSync(sourcePath, "utf8");

// `--name: value;` plus the comment trailing it on the same line, which is where the app keeps
// its reasoning ("near-white: at work is not a call to action").
const re = /^[ \t]*--([a-z0-9-]+):[ \t]*([^;]+);(?:[ \t]*\/\*[ \t]*(.*?)[ \t]*\*\/)?/gim;
const tokens = {};
for (const m of css.matchAll(re)) {
  const [, name, value, note] = m;
  if (!tokens[name]) tokens[name] = { name, value: value.trim(), ...(note ? { note } : {}) };
}

const payload = JSON.stringify({ source: SOURCE, count: Object.keys(tokens).length, tokens }, null, 2) + "\n";
if (process.argv.includes("--check")) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== payload) {
    console.error(`tokens are stale: run \`npm run tokens:sync\` in docs/ (${SOURCE} changed)`);
    process.exit(1);
  }
  console.log(`tokens current — ${Object.keys(tokens).length} from ${SOURCE}`);
} else {
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, payload);
  console.log(`tokens synced — ${Object.keys(tokens).length} from ${SOURCE}`);
}
