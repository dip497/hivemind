// Vendor the installer into the site, so `curl https://hivemind.griiken.com/install.sh` serves
// the same script the repository ships. Runs before every build; the committed copy is what a
// container build (which has only docs/ in its context) falls back to.
//
//   node scripts/sync-install.mjs [--check]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(here, "../../install.sh");
const OUT = path.resolve(here, "../public/install.sh");
const check = process.argv.includes("--check");

if (!existsSync(SOURCE)) {
  if (check) { console.error("install: ../install.sh is missing — run --check in a full checkout"); process.exit(1); }
  if (!existsSync(OUT)) { console.error("install: no ../install.sh and no vendored copy"); process.exit(1); }
  console.log("install: ../install.sh not present — keeping the vendored copy");
  process.exit(0);
}

const script = readFileSync(SOURCE, "utf8");
if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== script) { console.error("install.sh is stale: run `npm run install:sync` in docs/"); process.exit(1); }
  console.log("install.sh current");
} else {
  writeFileSync(OUT, script);
  console.log(`install.sh synced — ${script.split("\n").length} lines`);
}
