// `hive plugins`: every kind on one list, and one record per plugin in settings.json that the
// app's Settings ▸ Plugins reads too. A value is checked against the setting the plugin declares,
// so a typo is refused by name instead of stored and ignored.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { hive } from "./helpers.js";
import { fixtureXDG } from "./agents-fixtures.js";

describe("hive plugins", () => {
  test("lists every kind, switches one on and off, and sets what its settings take", () => {
    const xdg = fixtureXDG(["claude"]);
    const view = path.join(xdg, "hivemind", "views", "board");
    fs.mkdirSync(view, { recursive: true });
    fs.writeFileSync(path.join(view, "index.html"), "<p>board</p>");
    fs.writeFileSync(path.join(view, "hivemind-view.json"), JSON.stringify({
      id: "board", name: "Board", version: "1.0.0", entry: "index.html",
      settings: [{ id: "columns", label: "Columns", type: "choice", values: ["todo", "all"], default: "todo" }, { id: "max", label: "Most cards", type: "number", min: 1, max: 50, default: 20 }],
    }));
    // No app: a test run inside a Hivemind tile would otherwise reach the live one.
    const env = { XDG_CONFIG_HOME: xdg, HIVE_SETTINGS: undefined, HIVE_HCP_SOCK: path.join(xdg, "no-app.sock"), HIVE_DRIVE_SOCK: path.join(xdg, "no-drive.sock") };
    const run = (...args: string[]) => hive(["plugins", ...args, "--json"], { cwd: xdg, env });
    const stored = () => JSON.parse(fs.readFileSync(path.join(xdg, "hivemind", "settings.json"), "utf8")).plugins.state;
    try {
      const list = (run("list").json as { data: { key: string; enabled: boolean }[] }).data;
      const keys = list.map((p) => p.key);
      for (const k of ["agent:claude", "view:board", "widget:note", "tool:@hivemind/web"]) expect(keys).toContain(k);
      // A tool that is not built in is off until switched on; everything else is on.
      expect(list.find((p) => p.key === "tool:@hivemind/web")?.enabled).toBe(false);
      expect(list.find((p) => p.key === "agent:claude")?.enabled).toBe(true);

      expect(run("disable", "agent:claude").json).toMatchObject({ ok: true, data: { enabled: false, reloaded: false } });
      expect(run("enable", "tool:@hivemind/web").json).toMatchObject({ ok: true });
      expect(stored()).toEqual({ "agent:claude": { enabled: false }, "tool:@hivemind/web": { enabled: true } });

      expect(run("set", "view:board", "columns", "all").json).toMatchObject({ ok: true, data: { value: "all" } });
      expect(run("set", "view:board", "max", "500").json).toMatchObject({ ok: true, data: { value: 50 } }); // clamped to its range
      expect(run("set", "view:board", "columns", "some").json).toMatchObject({ ok: false, error: "columns is one of: todo, all" });
      expect(run("set", "view:board", "colour", "red").json).toMatchObject({ ok: false, error: expect.stringContaining("has no setting \"colour\"; it has: columns, max") });
      expect(run("show", "view:board").json).toMatchObject({ ok: true, data: { values: { columns: "all", max: 50 } } });

      expect(run("reset", "view:board", "columns").json).toMatchObject({ ok: true });
      expect(stored()["view:board"]).toEqual({ options: { max: 50 } });
      expect(run("reset", "view:board").json).toMatchObject({ ok: true });
      expect(stored()["view:board"]).toBeUndefined();

      // A bare id is enough when one kind has it.
      expect(run("enable", "board").json).toMatchObject({ ok: true, data: { key: "view:board", enabled: true } });
      expect(run("enable", "nope").json).toMatchObject({ ok: false, error: expect.stringContaining("there is no plugin \"nope\"") });
      expect(run("enable", "view:nope").json).toMatchObject({ ok: false, error: expect.stringContaining("there is no view \"nope\"") });
    } finally {
      fs.rmSync(xdg, { recursive: true, force: true });
    }
  }, 60_000);
});
