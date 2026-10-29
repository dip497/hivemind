// Main's start-view offers (start-view-offers.ts): a package that opens with a view, or offers a
// live wallpaper, installed anywhere but Settings, is offered once — after a relaunch too — only
// while it is on and its view loads, never when Settings already offered it, and again on an update
// only when it opens with another. Driven at the owner's boundary (`next`, `offeredInSettings`) over
// packages really installed through core into a config folder of the test's own.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installPackage, rollbackPackage, switchPackage } from "@hivemind/core/package-install";
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
const ISLE = { package: "@acme/harbour", name: "Harbour", view: "@acme/isle", wallpaper: null };

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
  await offers.offeredInSettings(r.record.id, r.record.version, { view: r.startView });
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

test("a view the window did not load is not offered until it does", async () => {
  await installPackage(harbour("1.0.0", "@acme/isle"));
  const offers = new StartViewOffers(file);
  // The first ask can come before the window's views load.
  assert.deepEqual(await offers.next({ registered: ["canvas"], showing: "canvas" }), []);
  assert.deepEqual(await offers.next(LOADED), [ISLE]);
});

test("a view the window already shows is only recorded, not offered later", async () => {
  await installPackage(harbour("1.0.0", "@acme/isle"));
  const offers = new StartViewOffers(file);
  assert.deepEqual(await offers.next({ registered: LOADED.registered, showing: "@acme/isle" }), []);
  assert.deepEqual(await offers.next(LOADED), []);
});

test("a rollback to a version whose view was offered is not offered again", async () => {
  await installPackage(harbour("1.0.0", "@acme/isle"));
  const offers = new StartViewOffers(file);
  assert.deepEqual(await offers.next(LOADED), [ISLE]);
  await installPackage(harbour("2.0.0", "@acme/dock"));
  assert.deepEqual(await offers.next(LOADED), [{ ...ISLE, view: "@acme/dock" }]);
  await rollbackPackage("@acme/harbour");
  assert.deepEqual(await offers.next(LOADED), [], "back to Isle, offered before");
  await rollbackPackage("@acme/harbour");
  assert.deepEqual(await new StartViewOffers(file).next(LOADED), [], "forward to Dock, offered before, after a relaunch too");
});

test("a record the disk refuses still offers, once this session, and Settings' record does not fail", async () => {
  await installPackage(harbour("1.0.0", "@acme/isle"));
  // Its folder is a file: nothing can be written under it.
  writeFileSync(path.join(tmp, "user-data"), "");
  const offers = new StartViewOffers(file);
  await offers.offeredInSettings("@acme/other", "1.0.0", { view: "@acme/other-view" });
  assert.deepEqual(await offers.next(LOADED), [ISLE]);
  assert.deepEqual(await offers.next(LOADED), []);
});

test("two windows asking at once: only one is offered it", async () => {
  await installPackage(harbour("1.0.0", "@acme/isle"));
  const offers = new StartViewOffers(file);
  const both = await Promise.all([offers.next(LOADED), offers.next(LOADED)]);
  assert.deepEqual(both.flat(), [ISLE]);
});

/** Package @acme/harbour holding the view Isle and the live wallpaper Sea, offering what `start` names. */
function harbourAndSea(version: string, start: { view?: string; wallpaper?: string }): string {
  const root = path.join(tmp, `sea-${version}-${Object.values(start).join("-") || "none"}`);
  const files: Record<string, string> = {
    "hivemind-package.json": JSON.stringify({ apiVersion: 2, id: "@acme/harbour", name: "Harbour", version, views: [{ path: "views/isle" }], wallpapers: [{ path: "wallpapers/sea" }], startup: start }),
    "views/isle/hivemind-view.json": JSON.stringify({ id: "@acme/isle", name: "isle", version, entry: "index.html" }),
    "views/isle/index.html": "<!doctype html>",
    "wallpapers/sea/hivemind-wallpaper.json": JSON.stringify({ protocol: 2, name: "Sea", entry: "main.js" }),
    "wallpapers/sea/main.js": "",
  };
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), text);
  }
  return root;
}
const SEA = "@acme/harbour/sea";

test("a package offering its live wallpaper is offered it once, in the same offer as its view, and not while it is already the background", async () => {
  await installPackage(harbourAndSea("1.0.0", { view: "@acme/isle", wallpaper: SEA }));
  const offers = new StartViewOffers(file);
  assert.deepEqual(await offers.next({ ...LOADED, background: "mono" }), [{ ...ISLE, wallpaper: SEA }]);
  assert.deepEqual(await offers.next({ ...LOADED, background: "mono" }), []);
  assert.deepEqual(await new StartViewOffers(file).next({ ...LOADED, background: "mono" }), []);
  // Another computer, where the person already draws it: only recorded.
  rmSync(path.dirname(file), { recursive: true, force: true });
  const there = new StartViewOffers(file);
  assert.deepEqual(await there.next({ ...LOADED, background: SEA }), [ISLE]);
  assert.deepEqual(await there.next({ ...LOADED, background: "mono" }), []);
});

test("Settings' own offer of a wallpaper is never made again, and an update offering another one is", async () => {
  const r = await installPackage(harbourAndSea("1.0.0", { wallpaper: SEA }));
  const offers = new StartViewOffers(file);
  await offers.offeredInSettings(r.record.id, r.record.version, { view: r.startView, wallpaper: r.startWallpaper });
  assert.deepEqual(await offers.next(LOADED), []);
  await installPackage(harbourAndSea("1.1.0", { wallpaper: SEA }));
  assert.deepEqual(await offers.next(LOADED), [], "the same wallpaper, newer, was already offered");
});

test("what was offered before wallpapers were is read as it was: its views stay offered, and its wallpaper is offered", async () => {
  await installPackage(harbourAndSea("1.0.0", { view: "@acme/isle", wallpaper: SEA }));
  // The file as this app wrote it before: views only.
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ v: 1, offered: { "@acme/harbour": { version: "1.0.0", views: ["@acme/isle"] } } }));
  assert.deepEqual(await new StartViewOffers(file).next(LOADED), [{ ...ISLE, view: null, wallpaper: SEA }]);
});

test("Settings offering a wallpaper over a record from before wallpapers records it, so no window offers it again", async () => {
  const r = await installPackage(harbourAndSea("1.0.0", { view: "@acme/isle", wallpaper: SEA }));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ v: 1, offered: { "@acme/harbour": { version: "1.0.0", views: ["@acme/isle"] } } }));
  const offers = new StartViewOffers(file);
  await offers.offeredInSettings(r.record.id, r.record.version, { view: r.startView, wallpaper: r.startWallpaper });
  assert.deepEqual(await offers.next(LOADED), []);
});
