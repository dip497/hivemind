// `hive plugins install` of a tool: from HiveHub by @owner/name, every file checked against the index and its
// hivemind-tool.json saying that same id, even where a folder has that name.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hive } from "./helpers.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const manifest = (id: string) => JSON.stringify({
  id, name: "Pull requests", version: "1.0.0", apiVersion: 1, entry: "index.js",
  tools: [{ key: "prs", label: "Pull requests", tileKind: "ada-prs" }],
});

describe("hive plugins install, a tool", () => {
  test("installs one from HiveHub by @owner/name, refuses a listing that is another tool, and takes a folder of that name only as ./@owner/name", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-tools-hub-"));
    const xdg = path.join(tmp, "config");
    const hub = path.join(tmp, "hub", "tools", "prs");
    fs.mkdirSync(hub, { recursive: true });
    const files: Record<string, string> = { "hivemind-tool.json": manifest("@ada/prs"), "index.js": "export default { tiles: {} };\n" };
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(hub, f), text);
    const entry = (id: string) => ({
      id, type: "tool", name: "Pull requests", description: "PRs.", author: "ada", version: "1.0.0", path: "tools/prs",
      files: Object.entries(files).map(([p, text]) => ({ path: p, sha256: sha(text) })),
    });
    const index = path.join(tmp, "hub", "index.json");
    fs.writeFileSync(index, JSON.stringify({ version: 1, plugins: [entry("@ada/prs"), entry("@ada/liar")] }));

    const env = { XDG_CONFIG_HOME: xdg, HIVE_SETTINGS: undefined, HIVE_HCP_SOCK: path.join(tmp, "no-app.sock"), HIVE_DRIVE_SOCK: path.join(tmp, "no-drive.sock"), HIVEMIND_PLUGIN_INDEX: pathToFileURL(index).href };
    const run = (cwd: string, ...args: string[]) => hive(["plugins", ...args, "--json"], { cwd, env });
    try {
      const prs = run(tmp, "install", "@ada/prs").json as { members: Array<{ dir: string }> };
      expect(prs).toMatchObject({ id: "@ada/prs", name: "Pull requests" });
      expect(fs.readFileSync(path.join(prs.members[0]!.dir, "index.js"), "utf8")).toBe(files["index.js"]);
      // A listing whose files say they are another tool is refused, not installed under the wrong name.
      expect(run(tmp, "install", "@ada/liar").json).toMatchObject({ error: { message: expect.stringContaining(`says it is "@ada/prs", not @ada/liar`) } });
      expect(fs.existsSync(path.join(xdg, "hivemind", "packages", "store", "ada--liar"))).toBe(false);

      // Here @ada/prs is also a folder holding another tool: the id is still HiveHub's, and the
      // folder is installed only when written as a path.
      const local = path.join(tmp, "work");
      fs.mkdirSync(path.join(local, "@ada", "prs"), { recursive: true });
      fs.writeFileSync(path.join(local, "@ada", "prs", "hivemind-tool.json"), manifest("@ada/mine"));
      fs.writeFileSync(path.join(local, "@ada", "prs", "index.js"), "export default { tiles: {} };\n");
      expect(run(local, "install", "@ada/prs").json).toMatchObject({ id: "@ada/prs" });
      expect(run(local, "install", "./@ada/prs").json).toMatchObject({ id: "@ada/mine" });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  test("text output says whether it is on, off when new and on when the same code is installed again, and the list names each tool's full id", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-tools-text-"));
    const xdg = path.join(tmp, "config");
    const src = path.join(tmp, "prs");
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "hivemind-tool.json"), manifest("@ada/prs"));
    fs.writeFileSync(path.join(src, "index.js"), "export default { tiles: {} };\n");
    const env = { XDG_CONFIG_HOME: xdg, HIVE_SETTINGS: undefined, HIVE_HCP_SOCK: path.join(tmp, "no-app.sock"), HIVE_DRIVE_SOCK: path.join(tmp, "no-drive.sock") };
    const run = (...args: string[]) => hive(args, { cwd: tmp, env }).stdout;
    try {
      const first = run("plugins", "install", src);
      expect(first).toContain("hive plugins enable tool:@ada/prs");
      expect(first).toContain("It is off");
      expect(run("plugins", "list", "--kind", "tool")).toContain("open-tool @ada/prs/prs");
      expect(hive(["plugins", "enable", "tool:@ada/prs", "--json"], { cwd: tmp, env }).code).toBe(0);
      const again = run("plugins", "install", src);
      expect(again).toContain("It is on");
      expect(again).not.toContain("hive plugins enable");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
