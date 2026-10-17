// One place for updates: whether the app checks for new versions is switched on About and updates,
// beside the version and the check, and on no other page. Read from source, as the registry's
// renderers are: which file draws the switch, and in which page's block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../src/renderer/src/", import.meta.url));
const files = (readdirSync(SRC, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f));
const read = (f: string) => readFileSync(join(SRC, f), "utf8");

test("the update check is switched on About and updates only", () => {
  const drawn = files.filter((f) => /<UpdateCheckSwitch\b/.test(read(f)));
  assert.deepEqual(drawn, ["App.tsx"]);
  const app = read("App.tsx");
  const at = app.indexOf("<UpdateCheckSwitch");
  const about = app.lastIndexOf('{page === "about"', at);
  const next = app.indexOf("{page === ", about + 1);
  assert.ok(about >= 0 && at < next, "the switch is drawn inside the About page's block");
  // Nothing else turns it on or off.
  assert.deepEqual(files.filter((f) => read(f).includes('"network.updateCheck"')), ["update-check.tsx"]);
});
