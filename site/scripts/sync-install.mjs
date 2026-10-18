// Vendor both installers into the site, so `curl https://hivemind.griiken.com/install.sh` and
// `irm https://hivemind.griiken.com/install.ps1` serve the scripts the repository ships. Runs before every build; the committed copy is what a
// container build (which has only docs/ in its context) falls back to.
//
//   node scripts/sync-install.mjs [--check]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FILES = ["install.sh", "install.ps1"];
const check = process.argv.includes("--check");

for (const name of FILES) {
  const source = path.resolve(here, "../..", name);
  const out = path.resolve(here, "../public", name);
  if (!existsSync(source)) {
    if (check) { console.error(`install: ../${name} is missing — run --check in a full checkout`); process.exit(1); }
    if (!existsSync(out)) { console.error(`install: no ../${name} and no vendored copy`); process.exit(1); }
    console.log(`install: ../${name} not present — keeping the vendored copy`);
    continue;
  }
  const script = readFileSync(source, "utf8");
  if (check) {
    const current = existsSync(out) ? readFileSync(out, "utf8") : "";
    if (current !== script) { console.error(`${name} is stale: run \`npm run install:sync\` in docs/`); process.exit(1); }
    console.log(`${name} current`);
  } else {
    writeFileSync(out, script);
    console.log(`${name} synced — ${script.split("\n").length} lines`);
  }
}
