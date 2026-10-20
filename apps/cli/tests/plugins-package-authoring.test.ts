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
interface Report { ok: boolean; data: { id: string; steps: Record<string, string>; problems: Problem[] } }

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
    expect([r.code, (r.json as Report).data]).toEqual([0, expect.objectContaining({
      id: "@ada/kit", problems: [], steps: { manifest: "ok", "tool tools/prs": "ok", "view views/board/dist": "ok" },
    })]);

    const installed = run("install", "./kit", "--json");
    expect(installed.json).toMatchObject({ ok: true, data: { id: "@ada/kit", on: false, members: [
      expect.objectContaining({ kind: "tool", id: "@ada/prs" }), expect.objectContaining({ kind: "view", id: "@ada/board" }),
    ] } });
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
    expect((r.json as Report).data.problems).toEqual([
      expect.objectContaining({ step: "manifest", file: "hivemind-package.json", line: lineNaming("widgets/dgo"), member: "widgets/dgo", message: expect.stringContaining("there is no folder widgets/dgo") }),
      expect.objectContaining({ step: "manifest", file: "hivemind-package.json", line: lineNaming("widgets/cat"), member: "widgets/cat", message: expect.stringContaining("@bob/cat is not @ada's") }),
      expect.objectContaining({ step: "manifest", file: "views/owl/hivemind-view.json", line: colourLine, member: "views/owl/dist", message: 'unknown field "colour"' }),
    ]);
  }, 120_000);

  test("add refuses a plugin with another owner's id, and leaves the package as it was", () => {
    run("new", "package", "kit", "--owner", "ada");
    run("new", "widget", "dog", "--owner", "bob", "--dir", "dog");
    const before = fs.readFileSync(manifest(), "utf8");

    const r = run("add", "dog", "--to", "kit", "--json");
    expect([r.code, (r.json as { code: string }).code]).toEqual([1, "not_the_owner"]);
    expect(fs.readFileSync(manifest(), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(tmp, "kit", "widgets", "dog"))).toBe(false);
  }, 60_000);
});
