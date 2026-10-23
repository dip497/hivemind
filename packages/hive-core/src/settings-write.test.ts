/**
 * What a write by this build leaves in settings.json (settings-write.ts), through the writers the
 * app, main and `hive` use. The file is the contract: an older build writes a file a newer one
 * reads, and the other way round.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ACCENTS, PRESETS, SETTINGS_VERSION, applyPreset, importAppearance, mergeSettings } from "./settings-schema.js";
import { patchSettingsExtras, patchSettingsFile, readSettings, updateSettings, writeSettings } from "./settings.js";

let dir = "";
let file = "";
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-settings-write-")); file = path.join(dir, "settings.json"); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const put = (json: unknown) => fs.writeFileSync(file, JSON.stringify(json));
const disk = () => JSON.parse(fs.readFileSync(file, "utf8"));

/** A file a newer build wrote: keys of its own at the top, in every section and in every group
 *  this build rebuilds, and a value this build does not know (Track B's and C's keys among them). */
const NEWER = {
  v: 2,
  appearanceExtra: { accent: { custom: "#ff5500" }, fonts: [{ family: "Harbour Sans" }], theme: { id: "@dip497/harbour", before: { preset: "signal" } } },
  notifications: { enabled: true, sound: true, sounds: { needsYou: "chime" } },
  appearance: {
    preset: "harbour", accent: "graphite", radius: 6, later: 1,
    palette: { bg: "#101010", tint: "#202020" },
    glass: { enabled: true, blur: 12, frost: 0.4 },
    wallpaper: { kind: "aurora", brightness: 0.8, parallax: true },
    terminal: { background: "#000000", ligatures: true },
    lookBefore: { glass: true, wallpaper: "aurora", radius: 8, shadows: "soft" },
  },
  views: {
    defaultView: "canvas", later: 1,
    layers: { status: "all", density: "compact" },
    chrome: { canvas: { island: "top", dock: "left" }, orbit: { island: "floating" } },
    toolbars: { canvas: { labels: true, size: "s" } },
  },
  plugins: { later: 1, state: { "agent:claude": { enabled: true, pinned: true, options: { model: "opus" } } } },
  agents: { defaultAgent: "claude", later: 1 },
  profile: { name: "Dee", later: 1 },
  network: { updateCheck: true, later: 1 },
  browserApp: { enabled: false, port: 4483, names: [], later: 1 },
  quit: { whenRunning: "ask", later: 1 },
};

/** Each writer the app, main and `hive` use, changing one thing, and whether it forgets
 *  `lookBefore` by this build's own rule (choosing a preset or importing a look forgets it). */
const WRITERS: [string, () => Promise<unknown>, boolean][] = [
  ["a patch (the app, hive config set)", () => patchSettingsFile([{ path: "appearance.glass.blur", value: 20 }], file), false],
  ["a mutation (hive theme use)", () => updateSettings((cur) => ({ ...cur, appearance: applyPreset(cur.appearance, PRESETS.nord!) }), file), true],
  ["a section written whole (a theme import)", () => updateSettings((cur) => ({ ...cur, appearance: importAppearance({ preset: "nord", radius: 4 }, cur.appearance) }), file, ["appearance"]), true],
  ["the whole settings (writeSettings)", async () => writeSettings(await readSettings(file), file), false],
  ["an extra key (main's browserCdp)", () => patchSettingsExtras({ browserCdp: true }, file), false],
];

/** Every key and value of `NEWER` this build does not read, by its path. */
const UNREAD: [string, unknown][] = [
  ["appearanceExtra", NEWER.appearanceExtra], ["notifications", NEWER.notifications],
  ["appearance.later", 1], ["appearance.palette.tint", "#202020"], ["appearance.glass.frost", 0.4],
  ["appearance.wallpaper.parallax", true], ["appearance.terminal.ligatures", true], ["appearance.lookBefore.shadows", "soft"],
  ["views.later", 1], ["views.layers.density", "compact"], ["views.chrome.canvas.dock", "left"], ["views.chrome.orbit.island", "floating"],
  ["views.toolbars.canvas.size", "s"], ["plugins.later", 1], ["plugins.state.agent:claude.pinned", true],
  ["agents.later", 1], ["profile.later", 1], ["network.later", 1], ["browserApp.later", 1], ["quit.later", 1],
];
const at = (o: unknown, p: string) => p.split(".").reduce<unknown>((x, k) => (x as Record<string, unknown> | undefined)?.[k], o);

describe("a write by this build", () => {
  test.each(WRITERS)("keeps every key and value a newer build wrote, and its v: %s", async (_, write, forgetsLookBefore) => {
    put(NEWER);
    await write();
    const after = disk();
    const kept = UNREAD.filter(([p]) => !(forgetsLookBefore && p.startsWith("appearance.lookBefore.")));
    expect(kept.map(([p]) => [p, at(after, p)])).toEqual(kept);
    if (forgetsLookBefore) expect(after.appearance.lookBefore).toBeUndefined();
    expect(after.v).toBe(2);
  });

  test("an id this build does not know reads as the default and stays in the file until that setting is set here", async () => {
    put({ ...NEWER, appearance: { ...NEWER.appearance, accent: "custom" } });
    const read = await readSettings(file);
    // Today's merge on a file a newer build wrote: a valid accent, and the preset's id as it is.
    expect([read.appearance.accent in ACCENTS, read.appearance.preset, read.views.chrome.orbit]).toEqual([true, "harbour", undefined]);
    await patchSettingsFile([{ path: "appearance.radius", value: 10 }], file);
    expect([disk().appearance.accent, disk().views.chrome.orbit]).toEqual(["custom", { island: "floating" }]);
    // Set here, it is this build's: even to the value it read as.
    await patchSettingsFile([{ path: "appearance.accent", value: read.appearance.accent }, { path: "views.chrome.orbit.island", value: "top" }], file);
    expect([disk().appearance.accent, disk().views.chrome.orbit]).toEqual([read.appearance.accent, { island: "top" }]);
  });

  test("what a writer removes goes, the keys beside it stay", async () => {
    put(NEWER);
    // Leaving Clean forgets lookBefore; a view's island set back to its default is removed from the map.
    await updateSettings((cur) => {
      const { lookBefore: _, ...appearance } = cur.appearance;
      const { canvas: __, ...chrome } = cur.views.chrome;
      return { ...cur, appearance, views: { ...cur.views, chrome } };
    }, file);
    const after = disk();
    expect([after.appearance.lookBefore, after.views.chrome.canvas, after.views.chrome.orbit, after.appearance.later]).toEqual([undefined, undefined, { island: "floating" }, 1]);
    // A path set to undefined removes it, one this build does not read too (as migration 0002 does).
    await patchSettingsFile([{ path: "views.later", value: undefined }], file);
    expect(["later" in disk().views, disk().views.defaultView]).toEqual([false, "canvas"]);
  });
});

describe("the file's format version, v", () => {
  test("a newer file is read for what this build knows, and no write lowers its v", async () => {
    put({ v: SETTINGS_VERSION + 3, appearance: { preset: "nord", radius: 4 } });
    const read = await readSettings(file);
    expect([read.v, read.appearance.preset, read.appearance.radius]).toEqual([SETTINGS_VERSION + 3, "nord", 4]);
    // Not even a writer that names v.
    await updateSettings((cur) => ({ ...cur, v: 1 }), file, ["v"]);
    await writeSettings({ ...read, v: 1 }, file);
    expect(disk().v).toBe(SETTINGS_VERSION + 3);
  });

  test.each([
    ["absent (written by hand)", {}],
    ["below 1", { v: 0 }],
    ["not a whole number", { v: 1.5 }],
    ["not a number", { v: "2" }],
  ])("a file whose v is %s is the first format: read as 1 and written as this build's", async (_, json) => {
    put({ ...json, appearance: { radius: 4 } });
    expect((await readSettings(file)).v).toBe(1);
    await patchSettingsFile([{ path: "views.defaultView", value: "orbit" }], file);
    expect([disk().v, disk().appearance.radius]).toEqual([SETTINGS_VERSION, 4]);
  });

  test("a missing or broken file is written whole, as every build wrote it", async () => {
    for (const before of [undefined, "{ not json", "[1,2]"]) {
      if (before === undefined) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, before);
      await patchSettingsFile([{ path: "views.defaultView", value: "orbit" }], file);
      expect(disk()).toEqual(JSON.parse(JSON.stringify({ ...mergeSettings({ views: { defaultView: "orbit" } }), v: SETTINGS_VERSION })));
    }
  });
});
