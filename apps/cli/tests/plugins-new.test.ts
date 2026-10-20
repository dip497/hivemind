// `hive plugins new <kind> <name>`: one path for every kind. It starts where --dir says, refuses a
// folder that already holds something, and prints the steps from the new folder to seeing it in
// the app.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { hive } from "./helpers.js";

const tsc = path.join(import.meta.dir, "../../../node_modules/.bin/tsc");
const typeErrors = (config: string): string => { try { execFileSync(tsc, ["-p", config], { encoding: "utf8" }); return ""; } catch (e) { return String((e as { stdout?: string }).stdout); } };

const KINDS = [
  { kind: "tool", id: "@ada/tally", manifest: "hivemind-tool.json", next: ["hive plugins check ./work/tally", "hive plugins install ./work/tally", "hive plugins enable tool:@ada/tally", "hive ctl plugin open tool:@ada/tally", "hive ctl tile look <tile>    # what it drew, and what its code logged"], guide: "https://hivemind.griiken.com/guide/tool-plugins/" },
  { kind: "widget", id: "@ada/tally", manifest: "widget.json", next: ["hive plugins check ./work/tally", "hive plugins install ./work/tally", "hive ctl plugin open widget:@ada/tally"], guide: "https://hivemind.griiken.com/guide/widgets/" },
  { kind: "view", id: "@ada/tally", manifest: "hivemind-view.json", next: ["cd ./work/tally && npm install", "hive plugins check ./work/tally", "cd ./work/tally && npm run dev    # builds dist/ and installs it", "hive ctl plugin open view:@ada/tally"], guide: "https://hivemind.griiken.com/guide/extension-authoring/" },
] as const;

describe("hive plugins new", () => {
  for (const k of KINDS) {
    test(`${k.kind}: starts in --dir with its PROMPT.md, prints the way to see it, and refuses a folder that holds something`, () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `hive-new-${k.kind}-`));
      const env = { XDG_CONFIG_HOME: path.join(tmp, "config"), HIVE_SETTINGS: undefined, HIVE_HCP_SOCK: path.join(tmp, "no-app.sock"), HIVE_DRIVE_SOCK: path.join(tmp, "no-drive.sock") };
      const dir = path.join(tmp, "work", "tally");
      try {
        const r = hive(["plugins", "new", k.kind, "tally", "--owner", "ada", "--dir", "work/tally"], { cwd: tmp, env });
        expect(r.code).toBe(0);
        expect(r.stdout).toBe([
          `started ${k.kind === "tool" ? "tool plugin" : k.kind} ${k.id} in ${dir}`, "Next:", ...k.next.map((l) => `  ${l}`),
          "Want an agent to build it? Write your idea into ./work/tally/PROMPT.md and hand it that file.",
          `Guide: ${k.guide}`, "",
        ].join("\n"));
        expect(JSON.parse(fs.readFileSync(path.join(dir, k.manifest), "utf8")).id).toBe(k.id);
        const prompt = fs.readFileSync(path.join(dir, "PROMPT.md"), "utf8");
        expect(prompt).toContain(k.id);
        // Plain Markdown for an agent: no page components, no links that only work on the site.
        expect(prompt.match(/<\/?[A-Z][A-Za-z]*[\s>/]/g)).toBeNull();
        expect(prompt).not.toContain("](/");

        const again = hive(["plugins", "new", k.kind, "tally", "--owner", "ada", "--dir", "work/tally", "--json"], { cwd: tmp, env });
        expect([again.code, (again.json as { code: string }).code]).toEqual([1, "exists"]);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }, 60_000);
  }

  test("a new tool checks against what it is given: as written it passes, a misspelt host.run fails", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-new-types-"));
    try {
      expect(hive(["plugins", "new", "tool", "tally", "--owner", "ada", "--json"], { cwd: tmp }).code).toBe(0);
      const dir = path.join(tmp, "tally");
      expect(typeErrors(path.join(dir, "jsconfig.json"))).toBe("");
      fs.writeFileSync(path.join(dir, "index.js"), fs.readFileSync(path.join(dir, "index.js"), "utf8").replace("host.run(", "host.runn("));
      expect(typeErrors(path.join(dir, "jsconfig.json"))).toContain("Property 'runn' does not exist on type 'TileHost'");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  test("a tool's PROMPT.md loop checks its code, installs it, opens it and looks at it", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-new-prompt-"));
    try {
      hive(["plugins", "new", "tool", "tally", "--owner", "ada"], { cwd: tmp });
      const prompt = fs.readFileSync(path.join(tmp, "tally", "PROMPT.md"), "utf8");
      expect(prompt).toContain([
        "hive plugins check .               # its types, its manifest, and its code drawn once; file:line for each problem",
        "hive plugins install .            # again after each change",
        "hive plugins enable tool:@ada/tally     # once",
        "hive ctl plugin open tool:@ada/tally    # open its tile",
        "hive ctl tile look <tile>         # the picture of it, its state and what its code logged",
      ].join("\n"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("hive plugins api: a tool's is its tile's props, its host and the hm client, as declared", () => {
    const r = hive(["plugins", "api", "--kind", "tool"], { cwd: os.tmpdir() });
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith("export interface TileProps {\n  tile: TileInfo;\n  hm: ViewClient;\n  host: TileHost;")).toBe(true);
    expect(r.stdout).toContain("  run(bin: string, args: string[], opts?: { maxAgeMs?: number; stdin?: string }): Promise<RunResult>;\n");
    expect(r.stdout).toContain("  onCommand(name: string, handler: (args: unknown) => unknown): () => void;\n");
    expect(r.stdout).not.toContain("not in ");
    expect(hive(["plugins", "api", "--kind", "widget"], { cwd: os.tmpdir() }).stdout).toContain("render(");
    expect(hive(["plugins", "api", "--kind", "agent"], { cwd: os.tmpdir() }).code).toBe(2);
  });

  test("a kind that is not one you write is refused, naming those that are", () => {
    const r = hive(["plugins", "new", "agent", "tally", "--owner", "ada", "--json"], { cwd: os.tmpdir() });
    expect([r.code, r.json]).toEqual([2, { ok: false, code: "usage", error: "the kind is one of: tool, widget, view, package" }]);
  });
});
