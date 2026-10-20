// `hive plugins` for widgets: a widget from a folder keeps its folder's name; one from HiveHub is its
// `@owner/name`, which its own widget.json must say, with every file checked against the index.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { hive } from "./helpers.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("hive plugins, widgets", () => {
  test("adds one from a folder and one from HiveHub, lists them with the app's own, and removes them", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-widgets-"));
    const xdg = path.join(tmp, "config");
    const counter = path.join(tmp, "counter");
    fs.mkdirSync(counter);
    fs.writeFileSync(path.join(counter, "widget.json"), JSON.stringify({ name: "Counter" }));
    fs.writeFileSync(path.join(counter, "widget.js"), "hive.on('start', () => hive.render({ type: 'text', text: '0' }));");

    // A local index of the shape HiveHub serves, listing a widget.
    const hub = path.join(tmp, "hub", "widgets", "pet");
    fs.mkdirSync(hub, { recursive: true });
    const files: Record<string, string> = {
      "widget.json": JSON.stringify({ id: "@ada/pet", name: "Pet", version: "1.0.0", draw: { type: "text", text: "woof" } }),
      "README.md": "# Pet\n",
    };
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(hub, f), text);
    const entry = (id: string, list: Record<string, string>) => ({
      id, type: "widget", name: "Pet", description: "A pet.", author: "ada", version: "1.0.0", path: "widgets/pet",
      files: Object.entries(list).map(([p, text]) => ({ path: p, sha256: sha(text) })),
    });
    const index = path.join(tmp, "hub", "index.json");
    fs.writeFileSync(index, JSON.stringify({ version: 1, plugins: [entry("@ada/pet", files), entry("@ada/liar", files)] }));

    const env = { XDG_CONFIG_HOME: xdg, HIVE_SETTINGS: undefined, HIVE_HCP_SOCK: path.join(tmp, "no-app.sock"), HIVE_DRIVE_SOCK: path.join(tmp, "no-drive.sock"), HIVEMIND_PLUGIN_INDEX: pathToFileURL(index).href };
    const run = (...args: string[]) => hive(["plugins", ...args, "--json"], { cwd: tmp, env });
    try {
      expect(run("install", counter).json).toMatchObject({ ok: true, data: { id: "counter", name: "Counter", rescanned: false } });
      // A folder named like the id, in the repository an agent works in, is not what installs.
      fs.mkdirSync(path.join(tmp, "@ada", "pet"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "@ada", "pet", "widget.json"), JSON.stringify({ id: "@ada/pet", name: "Impostor" }));
      expect(run("install", "@ada/pet").json).toMatchObject({ ok: true, data: { id: "@ada/pet", name: "Pet" } });
      fs.mkdirSync(path.join(tmp, "@ada", "gone"));
      fs.writeFileSync(path.join(tmp, "@ada", "gone", "widget.json"), JSON.stringify({ name: "Gone" }));
      expect(run("install", "@ada/gone").json).toMatchObject({ ok: false, error: expect.stringContaining("to install the folder, write ./@ada/gone") });
      // Kept in a folder a scope and a name can never make otherwise.
      expect(fs.existsSync(path.join(xdg, "hivemind", "widgets", "ada--pet", "widget.json"))).toBe(true);
      // A listing whose files say they are another widget is refused, not installed under the wrong name.
      expect(run("install", "@ada/liar").json).toMatchObject({ ok: false, error: expect.stringContaining('says it is "@ada/pet", not @ada/liar') });

      const ids = (run("list", "--kind", "widget").json as { data: { id: string }[] }).data.map((w) => w.id);
      expect(ids).toEqual(expect.arrayContaining(["note", "checklist", "text", "counter", "@ada/pet"]));

      expect(run("remove", "@ada/pet").json).toMatchObject({ ok: true });
      expect(fs.existsSync(path.join(xdg, "hivemind", "widgets", "ada--pet"))).toBe(false);
      expect(run("remove", "widget:note").json).toMatchObject({ ok: false, error: "it comes with the app" });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  test("a new widget works as written: it installs, checks against its own declarations, and is ready to publish", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-widget-new-"));
    const env = { XDG_CONFIG_HOME: path.join(tmp, "config"), HIVE_SETTINGS: undefined, HIVE_HCP_SOCK: path.join(tmp, "no-app.sock"), HIVE_DRIVE_SOCK: path.join(tmp, "no-drive.sock") };
    try {
      expect(hive(["plugins", "new", "widget", "tally", "--owner", "ada", "--json"], { cwd: tmp, env }).json).toMatchObject({ ok: true, data: { id: "@ada/tally" } });
      const dir = path.join(tmp, "tally");
      expect(fs.readdirSync(dir).sort()).toEqual(["PROMPT.md", "README.md", "hive.d.ts", "icon.svg", "jsconfig.json", "widget.js", "widget.json"]);
      // Its code is valid against the API it is given.
      execFileSync(path.join(import.meta.dir, "../../../node_modules/.bin/tsc"), ["-p", path.join(dir, "jsconfig.json")], { encoding: "utf8" });
      expect(hive(["plugins", "install", dir, "--json"], { cwd: tmp, env }).json).toMatchObject({ ok: true, data: { id: "@ada/tally", name: "Tally" } });
      expect(hive(["plugins", "new", "widget", "tally", "--owner", "ada", "--json"], { cwd: tmp, env }).json).toMatchObject({ ok: false, code: "exists" });
      expect(hive(["plugins", "new", "widget", "Bad Name", "--owner", "ada", "--json"], { cwd: tmp, env }).json).toMatchObject({ ok: false, code: "bad_name" });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  test("an issue's assignee is a who, not text: a widget that prints it as text fails its own check", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-widget-issue-"));
    const env = { XDG_CONFIG_HOME: path.join(tmp, "config"), HIVE_SETTINGS: undefined, HIVE_HCP_SOCK: path.join(tmp, "no-app.sock"), HIVE_DRIVE_SOCK: path.join(tmp, "no-drive.sock") };
    const tsc = path.join(import.meta.dir, "../../../node_modules/.bin/tsc");
    try {
      hive(["plugins", "new", "widget", "board", "--owner", "ada", "--json"], { cwd: tmp, env });
      const dir = path.join(tmp, "board");
      const check = (line: string) => {
        fs.writeFileSync(path.join(dir, "widget.js"), `/// <reference path="./hive.d.ts" />
hive.hm.issues.read("FAS-1").then((issue) => {
  ${line}
  hive.render({ type: "text", text: \`\${issue.title}: \${who}\` });
});
`);
        try { execFileSync(tsc, ["-p", path.join(dir, "jsconfig.json")], { encoding: "utf8" }); return ""; } catch (e) { return String((e as { stdout?: string }).stdout); }
      };
      expect(check("/** @type {string} */ const who = issue.assignee;")).toContain("widget.js");
      expect(check("const who = issue.assignee?.id ?? \"nobody\";")).toBe("");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
