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
    const env = { XDG_CONFIG_HOME: tmp, HIVE_SETTINGS: undefined };
    const file = path.join(tmp, "hivemind", "settings.json");
    let r = hive(["config", "path"], { cwd: tmp, env });
    expect(r.stdout.trim()).toBe(file);
    r = hive(["config", "get", "appearance.glass.blur", "--json"], { cwd: tmp, env });
    expect(r.json).toEqual({ ok: true, data: 18 }); // defaults before the file exists
    r = hive(["config", "set", "appearance.glass.blur", "12", "--json"], { cwd: tmp, env });
    expect(r.json).toMatchObject({ ok: true, data: { path: "appearance.glass.blur", value: 12, rescanned: false } });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).appearance.glass.blur).toBe(12);
    r = hive(["config", "set", "appearance.glass.blur", "999"], { cwd: tmp, env });
    expect(r.stdout).toMatch(/= 24; app not running.*normalised/);
    r = hive(["config", "set", "appearance.pluginSurfaces", "opaque"], { cwd: tmp, env }); // not JSON
    expect(r.code).toBe(1);
    r = hive(["config", "set", "appearance.pluginSurfaces", '"opaque"', "--json"], { cwd: tmp, env });
    expect((r.json as { data: { value: string } }).data.value).toBe("opaque");
    r = hive(["config", "get", "nope.x", "--json"], { cwd: tmp, env });
    expect(r.json).toMatchObject({ ok: false, code: "not_found" });

    r = hive(["theme", "list"], { cwd: tmp, env });
    expect(r.stdout).toMatch(/^\* signal/m);   // the default preset is marked
    expect(r.stdout).toMatch(/nord/);
    r = hive(["theme", "use", "nord", "--json"], { cwd: tmp, env });
    expect(r.json).toEqual({ ok: true, data: { preset: "nord", rescanned: false } });
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(s.appearance.preset).toBe("nord");
    expect(s.appearance.terminal.background).toBe("#2e3440");
    expect(s.appearance.glass.blur).toBe(24); // a preset changes colours, not the glass settings
    r = hive(["theme", "use", "lava"], { cwd: tmp, env });
    expect(r.code).toBe(1);
    const out = path.join(tmp, "theme.json");
    r = hive(["theme", "export", out], { cwd: tmp, env });
    expect(JSON.parse(fs.readFileSync(out, "utf8")).preset).toBe("nord");
    hive(["theme", "use", "ubuntu"], { cwd: tmp, env });
    r = hive(["theme", "import", out, "--json"], { cwd: tmp, env });
    expect(r.json, `stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)} code=${r.code}`).toEqual({ ok: true, data: { preset: "nord", rescanned: false } });
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 30_000);
});
