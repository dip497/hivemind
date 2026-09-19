import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ACCENTS, DEFAULT_APPEARANCE, DEFAULT_SETTINGS, ISLAND_PLACEMENTS, PRESETS, UBUNTU, SIGNAL, applyPreset, flattenAppearance, getPath, mergeSettings, migrateLegacy, nestAppearance, setPath, terminalThemeFor,
} from "./settings-schema.js";
import { BUILTIN_TOOLBAR_ACTIONS, resolveToolbar } from "./toolbar.js";
import { SettingsLockError, breakSettingsLock, patchSettingsExtras, patchSettingsFile, readSettings, settingsPath, updateSettings, writeSettings } from "./settings.js";

// The pre-2.0 literal from TerminalTile.tsx, verbatim: the ubuntu preset must
// derive exactly this (byte-identical terminal output).
const TERM_THEME_LEGACY = {
  background: "#300A24", foreground: "#FFFFFF", cursor: "#FFFFFF", cursorAccent: "#300A24", selectionBackground: "rgba(255,255,255,0.25)",
  black: "#2E3436", brightBlack: "#555753", red: "#CC0000", brightRed: "#EF2929", green: "#4E9A06", brightGreen: "#8AE234",
  yellow: "#C4A000", brightYellow: "#FCE94F", blue: "#3465A4", brightBlue: "#729FCF", magenta: "#75507B", brightMagenta: "#AD7FA8",
  cyan: "#06989A", brightCyan: "#34E2E2", white: "#D3D7CF", brightWhite: "#EEEEEC",
};

describe("settings schema", () => {
  test("golden: the ubuntu preset still derives the pre-2.0 terminal theme exactly", () => {
    expect(terminalThemeFor(UBUNTU.terminal)).toEqual(TERM_THEME_LEGACY);
  });

  test("a fresh install is on signal: the default appearance is that preset, whole", () => {
    expect(DEFAULT_APPEARANCE.preset).toBe("signal");
    expect(DEFAULT_APPEARANCE.accent).toBe("graphite");
    expect(DEFAULT_APPEARANCE.palette).toEqual(SIGNAL.palette);
    expect(terminalThemeFor(DEFAULT_APPEARANCE.terminal)).toEqual(terminalThemeFor(SIGNAL.terminal));
  });

  test("every preset is complete: 13 palette tokens, 16 ansi colours, a known accent", () => {
    for (const p of Object.values(PRESETS)) {
      expect(Object.keys(p.palette)).toHaveLength(13);
      expect(p.terminal.ansi).toHaveLength(16);
      expect(p.accent in ACCENTS).toBe(true);
      const a = applyPreset(DEFAULT_APPEARANCE, p);
      expect(a.preset).toBe(p.id);
      expect(mergeSettings({ appearance: a }).appearance).toEqual(a); // survives validation unchanged
    }
  });

  test("views.chrome: every island placement round-trips, junk is dropped", () => {
    const s = mergeSettings({
      v: 1,
      views: {
        defaultView: "canvas",
        chrome: {
          canvas: { island: "top" },
          windows: { island: "bottom" },
          world: { island: "hidden" },
          orbit: { island: "off" },
          solar: { island: "left" },      // not a placement → dropped
          office: { island: 3 },          // not a string → dropped
          "../x": { island: "off" },      // not an id → dropped
          mars: {},                       // no placement → no entry
        },
      },
    });
    expect(s.views.chrome).toEqual({
      canvas: { island: "top" },
      windows: { island: "bottom" },
      world: { island: "hidden" },
      orbit: { island: "off" },
    });
    // ISLAND_PLACEMENTS is the whole vocabulary — a UI can render it directly.
    expect(ISLAND_PLACEMENTS).toEqual(["top", "bottom", "hidden", "off"]);
    for (const island of ISLAND_PLACEMENTS) {
      expect(mergeSettings({ v: 1, views: { chrome: { world: { island } } } }).views.chrome.world).toEqual({ island });
    }
  });

  test("views.chrome: `off` survives the CLI patch path and a later partial merge", () => {
    // `hive config set views.chrome.world '{"island":"off"}'` is setPath onto the
    // settings as read, then a merge — the same path the desktop patch takes.
    const cur = mergeSettings({ v: 1, views: { chrome: { world: { island: "hidden" } } } });
    const patched = mergeSettings(setPath(cur, "views.chrome.world", { island: "off" }), cur);
    expect(patched.views.chrome.world).toEqual({ island: "off" });
    expect(getPath(patched, "views.chrome.world.island")).toBe("off");

    // An unrelated later edit must not resurrect the old placement or drop it.
    expect(mergeSettings({ v: 1, appearance: { accent: "ember" } }, patched).views.chrome.world)
      .toEqual({ island: "off" });

    // Regression for the fallback itself: a patch that omits `views` entirely
    // must keep every per-view placement, not just the one being read here.
    const many = mergeSettings({ v: 1, views: { chrome: { canvas: { island: "top" }, world: { island: "off" } } } });
    expect(mergeSettings({ v: 1, agents: { model: "opus" } }, many).views.chrome)
      .toEqual({ canvas: { island: "top" }, world: { island: "off" } });

    // Clearing the override (back to the view's default) is deleting the entry.
    const cleared = mergeSettings(setPath(patched, "views.chrome", {}), patched);
    expect(cleared.views.chrome).toEqual({});

    // A bad value from a hand-edited file leaves no entry rather than an invalid one.
    expect(mergeSettings(setPath(patched, "views.chrome.world", { island: "nowhere" }), patched).views.chrome.world)
      .toBeUndefined();
  });

  test("views.toolbars: normalization — order kept, deduped, unknowns dropped, empty preserved", () => {
    const s = mergeSettings({
      v: 1,
      views: {
        chrome: {},
        toolbars: {
          canvas: { actions: ["theme", "terminal", "theme", "ghost"], labels: false },
          world: { actions: [] },                    // deliberate empty toolbar
          windows: { labels: true },                 // labels only (opt-IN), actions default
          orbit: { actions: "terminal" },            // not an array → no preference
          solar: {},                                 // nothing meaningful → no entry
          "../x": { actions: ["agent"] },            // not a view id → dropped
        },
      },
    });
    expect(s.views.toolbars).toEqual({
      canvas: { actions: ["theme", "terminal"], labels: false }, // dedupe + drop unknown, false kept
      world: { actions: [] },
      windows: { labels: true },
    });
    // Absent view → catalog defaults; the stored shape feeds resolveToolbar directly.
    expect(resolveToolbar(s.views.toolbars.mars)).toEqual(BUILTIN_TOOLBAR_ACTIONS);
    expect(resolveToolbar(s.views.toolbars.world)).toEqual([]);
    expect(resolveToolbar(s.views.toolbars.canvas).map((a) => a.id)).toEqual(["theme", "terminal"]);
    // The render flag rides on the preferences; absent means icon-only (the
    // host default is FALSE, so this setting changes nothing for existing users).
    expect(s.views.toolbars.canvas!.labels).toBe(false);
    expect(s.views.toolbars.world!.labels ?? false).toBe(false);
    expect(s.views.toolbars.windows!.labels ?? false).toBe(true);
    expect(resolveToolbar(s.views.toolbars.windows)).toEqual(BUILTIN_TOOLBAR_ACTIONS);

    // An explicit list of only-unknown ids is stored as [] and resolves to [].
    const ghosts = mergeSettings({ v: 1, views: { toolbars: { canvas: { actions: ["ghost", "nope"] } } } });
    expect(ghosts.views.toolbars.canvas).toEqual({ actions: [] });
    expect(resolveToolbar(ghosts.views.toolbars.canvas)).toEqual([]);

    // A long hand-written list is bounded and still deduped.
    const many = mergeSettings({ v: 1, views: { toolbars: { canvas: { actions: Array(200).fill("agent") } } } });
    expect(many.views.toolbars.canvas).toEqual({ actions: ["agent"] });
  });

  test("views.toolbars: partial merges preserve it; an explicit {} resets", () => {
    const cur = mergeSettings({ v: 1, views: { toolbars: { canvas: { actions: ["terminal"], labels: false } } } });
    // A patch that does not mention `views` at all keeps every toolbar.
    expect(mergeSettings({ v: 1, appearance: { accent: "ember" } }, cur).views.toolbars)
      .toEqual({ canvas: { actions: ["terminal"], labels: false } });
    // A patch that mentions `views` but not `toolbars` keeps them too.
    expect(mergeSettings({ v: 1, views: { defaultView: "world" } }, cur).views.toolbars)
      .toEqual({ canvas: { actions: ["terminal"], labels: false } });
    // The CLI patch path: setPath then merge.
    const patched = mergeSettings(setPath(cur, "views.toolbars.world", { actions: [], labels: true }), cur);
    expect(patched.views.toolbars.world).toEqual({ actions: [], labels: true });
    expect(patched.views.toolbars.canvas).toEqual({ actions: ["terminal"], labels: false });
    // Explicit {} is the reset — back to catalog defaults everywhere.
    const reset = mergeSettings(setPath(patched, "views.toolbars", {}), patched);
    expect(reset.views.toolbars).toEqual({});
    expect(resolveToolbar(reset.views.toolbars.canvas)).toEqual(BUILTIN_TOOLBAR_ACTIONS);
    // Fresh settings start empty (no per-view overrides at all).
    expect(DEFAULT_SETTINGS.views.toolbars).toEqual({});
    expect(mergeSettings(undefined).views.toolbars).toEqual({});
  });

  test("tools: a fresh install has every plugin off; a pre-tools v:1 file keeps its Browser", () => {
    // Missing file / no input at all → defaults → nothing enabled.
    expect(mergeSettings(undefined).tools).toEqual({ enabledPlugins: [], disabledTools: [] });
    expect(DEFAULT_SETTINGS.tools).toEqual({ enabledPlugins: [], disabledTools: [] });
    expect(mergeSettings({}).tools.enabledPlugins).toEqual([]); // an object with no `v` is not a v:1 file

    // An EXISTING v:1 file written before the section existed: that user had the
    // Browser tile unconditionally, so migrate them to the enabled plugin.
    const legacy = mergeSettings({ v: 1, appearance: {}, views: {}, plugins: {}, agents: {}, migrated: true });
    expect(legacy.tools).toEqual({ enabledPlugins: ["hivemind/web"], disabledTools: [] });

    // Once the section exists it is authoritative — including deliberately empty.
    expect(mergeSettings({ v: 1, tools: { enabledPlugins: [], disabledTools: [] } }).tools.enabledPlugins).toEqual([]);
    expect(mergeSettings({ v: 1, tools: { enabledPlugins: ["hivemind/web"], disabledTools: ["hivemind/web/browser"] } }).tools)
      .toEqual({ enabledPlugins: ["hivemind/web"], disabledTools: ["hivemind/web/browser"] });
  });

  test("tools: a PARTIAL v:1 merge onto existing settings never re-enables the plugin", () => {
    // The user switched the Browser OFF. Every later edit reaches mergeSettings as
    // a partial object that also carries `v: 1` and no `tools` key — the same
    // shape as a legacy file. Treating that as a load would silently turn the
    // Browser back on the moment they changed a colour.
    const off = mergeSettings({ v: 1, tools: { enabledPlugins: [], disabledTools: [] } });
    expect(off.tools.enabledPlugins).toEqual([]);

    const patched = mergeSettings({ v: 1, appearance: { accent: "ember" } }, off);
    expect(patched.tools).toEqual({ enabledPlugins: [], disabledTools: [] });
    expect(patched.appearance.accent).toBe("ember"); // the patch still applied

    // Same for a user who had it ON and edits something unrelated.
    const on = mergeSettings({ v: 1, tools: { enabledPlugins: ["hivemind/web"], disabledTools: ["hivemind/web/browser"] } });
    expect(mergeSettings({ v: 1, views: { defaultView: "world" } }, on).tools)
      .toEqual({ enabledPlugins: ["hivemind/web"], disabledTools: ["hivemind/web/browser"] });

    // …and the load path still migrates (no base given = a file from disk).
    expect(mergeSettings({ v: 1, appearance: {} }).tools.enabledPlugins).toEqual(["hivemind/web"]);
  });

  test("tools: ids are validated, deduped and bounded", () => {
    const s = mergeSettings({
      v: 1,
      tools: {
        enabledPlugins: ["hivemind/web", "hivemind/web", "NoCaps/x", "noslash", "a/b/c", 7, "ok-org/ok-name"],
        disabledTools: ["hivemind/web/browser", "hivemind/web/browser", "hivemind/web", "bad id/x/y"],
      },
    });
    expect(s.tools.enabledPlugins).toEqual(["hivemind/web", "ok-org/ok-name"]); // deduped, malformed dropped
    expect(s.tools.disabledTools).toEqual(["hivemind/web/browser"]);            // a plugin id is not a tool id

    const many = mergeSettings({ v: 1, tools: { enabledPlugins: Array.from({ length: 500 }, (_, i) => `org/p${i}`) } });
    expect(many.tools.enabledPlugins.length).toBe(200); // bounded
    expect(mergeSettings({ v: 1, tools: { enabledPlugins: "hivemind/web" } }).tools.enabledPlugins).toEqual([]);
  });

  test("mergeSettings: junk falls back per field, values are clamped, unknown keys dropped", () => {
    const s = mergeSettings({
      v: 99, appearance: { preset: 7, glass: { opacity: 5, blur: "x", enabled: "yes" }, wallpaper: { kind: "lava", videoSrc: "blob:abc" }, terminal: { ansi: ["#000"] }, palette: { bg: "javascript:alert(1)" }, pluginSurfaces: "glass" },
      views: { defaultView: "orbit", chrome: { orbit: { island: "left" }, world: { island: "hidden" }, "../x": { island: "top" } } },
      plugins: { disabled: ["a", 3, "b"] }, agents: { defaultAgent: "" }, extra: true,
    });
    expect(s.v).toBe(1);
    expect(s.appearance.preset).toBe("signal");
    expect(s.appearance.glass).toEqual({ ...DEFAULT_APPEARANCE.glass, opacity: 0.95 });
    expect(s.appearance.wallpaper).toEqual({ kind: DEFAULT_APPEARANCE.wallpaper.kind, videoSrc: undefined, imageSrc: undefined, brightness: 0.85 });
    expect(s.appearance.terminal.ansi[0]).toBe("#000");
    expect(s.appearance.terminal.ansi[1]).toBe(SIGNAL.terminal.ansi[1]);
    expect(s.appearance.palette.bg).toBe(SIGNAL.palette.bg);
    expect(s.appearance.pluginSurfaces).toBe("theme");
    expect(s.views).toEqual({ defaultView: "orbit", chrome: { world: { island: "hidden" } }, toolbars: {} });
    expect(s.plugins.disabled).toEqual(["a", "b"]);
    // Empty stays empty: "" means "whatever the agent catalog's default is".
    expect(s.agents.defaultAgent).toBe(DEFAULT_SETTINGS.agents.defaultAgent);
    expect("extra" in s).toBe(false);
  });

  test("flatten/nest round-trips an appearance", () => {
    const a = applyPreset({ ...DEFAULT_APPEARANCE, radius: 8, glass: { ...DEFAULT_APPEARANCE.glass, contentGlass: true }, wallpaper: { kind: "video", videoSrc: "hm-media://v/x", brightness: 0.6 } }, PRESETS.nord!);
    expect(nestAppearance(flattenAppearance(a))).toEqual(a);
  });

  test("migrateLegacy: the old flat theme blob + view mode + agent keys land in settings", () => {
    const s = migrateLegacy({
      theme: { glass: false, blur: 12, opacity: 0.5, wallpaper: "mesh", accent: "rose", videoSrc: "blob:dead", animate: false, contentGlass: true, contentOpacity: 0.4, overlayMedia: { id: "o1", url: "hivemedia://media/x.png", kind: "image", opacity: 0.5, fit: "tile", size: 0.5, anchor: "top-left" } },
      viewMode: "windows", agentSel: "codex", claudeMode: "plan", claudeModel: "opus",
    });
    expect(s.migrated).toBe(true);
    expect(s.appearance.glass).toEqual({ enabled: false, contentGlass: true, opacity: 0.5, blur: 12, contentOpacity: 0.4, animate: false });
    expect(s.appearance.wallpaper.kind).toBe("mesh");
    expect(s.appearance.wallpaper.videoSrc).toBeUndefined(); // dead blob dropped
    expect(s.appearance.accent).toBe("rose");
    expect(s.appearance.overlayMedia).toHaveLength(1);
    expect(s.appearance.preset).toBe("signal");
    expect(s.views.defaultView).toBe("windows");
    expect(s.agents).toEqual({ disabled: [], defaultAgent: "codex", options: { claude: { model: "opus", mode: "plan" } }, autoInstall: true, declined: [], fromCatalog: [] });
    expect(migrateLegacy({}).migrated).toBe(true);
  });

  test("agent options: per agent, validated, and the old global pair moves to claude", () => {
    const s = mergeSettings({ v: 1, agents: { options: { claude: { model: "opus", mode: "", "Bad Key": "x" }, "../x": { model: "y" }, codex: "nope" } } });
    expect(s.agents.options).toEqual({ claude: { model: "opus" } });
    const old = mergeSettings({ v: 1, agents: { defaultAgent: "codex", model: "sonnet", permissionMode: "default" } });
    expect(old.agents).toEqual({ disabled: [], defaultAgent: "codex", options: { claude: { model: "sonnet" } }, autoInstall: true, declined: [], fromCatalog: [] });
    const off = mergeSettings({ v: 1, agents: { autoInstall: false, declined: ["aider", "../x", 3] } });
    expect(off.agents.autoInstall).toBe(false);
    expect(off.agents.declined).toEqual(["aider"]);
  });

  test("getPath/setPath: dotted access, immutable set, prototype keys refused", () => {
    const s = DEFAULT_SETTINGS;
    expect(getPath(s, "appearance.glass.blur")).toBe(18);
    expect(getPath(s, "appearance.nope.x")).toBeUndefined();
    const n = setPath(s, "appearance.glass.blur", 8);
    expect(getPath(n, "appearance.glass.blur")).toBe(8);
    expect(s.appearance.glass.blur).toBe(18);
    expect(() => setPath(s, "__proto__.polluted", 1)).toThrow();
  });
});

describe("plugin ids in settings", () => {
  // Dropping one of these is silent, which is why each is pinned: a declined agent that is
  // dropped gets installed again at the next start, and per-view choices vanish on reload.
  test("an @owner/name view and a bare agent survive a save and reload wherever they are keys", () => {
    const cur = mergeSettings({}, DEFAULT_SETTINGS);
    let next = setPath(cur, "agents.declined", ["aider", "gemini"]);
    next = setPath(next, "agents.fromCatalog", ["amp"]);
    next = setPath(next, "agents.options", { aider: { model: "big" } });
    next = setPath(next, "views.chrome", { "@dip497/board": { island: "top" } });
    const back = mergeSettings(JSON.parse(JSON.stringify(next)), cur);
    expect(back.agents.declined).toEqual(["aider", "gemini"]);
    expect(back.agents.fromCatalog).toEqual(["amp"]);
    expect(back.agents.options.aider).toEqual({ model: "big" });
    expect(Object.keys(back.views.chrome)).toContain("@dip497/board");
  });

  test("what is not an agent id is dropped — a scope included — and option names stay plain", () => {
    const cur = mergeSettings({}, DEFAULT_SETTINGS);
    const next = setPath(setPath(cur, "agents.declined", ["dip497/aider", "@dip497/aider", "../x"]), "agents.options", { aider: { "@evil/opt": "x", model: "ok" } });
    const back = mergeSettings(JSON.parse(JSON.stringify(next)), cur);
    expect(back.agents.declined).toEqual([]);
    expect(back.agents.options.aider).toEqual({ model: "ok" });
  });
});

describe("settings file", () => {
  let tmp: string;
  const saved = { HIVE_SETTINGS: process.env.HIVE_SETTINGS, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-settings-")); delete process.env.HIVE_SETTINGS; process.env.XDG_CONFIG_HOME = tmp; });
  afterEach(() => { process.env.HIVE_SETTINGS = saved.HIVE_SETTINGS; process.env.XDG_CONFIG_HOME = saved.XDG_CONFIG_HOME; fs.rmSync(tmp, { recursive: true, force: true }); });

  test("path honours HIVE_SETTINGS then XDG; missing file reads as defaults; write is atomic and round-trips", async () => {
    expect(settingsPath()).toBe(path.join(tmp, "hivemind", "settings.json"));
    process.env.HIVE_SETTINGS = path.join(tmp, "custom.json");
    expect(settingsPath()).toBe(path.join(tmp, "custom.json"));
    expect(await readSettings()).toEqual(mergeSettings(DEFAULT_SETTINGS));
    const next = mergeSettings({ appearance: applyPreset(DEFAULT_APPEARANCE, PRESETS.dracula!), views: { defaultView: "world" } });
    await writeSettings(next);
    expect(fs.readdirSync(tmp).filter((f) => f.endsWith(".tmp"))).toEqual([]); // no temp file left behind
    expect(await readSettings()).toEqual(next);
    fs.writeFileSync(settingsPath(), "{ not json");
    expect((await readSettings()).appearance.preset).toBe("signal");
  });

  test("a write keeps top-level keys the schema does not own (the app's browserCdp flag)", async () => {
    process.env.HIVE_SETTINGS = path.join(tmp, "with-extras.json");
    fs.writeFileSync(settingsPath(), JSON.stringify({ browserCdp: true, browserCdpPort: "9333" }));
    await writeSettings(mergeSettings({ views: { defaultView: "world" } }));
    const raw = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    expect(raw.browserCdp).toBe(true);
    expect(raw.browserCdpPort).toBe("9333");
    expect(raw.views.defaultView).toBe("world");
  });
});

describe("settings concurrency", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-settings-race-"));
    process.env.HIVE_SETTINGS = path.join(dir, "settings.json");
  });

  test("REGRESSION: a snapshot write loses a concurrent update; updateSettings does not", async () => {
    // The old renderer path: read now, write the whole object 150ms later.
    const stale = await readSettings();
    await writeSettings({ ...stale, appearance: applyPreset(stale.appearance, PRESETS.nord!) }); // the CLI
    await writeSettings({ ...stale, views: { ...stale.views, defaultView: "world" } });          // the debounce
    expect((await readSettings()).appearance.preset).toBe("signal"); // ← the bug: nord reverted

    // The same two writers through updateSettings: both edits survive.
    fs.rmSync(settingsPath(), { force: true });
    const snapshot = await readSettings();
    void snapshot; // deliberately unused: a mutation never writes back a snapshot
    await updateSettings((cur) => ({ ...cur, appearance: applyPreset(cur.appearance, PRESETS.nord!) }));
    await updateSettings((cur) => ({ ...cur, views: { ...cur.views, defaultView: "world" } }));
    const merged = await readSettings();
    expect(merged.appearance.preset).toBe("nord");
    expect(merged.views.defaultView).toBe("world");
  });

  test("concurrent writers to different paths all land (serialized, none lost)", async () => {
    await Promise.all([
      patchSettingsFile([{ path: "appearance.glass.blur", value: 20 }]),
      patchSettingsFile([{ path: "appearance.accent", value: "ember" }]),
      patchSettingsFile([{ path: "views.defaultView", value: "windows" }]),
      patchSettingsFile([{ path: "agents.options.claude.model", value: "opus" }]),
    ]);
    const s = await readSettings();
    expect(s.appearance.glass.blur).toBe(20);
    expect(s.appearance.accent).toBe("ember");
    expect(s.views.defaultView).toBe("windows");
    expect(s.agents.options.claude?.model).toBe("opus");
  });

  test("a patch is validated like any other write, and unknown top-level keys survive it", async () => {
    fs.writeFileSync(settingsPath(), JSON.stringify({ browserCdp: true }));
    const s = await patchSettingsFile([{ path: "appearance.glass.blur", value: 999 }]);
    expect(s.appearance.glass.blur).toBe(24); // clamped by mergeAppearance
    expect(JSON.parse(fs.readFileSync(settingsPath(), "utf8")).browserCdp).toBe(true);
  });

  test("legacy top-level blobs and the theme are written concurrently without erasing each other", async () => {
    // The app keeps `browserCdp` and `notifications` in the SAME settings.json as
    // the theme (identical path in a packaged app). Both used to be written with
    // a read-then-write, which erases whatever the other wrote in between.
    await Promise.all([
      patchSettingsExtras({ browserCdp: true }),
      patchSettingsFile([{ path: "appearance.accent", value: "ember" }]),
      patchSettingsExtras({ notifications: { enabled: false } }),
      updateSettings((cur) => ({ ...cur, appearance: applyPreset(cur.appearance, PRESETS.nord!) })),
      patchSettingsFile([{ path: "views.defaultView", value: "windows" }]),
    ]);

    const raw = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    expect(raw.browserCdp).toBe(true);                     // legacy blob survived
    expect(raw.notifications).toEqual({ enabled: false }); // legacy blob survived
    expect(raw.views.defaultView).toBe("windows");         // schema write survived
    expect(["ember", PRESETS.nord!.accent]).toContain(raw.appearance.accent);
    expect(raw.appearance.palette.bg).toBe(PRESETS.nord!.palette.bg); // preset survived
    expect(await readSettings()).toEqual(mergeSettings(raw)); // still a valid settings file
  });

  test("extras cannot bypass the schema or assign prototype keys", async () => {
    for (const key of ["appearance", "agents", "__proto__", "constructor", "prototype"]) {
      await expect(patchSettingsExtras(JSON.parse(`{"${key}":{}}`))).rejects.toThrow("not an extra settings key");
    }
  });

  test("an extras patch leaves the schema settings untouched, and removes a key set to undefined", async () => {
    await patchSettingsFile([{ path: "agents.options.claude.model", value: "opus" }]);
    await patchSettingsExtras({ browserCdp: true, legacyThing: 1 });
    let raw = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    expect(raw.agents.options.claude.model).toBe("opus");
    expect(raw.legacyThing).toBe(1);

    await patchSettingsExtras({ legacyThing: undefined });
    raw = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    expect("legacyThing" in raw).toBe(false);
    expect(raw.browserCdp).toBe(true);
    expect(raw.agents.options.claude.model).toBe("opus");
  });

  test("a lock we do not own is NEVER deleted, however old it looks — the write fails safely", async () => {
    // Age cannot prove death: this is exactly what a slow-but-live writer looks
    // like, and deleting it would let two writers edit the file at once.
    const lock = `${settingsPath()}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ v: 1 })); // a file to protect
    fs.writeFileSync(lock, "someone-else");
    fs.utimesSync(lock, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
    const before = fs.readFileSync(settingsPath(), "utf8").toString();

    await expect(patchSettingsFile([{ path: "agents.options.claude.model", value: "sonnet" }])).rejects.toBeInstanceOf(SettingsLockError);

    expect(fs.readFileSync(lock, "utf8")).toBe("someone-else"); // untouched
    expect(fs.readFileSync(settingsPath(), "utf8").toString()).toBe(before); // nothing written
  }, 20_000);

  test("explicit recovery clears a lock left behind, and writes work again", async () => {
    const lock = `${settingsPath()}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "dead-writer");
    expect(await breakSettingsLock()).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
    expect(await breakSettingsLock()).toBe(false); // nothing left to clear
    const s = await patchSettingsFile([{ path: "agents.options.claude.model", value: "sonnet" }]);
    expect(s.agents.options.claude?.model).toBe("sonnet");
    expect(fs.existsSync(lock)).toBe(false); // our own lock released
  });

  test("migration computed INSIDE the lock keeps a concurrent write, and runs once", async () => {
    // What main does now: `updateSettings(cur => cur.migrated ? cur : migrateLegacy(legacy, cur))`.
    // Deriving the migration from a snapshot taken before the lock would write
    // back a settings object that predates the CLI's preset — reverting it.
    await updateSettings((cur) => ({ ...cur, appearance: applyPreset(cur.appearance, PRESETS.nord!) }));
    const migrated = await updateSettings((cur) => (cur.migrated ? cur : migrateLegacy({ viewMode: "world" }, cur)));
    expect(migrated.appearance.preset).toBe("nord");   // the CLI's write survived
    expect(migrated.views.defaultView).toBe("world");  // the migration landed
    expect(migrated.migrated).toBe(true);

    // A second window racing the same migration is a no-op, not a second import.
    const again = await updateSettings((cur) => (cur.migrated ? cur : migrateLegacy({ viewMode: "canvas" }, cur)));
    expect(again.views.defaultView).toBe("world");
  });

  test("a writer releases only its own lock (a recovered-and-retaken lock is left alone)", async () => {
    const lock = `${settingsPath()}.lock`;
    let seen = "";
    await updateSettings((cur) => {
      // Someone recovered our lock mid-write and took it for themselves.
      seen = fs.readFileSync(lock, "utf8");
      fs.writeFileSync(lock, "new-holder");
      return { ...cur, agents: { ...cur.agents, model: "opus" } };
    });
    expect(seen).not.toBe("new-holder"); // we did hold our own token
    expect(fs.readFileSync(lock, "utf8")).toBe("new-holder"); // NOT deleted by us
    fs.rmSync(lock, { force: true });
  });
});

describe("a lock left by a process that is gone", () => {
  test("is cleared after its grace period, and a live holder's lock never is", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-lock-"));
    const file = path.join(dir, "settings.json");
    const lock = `${file}.lock`;

    // A pid that cannot exist, taken long enough ago to rule out a reused one.
    fs.writeFileSync(lock, `999999999:${Date.now() - 10_000}:deadbeef`);
    await patchSettingsFile([{ path: "agents.defaultAgent", value: "codex" }], file);
    expect(fs.existsSync(lock)).toBe(false);
    expect((await readSettings(file)).agents.defaultAgent).toBe("codex");

    // This process is alive, so its lock is somebody's business but ours to wait for.
    fs.writeFileSync(lock, `${process.pid}:${Date.now() - 10_000}:stillhere`);
    await expect(patchSettingsFile([{ path: "agents.defaultAgent", value: "droid" }], file))
      .rejects.toThrow(/locked by another writer/);
    expect(fs.existsSync(lock)).toBe(true);

    // Gone, but only just: the grace period is waited out first, so a pid that was reused
    // moments ago is not mistaken for the holder. It is cleared after that, not before.
    fs.rmSync(lock, { force: true });
    fs.writeFileSync(lock, `999999999:${Date.now()}:fresh`);
    const started = Date.now();
    await patchSettingsFile([{ path: "agents.defaultAgent", value: "pi" }], file);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
    expect((await readSettings(file)).agents.defaultAgent).toBe("pi");
    fs.rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});
