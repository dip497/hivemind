// Main's start-view offers (start-view-offers.ts): a package that opens with a view, installed
// anywhere but Settings, is offered once — after a relaunch too — only while it is on and its view
// loads, never when Settings already offered it, and again on an update only when it opens with
// another view. Driven at the owner's boundary (`next`, `offeredInSettings`) over packages really
// installed through core into a config folder of the test's own.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installPackage, switchPackage } from "@hivemind/core/package-install";
import { StartViewOffers } from "../../src/main/start-view-offers.ts";

let tmp: string;
let file: string;
const config = process.env.XDG_CONFIG_HOME;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "start-view-offers-"));
  process.env.XDG_CONFIG_HOME = path.join(tmp, "config");
  file = path.join(tmp, "user-data", "start-view-offers.json");
});
afterEach(() => {
  if (config === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = config;
  rmSync(tmp, { recursive: true, force: true });
});

/** Package @acme/harbour at `version`, holding views Dock and Isle, opening with `opens`; with
 *  `tool`, also a tool, so it installs switched off. */
function harbour(version: string, opens: string | null, { tool = false } = {}): string {
  const root = path.join(tmp, `harbour-${version}-${opens ?? "none"}${tool ? "-tool" : ""}`);
  const view = (name: string) => ({
    [`views/${name}/hivemind-view.json`]: JSON.stringify({ id: `@acme/${name}`, name, version, entry: "index.html" }),
    [`views/${name}/index.html`]: "<!doctype html>",
  });
  const files: Record<string, string> = {
    "hivemind-package.json": JSON.stringify({
      apiVersion: 2, id: "@acme/harbour", name: "Harbour", version,
      views: [{ path: "views/dock" }, { path: "views/isle" }], ...(tool ? { tools: [{ path: "tools/prs" }] } : {}),
      ...(opens ? { startup: { view: opens } } : {}),
    }),
    ...view("dock"), ...view("isle"),
    ...(tool ? {
      "tools/prs/hivemind-tool.json": JSON.stringify({ id: "@acme/prs", name: "PRs", version: "1.0.0", apiVersion: 1, entry: "index.js", tools: [{ key: "prs", label: "PRs", tileKind: "acme-prs" }] }),
      "tools/prs/index.js": "export default { tiles: {} };",
    } : {}),
  };
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), text);
  }
  return root;
}

const LOADED = { registered: ["canvas", "@acme/dock", "@acme/isle"], showing: "canvas" };
const ISLE = { package: "@acme/harbour", name: "Harbour", view: "@acme/isle" };

test("a package installed outside Settings is offered once, and not again after a relaunch", async () => {
  await installPackage(harbour("1.0.0", "@acme/isle"));
  const offers = new StartViewOffers(file);
  assert.deepEqual(await offers.next(LOADED), [ISLE]);
  assert.deepEqual(await offers.next(LOADED), []);
  // A relaunch: a new owner reading what the last one kept.
  assert.deepEqual(await new StartViewOffers(file).next(LOADED), []);
});

test("one switched off is not offered, and is once switched on", async () => {
  await installPackage(harbour("1.0.0", "@acme/isle", { tool: true }));
  const offers = new StartViewOffers(file);
  assert.deepEqual(await offers.next(LOADED), []);
  await switchPackage("@acme/harbour", true);
  assert.deepEqual(await offers.next(LOADED), [ISLE]);
});

test("one Settings installed and offered itself is never offered again", async () => {
  const r = await installPackage(harbour("1.0.0", "@acme/isle"));
  const offers = new StartViewOffers(file);
  await offers.offeredInSettings(r.record.id, r.record.version, r.startView!);
  assert.deepEqual(await offers.next(LOADED), []);
  assert.deepEqual(await new StartViewOffers(file).next(LOADED), []);
});

test("an update is offered again only when it opens with another view", async () => {
  await installPackage(harbour("1.0.0", "@acme/isle"));
  const offers = new StartViewOffers(file);
  assert.deepEqual(await offers.next(LOADED), [ISLE]);
  await installPackage(harbour("1.1.0", "@acme/isle"));
  assert.deepEqual(await offers.next(LOADED), [], "the same view, newer, was already offered");
  await installPackage(harbour("2.0.0", "@acme/dock"));
  assert.deepEqual(await offers.next(LOADED), [{ ...ISLE, view: "@acme/dock" }]);
});

test("a view the window did not load is not offered until it does; one it shows is only recorded", async () => {
  await installPackage(harbour("1.0.0", "@acme/isle"));
  const offers = new StartViewOffers(file);
  assert.deepEqual(await offers.next({ registered: ["canvas"], showing: "canvas" }), []);
  assert.deepEqual(await offers.next({ registered: LOADED.registered, showing: "@acme/isle" }), []);
  assert.deepEqual(await offers.next(LOADED), [], "already on it: recorded, so not offered later");
});

test("two windows asking at once: only one is offered it", async () => {
  await installPackage(harbour("1.0.0", "@acme/isle"));
  const offers = new StartViewOffers(file);
  const both = await Promise.all([offers.next(LOADED), offers.next(LOADED)]);
  assert.deepEqual(both.flat(), [ISLE]);
});
