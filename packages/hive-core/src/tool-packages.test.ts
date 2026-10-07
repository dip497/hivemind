// A tool plugin is a folder the app loads into itself, so what it says it is gets checked before
// anything of it is installed or loaded: its id is its folder's, its module is inside its folder,
// and a setting cannot be mistaken for one of its tools being switched off.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createToolRegistry } from "./tool-registry.js";
import { BUNDLED_TOOL_PLUGINS } from "./tool-plugins.js";
import { installToolPackage, listToolPackages, readToolPackage, removeToolPackage } from "./tool-packages.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "hm-tool-")); dirs.push(d); return d; };

const MANIFEST = {
  id: "acme/prs", name: "PRs", version: "1.0.0", apiVersion: 1, entry: "index.js",
  tools: [{ key: "prs", label: "PRs", tileKind: "acme-prs" }],
};
function plugin(meta: object = {}, files: Record<string, string> = { "index.js": "export default { tiles: {} };" }): string {
  const dir = temp();
  fs.writeFileSync(path.join(dir, "hivemind-tool.json"), JSON.stringify({ ...MANIFEST, ...meta }));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test("a folder whose manifest names another plugin is refused, so it cannot pass for that one", async () => {
  await expect(readToolPackage(plugin(), "acme/other")).rejects.toThrow("not acme/other");
  expect((await readToolPackage(plugin(), "acme/prs")).id).toBe("acme/prs");
});

test("the app's own owner is not one an added plugin can take", async () => {
  await expect(readToolPackage(plugin({ id: "hivemind/web" }), null)).rejects.toThrow("kept for the plugins that come with the app");
});

test("its module is a .js file inside its folder, and is there", async () => {
  await expect(readToolPackage(plugin({ entry: "../../etc/x.js" }), null)).rejects.toThrow("inside its folder");
  await expect(readToolPackage(plugin({ entry: "main.js" }), null)).rejects.toThrow("main.js is missing");
});

test("a setting named like one of its tools is refused: a tool switched off is stored under that name", async () => {
  const settings = [{ id: "prs", label: "PRs", type: "boolean", default: true }];
  await expect(readToolPackage(plugin({ settings }), null)).rejects.toThrow('setting "prs" has the name of one of its tools');
});

test("one written for a newer tool API is listed with why it does not load, not dropped", async () => {
  const tools = temp();
  await installToolPackage(plugin(), undefined, tools);
  fs.writeFileSync(path.join(tools, "acme--prs", "hivemind-tool.json"), JSON.stringify({ ...MANIFEST, apiVersion: 99 }));
  const [p] = await listToolPackages(tools);
  expect(p!.problem).toContain("needs a newer app");
});

test("installed under its id's folder, listed, and removed again", async () => {
  const tools = temp();
  const p = await installToolPackage(plugin({ permissions: ["workspace:spawn", "root"] }), undefined, tools);
  expect(p.dir).toBe(path.join(tools, "acme--prs"));
  // Only permissions the protocol knows are kept.
  expect(p.permissions).toEqual(["workspace:spawn"]);
  expect((await listToolPackages(tools)).map((x) => [x.id, x.problem])).toEqual([["acme/prs", null]]);
  await removeToolPackage("acme/prs", tools);
  expect(await listToolPackages(tools)).toEqual([]);
});

test("a tile kind an app tool already draws cannot be taken by an added one", async () => {
  const p = await readToolPackage(plugin({ tools: [{ key: "web", label: "Web", tileKind: "browser" }] }), null);
  expect(() => createToolRegistry([...BUNDLED_TOOL_PLUGINS, p])).toThrow("Tile kind already contributed: browser");
});

test("every example in the repository is a tool plugin this app loads", async () => {
  const root = path.resolve(import.meta.dir, "../../../examples/tools");
  const names = fs.readdirSync(root);
  expect(names.length).toBeGreaterThanOrEqual(3);
  for (const name of names) {
    const p = await readToolPackage(path.join(root, name), null);
    expect([p.id, p.problem]).toEqual([`dip497/${name}`, null]);
    expect(() => createToolRegistry([...BUNDLED_TOOL_PLUGINS, p])).not.toThrow();
  }
});
