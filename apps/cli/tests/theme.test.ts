// A theme from `hive` alone: started from the look in use, checked, installed, applied and
// reverted, as an agent the person asks would do it. No app runs, so each change says so.
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hive } from "./helpers.js";

let tmp: string;
let settings: string;
let run: (...args: string[]) => ReturnType<typeof hive>;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-theme-"));
  settings = path.join(tmp, "config", "hivemind", "settings.json");
  const env = { XDG_CONFIG_HOME: path.join(tmp, "config"), HIVE_SETTINGS: undefined, HIVE_HCP_SOCK: path.join(tmp, "no-app.sock"), HIVE_DRIVE_SOCK: path.join(tmp, "no-drive.sock") };
  run = (...args: string[]) => hive(args, { cwd: tmp, env });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const file = () => JSON.parse(fs.readFileSync(settings, "utf8"));
const themeJson = () => path.join(tmp, "looks", "themes", "harbour", "theme.json");

test("new theme writes the look in use into a package; check, install, use and revert drive it", () => {
  expect(run("theme", "use", "nord").code).toBe(0);
  expect(run("plugins", "new", "package", "looks", "--owner", "acme").code).toBe(0);
  let r = run("plugins", "new", "theme", "harbour", "--in", "looks", "--json");
  expect([r.code, r.json]).toEqual([0, expect.objectContaining({ kind: "theme", id: "@acme/looks/harbour", package: "@acme/looks" })]);
  const t = JSON.parse(fs.readFileSync(themeJson(), "utf8"));
  expect(t).toMatchObject({ format: 1, name: "Harbour", mode: "dark", palette: file().appearance.palette, accent: "ice" });
  expect(JSON.parse(fs.readFileSync(path.join(tmp, "looks", "hivemind-package.json"), "utf8")).themes).toEqual([{ path: "themes/harbour" }]);
  expect(run("plugins", "check", "looks").code).toBe(0);

  // An edit the check refuses names the pair, at the member.
  fs.writeFileSync(themeJson(), JSON.stringify({ ...t, palette: { ...t.palette, fg: "#3b4252" } }));
  r = run("plugins", "check", "looks", "--json");
  expect(r.code).toBe(1);
  expect(JSON.stringify(r.json)).toMatch(/fg on bg is [0-9.]+:1; it needs at least 4\.5:1/);
  fs.writeFileSync(themeJson(), JSON.stringify({ ...t, accent: { brand: "#c08552", accent: "#d9a273" }, name: "Harbour" }));

  r = run("plugins", "install", "./looks", "--json");
  expect([r.code, (r.json as { on: boolean; next: string[] })?.on, (r.json as { next: string[] })?.next]).toEqual([0, true, ["hive theme use @acme/looks/harbour"]]);
  r = run("theme", "list", "--json");
  expect((r.json as { themes: unknown[] }).themes).toContainEqual({ id: "@acme/looks/harbour", label: "Harbour", kind: "theme", mode: "dark", active: false, package: "@acme/looks", version: "0.1.0" });

  r = run("theme", "use", "@acme/looks/harbour", "--json");
  expect([r.code, r.json]).toEqual([0, { theme: "@acme/looks/harbour", name: "Harbour", version: "0.1.0", mode: "dark", rescanned: false }]);
  expect(file().appearanceExtra).toMatchObject({ accent: { brand: "#c08552", accent: "#d9a273" }, theme: { id: "@acme/looks/harbour", version: "0.1.0" } });
  // An older build reads a built-in accent id.
  expect(file().appearance.accent).toBe("ice");
  expect(run("theme", "list").stdout).toMatch(/^\* @acme\/looks\/harbour +Harbour/m);

  r = run("theme", "revert", "--json");
  expect([r.code, r.json]).toEqual([0, { reverted: "@acme/looks/harbour", preset: "nord", rescanned: false }]);
  expect(file().appearanceExtra).toEqual({});
  expect(run("theme", "revert", "--json").code).toBe(5);
}, 60_000);

test("a preset chosen over a custom accent paints in the preset's accent", () => {
  expect(run("config", "set", "appearanceExtra.accent", JSON.stringify({ brand: "#c08552", accent: "#d9a273" })).code).toBe(0);
  expect(file().appearanceExtra.accent).toEqual({ brand: "#c08552", accent: "#d9a273" });
  expect(run("theme", "use", "dracula").code).toBe(0);
  expect([file().appearance.accent, file().appearanceExtra]).toEqual(["violet", {}]);
}, 30_000);

test("a theme outside a package is refused, saying where it goes", () => {
  const r = run("plugins", "new", "theme", "harbour", "--json");
  expect(r.code).toBe(2);
  expect(JSON.stringify(r.json)).toMatch(/a theme comes in a package/);
});
