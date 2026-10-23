import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hive } from "./helpers.js";

describe("hive config / hive theme", () => {
  // ~12 `bun` subprocess spawns in one test: bun's 5s default is not a budget
  // for that on a loaded machine (it flaked before the concurrency work and
  // again after it, both times as a timeout, never an assertion).
  test("path, get, set (validated), theme list/use/export/import — all against settings.json, app absent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-config-"));
    // No app: a test run inside a Hivemind tile would otherwise reach the live one.
    const env = { XDG_CONFIG_HOME: tmp, HIVE_SETTINGS: undefined, HIVE_HCP_SOCK: path.join(tmp, "no-app.sock"), HIVE_DRIVE_SOCK: path.join(tmp, "no-drive.sock") };
    const file = path.join(tmp, "hivemind", "settings.json");
    let r = hive(["config", "path"], { cwd: tmp, env });
    expect(r.stdout.trim()).toBe(file);
    r = hive(["config", "get", "appearance.glass.blur", "--json"], { cwd: tmp, env });
    expect(r.json).toEqual({ path: "appearance.glass.blur", value: 18 }); // defaults before the file exists
    r = hive(["config", "set", "appearance.glass.blur", "12", "--json"], { cwd: tmp, env });
    expect(r.json).toMatchObject({ path: "appearance.glass.blur", value: 12, rescanned: false });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).appearance.glass.blur).toBe(12);
    r = hive(["config", "set", "appearance.glass.blur", "999"], { cwd: tmp, env });
    expect(r.stdout).toMatch(/= 24; app not running.*normalised/);
    r = hive(["config", "set", "appearance.pluginSurfaces", "opaque"], { cwd: tmp, env }); // not JSON
    expect(r.code).toBe(2);
    r = hive(["config", "set", "appearance.pluginSurfaces", '"opaque"', "--json"], { cwd: tmp, env });
    expect((r.json as { value: string }).value).toBe("opaque");
    r = hive(["config", "get", "nope.x", "--json"], { cwd: tmp, env });
    expect(r.json).toMatchObject({ error: { code: "NOT_FOUND" } });

    r = hive(["theme", "list"], { cwd: tmp, env });
    expect(r.stdout).toMatch(/^\* signal/m);   // the default preset is marked
    expect(r.stdout).toMatch(/nord/);
    r = hive(["theme", "use", "nord", "--json"], { cwd: tmp, env });
    expect(r.json).toEqual({ preset: "nord", rescanned: false });
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(s.appearance.preset).toBe("nord");
    expect(s.appearance.terminal.background).toBe("#2e3440");
    expect(s.appearance.glass.blur).toBe(24); // a preset changes colours, not the glass settings
    r = hive(["theme", "use", "lava"], { cwd: tmp, env });
    expect(r.code).toBe(5);
    const out = path.join(tmp, "theme.json");
    r = hive(["theme", "export", out], { cwd: tmp, env });
    expect(JSON.parse(fs.readFileSync(out, "utf8")).preset).toBe("nord");
    hive(["theme", "use", "ubuntu"], { cwd: tmp, env });
    r = hive(["theme", "import", out, "--json"], { cwd: tmp, env });
    expect(r.json, `stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)} code=${r.code}`).toEqual({ preset: "nord", rescanned: false });
    // A file that sets nothing of the look, picked by mistake, is refused and changes nothing.
    hive(["config", "set", "appearance.mode", '"light"'], { cwd: tmp, env });
    const before = fs.readFileSync(file, "utf8");
    const pkg = path.join(tmp, "package.json");
    fs.writeFileSync(pkg, JSON.stringify({ name: "app", version: "1.0.0", scripts: { build: "tsc" } }));
    r = hive(["theme", "import", pkg, "--json"], { cwd: tmp, env });
    expect([r.code, r.json, fs.readFileSync(file, "utf8")]).toEqual([1, { error: expect.objectContaining({ code: "INVALID_THEME", message: expect.stringContaining("not a hivemind theme") }) }, before]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 30_000);

  test("theme export leaves out the media files this computer holds and says so; importing the file keeps yours", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-theme-media-"));
    const env = { XDG_CONFIG_HOME: tmp, HIVE_SETTINGS: undefined, HIVE_HCP_SOCK: path.join(tmp, "no-app.sock"), HIVE_DRIVE_SOCK: path.join(tmp, "no-drive.sock") };
    const file = path.join(tmp, "hivemind", "settings.json");
    const picture = "hm-media://v/%2Fhome%2Falice%2Fcat.png";
    const overlay = { id: "o", url: "hivemedia://media/alice-cat.png", kind: "image", opacity: 1, fit: "cover", size: 1, anchor: "center" };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ v: 1, appearance: { preset: "nord", wallpaper: { kind: "image", imageSrc: picture, brightness: 0.7 }, overlayMedia: [overlay] } }));
    try {
      const out = path.join(tmp, "theme.json");
      let r = hive(["theme", "export", out], { cwd: tmp, env });
      expect([fs.readFileSync(out, "utf8").includes("alice"), r.stdout]).toEqual([false, expect.stringContaining("Left out the wallpaper picture and the overlays")]);
      r = hive(["theme", "export", out, "--json"], { cwd: tmp, env });
      expect(r.json).toEqual({ file: out, leftOut: ["wallpaper.imageSrc", "overlayMedia"] });
      // To stdout, the file stays JSON: the note goes to stderr.
      r = hive(["theme", "export"], { cwd: tmp, env });
      expect([JSON.parse(r.stdout).preset, r.stdout.includes("alice"), r.stderr]).toEqual(["nord", false, expect.stringContaining("Left out")]);
      r = hive(["theme", "import", out], { cwd: tmp, env });
      const after = JSON.parse(fs.readFileSync(file, "utf8")).appearance;
      expect([r.code, after.wallpaper.imageSrc, after.overlayMedia]).toEqual([0, picture, [overlay]]);
      // The guide's backup, `hive config get appearance`, holds the media: importing it puts them back.
      const backup = path.join(tmp, "backup.json");
      fs.writeFileSync(backup, hive(["config", "get", "appearance"], { cwd: tmp, env }).stdout);
      const set = (at: string, value: string) => hive(["config", "set", at, value], { cwd: tmp, env }).code;
      expect([set("appearance.wallpaper.imageSrc", '"hivemedia://media/bo.png"'), set("appearance.overlayMedia", "[]")]).toEqual([0, 0]);
      r = hive(["theme", "import", backup], { cwd: tmp, env });
      const restored = JSON.parse(fs.readFileSync(file, "utf8")).appearance;
      expect([r.code, restored.wallpaper.imageSrc, restored.overlayMedia]).toEqual([0, picture, [overlay]]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  test("set refuses a path that is not a setting, and says which is; any id in a map of ids is one", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-config-path-"));
    const env = { XDG_CONFIG_HOME: tmp, HIVE_SETTINGS: undefined, HIVE_HCP_SOCK: path.join(tmp, "no-app.sock"), HIVE_DRIVE_SOCK: path.join(tmp, "no-drive.sock") };
    const file = path.join(tmp, "hivemind", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ v: 1 }));
    try {
      // The file keeps keys it does not know: each of these would be stored and never read.
      const wrong = [
        ["appearance.blur", "Did you mean appearance.glass.blur?"],
        ["appearance.glass.blurr", "appearance.glass holds enabled, contentGlass, opacity, blur"],
        ["browserCdp", "no setting browserCdp"],
        ["appearance.glass.blur.x", "appearance.glass.blur is one value"],
        // An id no view or plugin can have: the map drops it, so it would print as set to nothing.
        ["views.chrome.Bad_Id", '"Bad_Id" is not a view\'s id'],
        ["views.toolbars.Bad_Id", '"Bad_Id" is not a view\'s id'],
        ["plugins.state.claude", '"claude" is not a plugin\'s key'],
        // Below a good id, what one entry of the map holds.
        ["views.chrome.canvas.bogus", "views.chrome.canvas holds island"],
        ["views.toolbars.canvas.bogus", "views.toolbars.canvas holds actions, labels"],
        ["plugins.state.agent:claude.bogus", "plugins.state.agent:claude holds enabled, options, workspaces"],
        ["plugins.state.agent:claude.options.model.x", "plugins.state.agent:claude.options.model is one value"],
        // The file's format, which the app keeps.
        ["v", "v is the format of settings.json"],
      ];
      for (const [at, why] of wrong) {
        const r = hive(["config", "set", at!, "12", "--json"], { cwd: tmp, env });
        expect([at, r.code, r.json]).toEqual([at, 5, { error: expect.objectContaining({ code: "NOT_FOUND", message: expect.stringContaining(why!) }) }]);
      }
      const s = JSON.parse(fs.readFileSync(file, "utf8"));
      expect([s.appearance?.blur, s.appearance?.glass?.blurr, s.browserCdp]).toEqual([undefined, undefined, undefined]);
      expect([s.v, s.views?.chrome?.canvas, s.plugins?.state?.["agent:claude"]]).toEqual([1, undefined, undefined]);
      const ids: [string, unknown][] = [
        ["views.chrome.canvas", { island: "hidden" }], ["views.toolbars.canvas", { labels: false }], ["plugins.state.agent:claude", { enabled: false }],
        ["views.chrome.canvas.island", "top"], ["plugins.state.agent:claude.options.model", "opus"],
      ];
      for (const [at, value] of ids) {
        expect(hive(["config", "set", at, JSON.stringify(value), "--json"], { cwd: tmp, env }).json).toEqual({ path: at, value, rescanned: false });
      }
      // A newer build's file: read for what this version knows, said once, its format kept.
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), v: 5 }));
      const got = hive(["config", "get", "views.chrome.canvas", "--json"], { cwd: tmp, env });
      expect([got.json, got.stderr]).toEqual([{ path: "views.chrome.canvas", value: { island: "top" } }, expect.stringContaining("newer version of hivemind (format 5)")]);
      hive(["config", "set", "appearance.radius", "4"], { cwd: tmp, env });
      expect(JSON.parse(fs.readFileSync(file, "utf8")).v).toBe(5);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
