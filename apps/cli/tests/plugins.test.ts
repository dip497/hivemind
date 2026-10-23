// `hive plugins`: every kind on one list, and one record per plugin in settings.json that the
// app's Settings ▸ Plugins reads too. A value is checked against the setting the plugin declares,
// so a typo is refused by name instead of stored and ignored.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { hive } from "./helpers.js";
import { fixtureXDG } from "./agents-fixtures.js";

describe("hive plugins", () => {
  test("a view's own colours are among its settings, and a list it takes is kept as a list", () => {
    const xdg = fixtureXDG(["claude"]);
    const view = path.join(xdg, "isles-source");
    fs.mkdirSync(view, { recursive: true });
    fs.writeFileSync(path.join(view, "index.html"), "<p>isles</p>");
    fs.writeFileSync(path.join(view, "hivemind-view.json"), JSON.stringify({
      id: "isles", name: "Isles", version: "1.0.0", entry: "index.html",
      settings: [{ id: "names", label: "Harbours", type: "list" }],
      tokens: [{ id: "sea", label: "Sea", dark: "#123a5a", light: "=info" }],
    }));
    const env = { XDG_CONFIG_HOME: xdg, HIVE_SETTINGS: undefined, HIVE_HCP_SOCK: path.join(xdg, "no-app.sock"), HIVE_DRIVE_SOCK: path.join(xdg, "no-drive.sock") };
    const run = (...args: string[]) => hive(["plugins", ...args, "--json"], { cwd: xdg, env });
    try {
      expect(run("install", view).json).toMatchObject({ id: "isles" });
      expect(run("set", "view:isles", "token-sea", "#00FF88").json).toMatchObject({ value: "#00ff88" });
      expect(run("set", "view:isles", "names", '["north, east", "south"]').json).toMatchObject({ value: ["north, east", "south"] });
      // Read back from settings.json: the list came through as a list.
      expect(run("show", "view:isles").json).toMatchObject({ values: { "token-sea": "#00ff88", names: ["north, east", "south"] } });
      expect(run("set", "view:isles", "token-sea", "sea-green").json).toMatchObject({ error: { message: "token-sea is a colour like #1d4ed8, or theme for the theme's own" } });
    } finally {
      fs.rmSync(xdg, { recursive: true, force: true });
    }
  });

  test("lists every kind, switches one on and off, and sets what its settings take", () => {
    const xdg = fixtureXDG(["claude"]);
    const view = path.join(xdg, "board-source");
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
      expect(run("install", view).json).toMatchObject({ id: "board" });
      const list = (run("list").json as { plugins: { key: string; enabled: boolean }[] }).plugins;
      const keys = list.map((p) => p.key);
      for (const k of ["agent:claude", "view:board", "widget:note", "tool:@hivemind/web"]) expect(keys).toContain(k);
      // A tool that is not built in is off until switched on; everything else is on.
      expect(list.find((p) => p.key === "tool:@hivemind/web")?.enabled).toBe(false);
      expect(list.find((p) => p.key === "agent:claude")?.enabled).toBe(true);

      expect(run("disable", "agent:claude").json).toMatchObject({ enabled: false, reloaded: false });
      expect(run("enable", "tool:@hivemind/web").code).toBe(0);
      expect(stored()).toEqual({ "agent:claude": { enabled: false }, "tool:@hivemind/web": { enabled: true } });

      expect(run("set", "view:board", "columns", "all").json).toMatchObject({ value: "all" });
      expect(run("set", "view:board", "max", "500").json).toMatchObject({ value: 50 }); // clamped to its range
      expect(run("set", "view:board", "columns", "some").json).toMatchObject({ error: { message: "columns is one of: todo, all" } });
      expect(run("set", "view:board", "colour", "red").json).toMatchObject({ error: { message: expect.stringContaining("has no setting \"colour\"; it has: columns, max") } });
      expect(run("show", "view:board").json).toMatchObject({ values: { columns: "all", max: 50 } });

      expect(run("reset", "view:board", "columns").code).toBe(0);
      expect(stored()["view:board"]).toEqual({ options: { max: 50 } });
      expect(run("reset", "view:board").code).toBe(0);
      expect(stored()["view:board"]).toBeUndefined();

      // A bare id is enough when one kind has it.
      expect(run("enable", "board").json).toMatchObject({ key: "view:board", enabled: true });
      expect(run("enable", "nope").json).toMatchObject({ error: { message: expect.stringContaining("there is no plugin \"nope\"") } });
      expect(run("enable", "view:nope").json).toMatchObject({ error: { message: expect.stringContaining("there is no view \"nope\"") } });
    } finally {
      fs.rmSync(xdg, { recursive: true, force: true });
    }
  }, 60_000);

  test("search finds HiveHub's plugins by every word, best match first, and refuses a limit it cannot use", () => {
    const xdg = fixtureXDG([]);
    const entry = (type: string, id: string, name: string, description: string, category: string) =>
      ({ id, type, name, description, author: "dip497", version: "1.0.0", category, path: `${type}s/${id.split("/").pop()}`, files: [{ path: "x", sha256: "0".repeat(64) }] });
    fs.writeFileSync(path.join(xdg, "index.json"), JSON.stringify({ version: 1, plugins: [
      entry("agent", "claude", "Claude", "Anthropic's Claude Code, with approvals, status and session resume.", "agents"),
      entry("agent", "aider", "Aider", "AI pair programming in your terminal, with git built in.", "agents"),
      entry("tool", "@dip497/github-prs", "Pull requests", "The repository's GitHub pull requests.", "git"),
      entry("tool", "@dip497/flaky-tests", "Flaky tests", "Runs the tests several times.", "code"),
    ] }));
    const env = { XDG_CONFIG_HOME: xdg, HIVE_SETTINGS: undefined, HIVE_HCP_SOCK: path.join(xdg, "no-app.sock"), HIVE_DRIVE_SOCK: path.join(xdg, "no-drive.sock"), HIVEMIND_PLUGIN_INDEX: `file://${path.join(xdg, "index.json")}` };
    const run = (...args: string[]) => hive(["plugins", "search", ...args, "--json"], { cwd: xdg, env });
    try {
      const ids = (r: ReturnType<typeof run>) => (r.json as { plugins: { id: string }[] }).plugins.map((p) => p.id);
      expect(ids(run("git", "pr"))).toEqual(["@dip497/github-prs", "aider"]);
      expect(ids(run("tests", "flaky"))).toEqual(["@dip497/flaky-tests"]);
      expect(ids(run("pr", "--kind", "agent"))).toEqual(["aider"]);
      expect(run("pr", "--limit", "1").json).toMatchObject({ total: 2, plugins: [{ id: "@dip497/github-prs" }] });
      const bad = run("pr", "--limit", "-1");
      expect(bad.code).not.toBe(0);
      expect(bad.json).toMatchObject({ error: { message: "--limit is a whole number from 1 to 100" } });
    } finally { fs.rmSync(xdg, { recursive: true, force: true }); }
  });

  test("only the person switches plugins and changes their settings: an agent in a tile or a program with a grant is refused, told what to ask the person to run, and nothing is stored", () => {
    const xdg = fixtureXDG(["claude"]);
    const base = { XDG_CONFIG_HOME: xdg, HIVE_SETTINGS: undefined, HIVE_HCP_SOCK: path.join(xdg, "no-app.sock"), HIVE_DRIVE_SOCK: path.join(xdg, "no-drive.sock") };
    const settings = path.join(xdg, "hivemind", "settings.json");
    const stored = () => (fs.existsSync(settings) ? fs.readFileSync(settings, "utf8") : null);
    try {
      // The data is first brought up to this build's shape, by the person; what follows changes nothing.
      expect(hive(["plugins", "list", "--json"], { cwd: xdg, env: base }).code).toBe(0);
      for (const who of [{ HCP_TOKEN: "tile-token", HIVEMIND_TILE: "hm:t1" }, { HIVE_DRIVE_TOKEN: "grant-token" }]) {
        for (const [args, ask] of [
          [["plugins", "enable", "tool:@hivemind/web"], "hive plugins enable tool:@hivemind/web"],
          [["plugins", "disable", "agent:claude"], "hive plugins disable agent:claude"],
          [["plugins", "set", "agent:claude", "model", "x"], "hive plugins set agent:claude model x"],
          [["plugins", "reset", "agent:claude"], "hive plugins reset agent:claude"],
          [["config", "set", "plugins.state", '{"tool:@hivemind/web":{"enabled":true}}'], "hive config set plugins.state"],
        ] as const) {
          const before = stored();
          const r = hive([...args, "--json"], { cwd: xdg, env: { ...base, ...who } });
          const error = (r.json as { error: { code: string; message: string } }).error;
          expect([args.join(" "), r.code, error.code, error.message.includes(ask), stored()]).toEqual([args.join(" "), 6, "PERSON_ONLY", true, before]);
        }
      }
      // The person, at the same machine, may.
      expect(hive(["plugins", "enable", "tool:@hivemind/web", "--json"], { cwd: xdg, env: base }).code).toBe(0);
    } finally {
      fs.rmSync(xdg, { recursive: true, force: true });
    }
  }, 60_000);
});
