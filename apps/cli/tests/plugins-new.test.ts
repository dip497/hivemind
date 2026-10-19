// `hive plugins new <kind> <name>`: one path for every kind. It starts where --dir says, refuses a
// folder that already holds something, and prints the steps from the new folder to seeing it in
// the app.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hive } from "./helpers.js";

const KINDS = [
  { kind: "tool", id: "@ada/tally", manifest: "hivemind-tool.json", next: ["hive plugins install ./work/tally", "hive plugins enable tool:@ada/tally", "hive ctl plugin open tool:@ada/tally", "hive ctl tile look <tile>    # what it drew, and what its code logged"], guide: "https://hivemind.griiken.com/guide/tool-plugins/" },
  { kind: "widget", id: "@ada/tally", manifest: "widget.json", next: ["hive plugins install ./work/tally", "hive ctl plugin open widget:@ada/tally"], guide: "https://hivemind.griiken.com/guide/widgets/" },
  { kind: "view", id: "@ada/tally", manifest: "hivemind-view.json", next: ["cd ./work/tally && npm install && npm run dev    # builds dist/ and installs it", "hive ctl plugin open view:@ada/tally"], guide: "https://hivemind.griiken.com/guide/extension-authoring/" },
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
        expect(fs.readFileSync(path.join(dir, "PROMPT.md"), "utf8")).toContain(k.id);

        const again = hive(["plugins", "new", k.kind, "tally", "--owner", "ada", "--dir", "work/tally", "--json"], { cwd: tmp, env });
        expect([again.code, (again.json as { code: string }).code]).toEqual([1, "exists"]);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }, 60_000);
  }

  test("a kind that is not one you write is refused, naming those that are", () => {
    const r = hive(["plugins", "new", "agent", "tally", "--owner", "ada", "--json"], { cwd: os.tmpdir() });
    expect([r.code, r.json]).toEqual([2, { ok: false, code: "usage", error: "the kind is one of: tool, widget, view" }]);
  });
});
