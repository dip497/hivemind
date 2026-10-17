// `hive tools install`: from HiveHub by owner/name, every file checked against the index and its
// hivemind-tool.json saying that same id; a folder that exists under that name is the folder.
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

describe("hive tools install", () => {
  test("installs one from HiveHub by owner/name, refuses a listing that is another tool, and takes a folder of that name as the folder", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-tools-hub-"));
    const xdg = path.join(tmp, "config");
    const hub = path.join(tmp, "hub", "tools", "prs");
    fs.mkdirSync(hub, { recursive: true });
    const files: Record<string, string> = { "hivemind-tool.json": manifest("ada/prs"), "index.js": "export default { tiles: {} };\n" };
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(hub, f), text);
    const entry = (id: string) => ({
      id, type: "tool", name: "Pull requests", description: "PRs.", author: "ada", version: "1.0.0", path: "tools/prs",
      files: Object.entries(files).map(([p, text]) => ({ path: p, sha256: sha(text) })),
    });
    const index = path.join(tmp, "hub", "index.json");
    fs.writeFileSync(index, JSON.stringify({ version: 1, plugins: [entry("ada/prs"), entry("ada/liar")] }));

    const env = { XDG_CONFIG_HOME: xdg, HIVE_SETTINGS: undefined, HIVE_HCP_SOCK: path.join(tmp, "no-app.sock"), HIVE_DRIVE_SOCK: path.join(tmp, "no-drive.sock"), HIVEMIND_PLUGIN_INDEX: pathToFileURL(index).href };
    const run = (cwd: string, ...args: string[]) => hive(["tools", ...args, "--json"], { cwd, env });
    try {
      expect(run(tmp, "install", "ada/prs").json).toMatchObject({ ok: true, data: { id: "ada/prs", name: "Pull requests" } });
      expect(fs.readFileSync(path.join(xdg, "hivemind", "tools", "ada--prs", "index.js"), "utf8")).toBe(files["index.js"]);
      // A listing whose files say they are another tool is refused, not installed under the wrong name.
      expect(run(tmp, "install", "ada/liar").json).toMatchObject({ ok: false, error: expect.stringContaining("says it is ada/prs, not ada/liar") });
      expect(fs.existsSync(path.join(xdg, "hivemind", "tools", "ada--liar"))).toBe(false);

      // Here ada/prs is a folder holding another tool: the folder is what gets installed.
      const local = path.join(tmp, "work");
      fs.mkdirSync(path.join(local, "ada", "prs"), { recursive: true });
      fs.writeFileSync(path.join(local, "ada", "prs", "hivemind-tool.json"), manifest("ada/mine"));
      fs.writeFileSync(path.join(local, "ada", "prs", "index.js"), "export default { tiles: {} };\n");
      expect(run(local, "install", "ada/prs").json).toMatchObject({ ok: true, data: { id: "ada/mine" } });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
