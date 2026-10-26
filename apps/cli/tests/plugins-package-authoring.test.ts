// Writing a package from `hive` alone: `new package`, members started `--in` it or `add`ed `--to`
// it, and `check` of the package folder, which checks every member with its own kind's check and
// places each problem at the file and line it is in.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hive } from "./helpers.js";

const REPO = path.join(import.meta.dir, "../../..");

let tmp: string;
let run: (...args: string[]) => ReturnType<typeof hive>;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-package-authoring-"));
  // No app: a test run inside a Hivemind tile would otherwise reach the live one.
  const env = { XDG_CONFIG_HOME: path.join(tmp, "config"), HIVE_SETTINGS: undefined, HIVE_HCP_SOCK: path.join(tmp, "no-app.sock"), HIVE_DRIVE_SOCK: path.join(tmp, "no-drive.sock") };
  run = (...args: string[]) => hive(["plugins", ...args], { cwd: tmp, env });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

interface Problem { step: string; file?: string; line?: number; message: string; member?: string }
interface Report { id: string; steps: Record<string, string>; problems: Problem[] }

const manifest = () => path.join(tmp, "kit", "hivemind-package.json");
/** The line of the package's manifest that names `path`, as a person reading the file counts. */
const lineNaming = (p: string) => fs.readFileSync(manifest(), "utf8").split("\n").indexOf(`      "path": "${p}"`) + 1;

describe("hive plugins, writing a package", () => {
  test("a new package with a view and a tool, from the starters, passes check and installs with both", () => {
    expect(run("new", "package", "kit", "--owner", "ada").code).toBe(0);
    expect(run("new", "view", "board", "--in", "kit").code).toBe(0);
    expect(run("new", "tool", "prs", "--in", "kit").code).toBe(0);
    // What `npm install` puts in the view's folder, taken from this checkout.
    const modules = path.join(tmp, "kit", "views", "board", "node_modules");
    fs.mkdirSync(modules);
    fs.symlinkSync(fs.realpathSync(path.join(REPO, "node_modules/esbuild")), path.join(modules, "esbuild"));

    const r = run("check", "kit", "--json");
    expect([r.code, (r.json as Report)]).toEqual([0, expect.objectContaining({
      id: "@ada/kit", problems: [], steps: { manifest: "ok", "tool tools/prs": "ok", "view views/board/dist": "ok", hub: "ok" },
    })]);

    const installed = run("install", "./kit", "--json");
    expect(installed.json).toMatchObject({ id: "@ada/kit", on: false, members: [
      expect.objectContaining({ kind: "tool", id: "@ada/prs" }), expect.objectContaining({ kind: "view", id: "@ada/board" }),
    ] });
  }, 240_000);

  test("check reports a misspelt member path and another owner's id at the line naming each, and a member's own manifest problem at its line", () => {
    run("new", "package", "kit", "--owner", "ada");
    run("new", "widget", "dog", "--in", "kit");
    run("new", "widget", "cat", "--in", "kit");
    fs.writeFileSync(manifest(), fs.readFileSync(manifest(), "utf8").replace('"widgets/dog"', '"widgets/dgo"'));
    const cat = path.join(tmp, "kit", "widgets", "cat", "widget.json");
    fs.writeFileSync(cat, fs.readFileSync(cat, "utf8").replace('"@ada/cat"', '"@bob/cat"'));
    run("new", "view", "owl", "--in", "kit");
    const owl = path.join(tmp, "kit", "views", "owl", "hivemind-view.json");
    fs.writeFileSync(owl, fs.readFileSync(owl, "utf8").replace('"protocol": 1,', '"protocol": 1,\n  "colour": "red",'));
    const colourLine = fs.readFileSync(owl, "utf8").split("\n").findIndex((l) => l.includes('"colour":')) + 1;

    const r = run("check", "kit", "--json");
    expect(r.code).toBe(1);
    expect((r.json as Report).problems).toEqual([
      expect.objectContaining({ step: "manifest", file: "hivemind-package.json", line: lineNaming("widgets/dgo"), member: "widgets/dgo", message: expect.stringContaining("there is no folder widgets/dgo") }),
      expect.objectContaining({ step: "manifest", file: "hivemind-package.json", line: lineNaming("widgets/cat"), member: "widgets/cat", message: expect.stringContaining("@bob/cat is not @ada's") }),
      expect.objectContaining({ step: "manifest", file: "views/owl/hivemind-view.json", line: colourLine, member: "views/owl/dist", message: 'unknown field "colour"' }),
    ]);
  }, 120_000);

  test("a new package names no empty member list, which a released app's manifest check refuses", () => {
    expect(run("new", "package", "kit", "--owner", "ada").code).toBe(0);
    const m = JSON.parse(fs.readFileSync(manifest(), "utf8"));
    expect(Object.keys(m)).toEqual(["apiVersion", "id", "name", "version"]);
    // The first member of a kind writes its list.
    run("new", "widget", "dog", "--in", "kit");
    expect(JSON.parse(fs.readFileSync(manifest(), "utf8")).widgets).toEqual([{ path: "widgets/dog" }]);
  }, 60_000);

  test("add takes a theme folder: copied to themes/<folder>, named in the manifest, and read as the package will hold it", () => {
    run("new", "package", "kit", "--owner", "ada");
    run("new", "package", "scratch", "--owner", "ada");
    expect(run("new", "theme", "harbour", "--in", "scratch").code).toBe(0);
    const r = run("add", "scratch/themes/harbour", "--to", "kit", "--json");
    expect([r.code, r.json]).toEqual([0, expect.objectContaining({ kind: "theme", id: "@ada/kit/harbour", path: "themes/harbour", copied: true })]);
    expect(fs.existsSync(path.join(tmp, "kit", "themes", "harbour", "theme.json"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(manifest(), "utf8")).themes).toEqual([{ path: "themes/harbour" }]);
    expect((run("check", "kit", "--json").json as Report).steps).toEqual({ manifest: "ok", "theme themes/harbour": "ok", hub: "ok" });
    // A folder that is not a theme's name is refused before anything is copied.
    fs.cpSync(path.join(tmp, "scratch", "themes", "harbour"), path.join(tmp, "Bad_Name"), { recursive: true });
    const bad = run("add", "Bad_Name", "--to", "kit", "--json");
    expect([bad.code, JSON.stringify(bad.json)]).toEqual([1, expect.stringContaining("named like its id")]);
    expect(fs.existsSync(path.join(tmp, "kit", "themes", "Bad_Name"))).toBe(false);
  }, 60_000);

  test("check sizes the package as HiveHub does: a file over 2 MB in a member's folder is refused there", () => {
    run("new", "package", "kit", "--owner", "ada");
    run("new", "widget", "dog", "--in", "kit");
    fs.writeFileSync(path.join(tmp, "kit", "widgets", "dog", "bark.webm"), new Uint8Array(3 << 20));
    // Beside the members, not installed: not counted.
    fs.writeFileSync(path.join(tmp, "kit", "draft.webm"), new Uint8Array(3 << 20));
    const r = run("check", "kit", "--json");
    expect([r.code, (r.json as Report).steps.hub, (r.json as Report).problems]).toEqual([1, "failed", [{ step: "hub", message: "HiveHub would refuse it: widgets/dog/bark.webm is larger than 2 MB" }]]);
    fs.rmSync(path.join(tmp, "kit", "widgets", "dog", "bark.webm"));
    expect(run("check", "kit", "--json").code).toBe(0);
    // And counted as HiveHub counts it: more than 200 files that install.
    fs.mkdirSync(path.join(tmp, "kit", "widgets", "dog", "marks"));
    for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(tmp, "kit", "widgets", "dog", "marks", `m${i}.svg`), "<svg/>");
    expect((run("check", "kit", "--json").json as Report).problems).toEqual([{ step: "hub", message: "HiveHub would refuse it: a plugin may have at most 200 files" }]);
  }, 60_000);

  test("add refuses a plugin with another owner's id, and leaves the package as it was", () => {
    run("new", "package", "kit", "--owner", "ada");
    run("new", "widget", "dog", "--owner", "bob", "--dir", "dog");
    const before = fs.readFileSync(manifest(), "utf8");

    const r = run("add", "dog", "--to", "kit", "--json");
    expect([r.code, (r.json as { error: { code: string } }).error.code]).toEqual([1, "NOT_THE_OWNER"]);
    expect(fs.readFileSync(manifest(), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(tmp, "kit", "widgets", "dog"))).toBe(false);
  }, 60_000);
});
