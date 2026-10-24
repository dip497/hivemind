/**
 * What the app's settings writers leave in settings.json when a newer build wrote it: choosing a
 * preset, a plugin's option. The fake bridge hands each patch list to main's own writer
 * (`patchSettingsFile`) on a settings.json of the test's, so the assertions are on the file.
 *
 * The store binds `window.hive` at import time, so the fake bridge is installed before the
 * dynamic imports.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PRESETS, mergeSettings } from "@hivemind/core/settings-schema";
import { patchSettingsFile } from "@hivemind/core/settings";

type Patch = { path: string; value: unknown };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-settings-writers-"));
const file = path.join(dir, "settings.json");
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
const disk = (): Record<string, any> => JSON.parse(fs.readFileSync(file, "utf8"));

(globalThis as unknown as { window: unknown }).window = {
  addEventListener() {},
  removeEventListener() {},
  localStorage: { getItem: () => null },
  hive: {
    settingsSync: () => mergeSettings({}),
    settingsPatch: (patches: Patch[]) => patchSettingsFile(patches, file),
    onSettingsChanged: () => () => {},
  },
};

const store = await import("../../src/renderer/src/settings-store");
const theme = await import("../../src/renderer/src/theme-store");

/** Put `json` in the file and show it to the store, as a reload would. */
async function load(json: Record<string, unknown>): Promise<void> {
  fs.writeFileSync(file, JSON.stringify(json));
  // A no-op write rebases the store on the file.
  store.patchSettings("views.defaultView", mergeSettings(json).views.defaultView);
  await store.saveSettingsNow();
}

test("choosing a preset in the app replaces an accent and a mode this build does not know, as `hive theme use` does", async () => {
  await load({
    v: 2,
    appearance: { preset: "harbour", mode: "dim", accent: "saffron", wallpaper: { kind: "aurora-2", brightness: 0.7 } },
    appearanceExtra: { accent: { brand: "#ff5500", accent: "#ff7700" } },
  });
  theme.choosePreset(PRESETS.nord!);
  await store.saveSettingsNow();
  const a = disk().appearance;
  // Read here as dark and graphite, they are still the preset's to write; the wallpaper, which a
  // colour preset leaves alone, stays the newer build's.
  assert.deepEqual([a.preset, a.mode, a.accent, a.wallpaper.kind, disk().appearanceExtra], ["nord", "dark", "ice", "aurora-2", {}]);
});

test("a colour setting's Theme button stores \"\", the theme's own colour, even where the field's default is a colour", async () => {
  await load({ plugins: { state: { "view:isles": { options: { sea: "#00ff88" } } } } });
  store.setPluginOption("view", "isles", "sea", "");
  await store.saveSettingsNow();
  assert.deepEqual(disk().plugins.state["view:isles"], { options: { sea: "" } });
});

test("a plugin's last option put back to its default keeps what a newer build keeps in its record", async () => {
  await load({ plugins: { state: { "view:isles": { options: { fog: true }, pinned: true } } } });
  store.setPluginOption("view", "isles", "fog", undefined);
  await store.saveSettingsNow();
  assert.deepEqual(disk().plugins.state["view:isles"], { pinned: true });
});
