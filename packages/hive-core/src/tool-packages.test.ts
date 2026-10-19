// A tool plugin is a folder the app loads into itself, so what it says it is gets checked before
// anything of it is installed or loaded: its id is its folder's, its module is inside its folder,
// and a setting cannot be mistaken for one of its tools being switched off.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createToolRegistry } from "./tool-registry.js";
import { parseToolManifest } from "./tool-format.js";
import { BUNDLED_TOOL_PLUGINS } from "./tool-plugins.js";
import { installToolPackage, listToolPackages, readToolPackage, removeToolPackage } from "./tool-packages.js";
import { readSettings } from "./settings.js";
import { isPluginEnabled } from "./plugin-settings.js";

const dirs: string[] = [];
process.env.HIVE_SETTINGS = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hm-tool-settings-")), "settings.json");
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
  await installToolPackage(plugin(), undefined, tools, path.join(tools, "settings.json"));
  fs.writeFileSync(path.join(tools, "acme--prs", "hivemind-tool.json"), JSON.stringify({ ...MANIFEST, apiVersion: 99 }));
  const [p] = await listToolPackages(tools);
  expect(p!.problem).toContain("needs a newer app");
});

test("installed under its id's folder, listed, and removed again", async () => {
  const tools = temp();
  const p = await installToolPackage(plugin({ permissions: ["workspace:spawn", "root"] }), undefined, tools, path.join(tools, "settings.json"));
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

test("the tool the e2e suite loads is one this app reads, with its command and icon, beside the app's own tools", async () => {
  const p = await readToolPackage(path.resolve(import.meta.dir, "../../../apps/desktop/tests/e2e/fixtures/tools/commits"), null);
  expect([p.id, p.problem, p.pluginCommands.map((c) => c.name), p.tiles.commits?.icon?.startsWith("data:image/svg+xml")]).toEqual(["example/commits", null, ["list"], true]);
  expect(() => createToolRegistry([...BUNDLED_TOOL_PLUGINS, p])).not.toThrow();
});

test("an update is installed off: switching one on trusted the code that was there, not what replaces it", async () => {
  const tools = temp();
  const settings = path.join(tools, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ plugins: { state: { "tool:acme/prs": { enabled: true, options: { prs: false } } } } }));
  await installToolPackage(plugin({ version: "2.0.0" }), undefined, tools, settings);
  const state = (await readSettings(settings)).plugins.state;
  expect(isPluginEnabled(state, "tool", "acme/prs", false)).toBe(false);
  // What the person set it to stays.
  expect(state["tool:acme/prs"]).toEqual({ options: { prs: false } });
});

test("reinstalling the same code byte for byte keeps it on: no new code was trusted", async () => {
  const tools = temp();
  const settings = path.join(tools, "settings.json");
  const src = plugin();
  await installToolPackage(src, undefined, tools, settings);
  fs.writeFileSync(settings, JSON.stringify({ plugins: { state: { "tool:acme/prs": { enabled: true } } } }));
  const again = await installToolPackage(src, undefined, tools, settings);
  expect(again.enabled).toBe(true);
  expect(isPluginEnabled((await readSettings(settings)).plugins.state, "tool", "acme/prs", false)).toBe(true);
});

test("reinstalling changed code switches it off, and says so", async () => {
  const tools = temp();
  const settings = path.join(tools, "settings.json");
  const src = plugin();
  await installToolPackage(src, undefined, tools, settings);
  fs.writeFileSync(settings, JSON.stringify({ plugins: { state: { "tool:acme/prs": { enabled: true } } } }));
  fs.writeFileSync(path.join(src, "index.js"), "export default { tiles: { changed: true } };");
  const again = await installToolPackage(src, undefined, tools, settings);
  expect(again.enabled).toBe(false);
  expect(isPluginEnabled((await readSettings(settings)).plugins.state, "tool", "acme/prs", false)).toBe(false);
});

test("code moved across a file boundary is changed code: a reinstall of it goes off", async () => {
  const tools = temp();
  const settings = path.join(tools, "settings.json");
  const entry = "export default { tiles: {} };";
  await installToolPackage(plugin({}, { "index.js": entry, "z.js": "steal()" }), undefined, tools, settings);
  fs.writeFileSync(settings, JSON.stringify({ plugins: { state: { "tool:acme/prs": { enabled: true } } } }));
  // The same bytes in a row, with z.js folded into the end of index.js after a \0.
  const again = await installToolPackage(plugin({}, { "index.js": `${entry}\0file\0z.js\0steal()` }), undefined, tools, settings);
  expect(again.enabled).toBe(false);
});

test("a tool plugin that comes with the app is the tool core says ships, and only the app's own may be hivemind/", async () => {
  const root = path.resolve(import.meta.dir, "../../../apps/desktop/tools");
  for (const name of fs.readdirSync(root)) {
    const raw = JSON.parse(fs.readFileSync(path.join(root, name, "hivemind-tool.json"), "utf8"));
    const p = parseToolManifest(raw, path.join(root, name), null, "app");
    const shipped = BUNDLED_TOOL_PLUGINS.find((b) => b.id === p.id);
    expect(shipped, p.id).toBeDefined();
    for (const t of p.tools) expect(shipped!.tools.map((x) => [x.key, x.label, x.tileKind, !!x.singleton])).toContainEqual([t.key, t.label, t.tileKind, !!t.singleton]);
    expect(() => parseToolManifest(raw, path.join(root, name), null, "you")).toThrow("kept for the plugins that come with the app");
  }
});

test("a tool that says it is one of a kind is opened as one, by the app and by `hive ctl open-tool` alike", () => {
  const one = parseToolManifest({ ...MANIFEST, tools: [{ ...MANIFEST.tools[0], singleton: true }] }, "/x", null);
  expect(one.tools[0]!.singleton).toBe(true);
  expect(Object.values(one.tiles)[0]!.singleton).toBe(true);
  expect(parseToolManifest(MANIFEST, "/x", null).tools[0]!.singleton).toBeUndefined();
});

test("its service is a program on PATH or a file in its folder, with a role; anything else is refused", () => {
  const read = (service: unknown) => parseToolManifest({ ...MANIFEST, service }, "/x", null).service;
  expect(read(undefined)).toBeUndefined();
  expect(read({ command: ["node", "service.js", "--port", "0"], role: "agents" })).toEqual({ command: ["node", "service.js", "--port", "0"], role: "agents" });
  expect(read({ command: ["./bin/serve"], role: "view" })).toEqual({ command: ["./bin/serve"], role: "view" });
  for (const [service, why] of [
    [{ command: [], role: "agents" }, "the program and its arguments"],
    [{ command: "node service.js", role: "agents" }, "the program and its arguments"],
    [{ command: ["node", 3], role: "agents" }, "the program and its arguments"],
    [{ command: ["/usr/bin/node"], role: "agents" }, "a program on PATH, or a file in its folder"],
    [{ command: ["./../escape"], role: "agents" }, "a program on PATH, or a file in its folder"],
    [{ command: ["sh -c"], role: "agents" }, "a program on PATH, or a file in its folder"],
    [{ command: ["node"] }, "service.role"],
    [{ command: ["node"], role: "Agents!" }, "service.role"],
    ["node", "service is not an object"],
  ] as const) expect(() => read(service), JSON.stringify(service)).toThrow(why);
});

test("its category is what its manifest says, from the list; none is other, and one not on the list is refused", async () => {
  expect((await readToolPackage(plugin({ category: "git" }), null)).category).toBe("git");
  expect((await readToolPackage(plugin(), null)).category).toBe("other");
  await expect(readToolPackage(plugin({ category: "games" }), null)).rejects.toThrow('"category" must be one of');
});

test("a tool's icon is the .svg its manifest names, carried as a data URL; one that is not there, or not an .svg inside it, is none", async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>';
  const tool = (icon: string) => ({ tools: [{ key: "prs", label: "PRs", tileKind: "acme-prs", icon }] });
  const p = await readToolPackage(plugin(tool("icon.svg"), { "index.js": "export default { tiles: {} };", "icon.svg": svg }), null);
  expect(p.tiles["acme-prs"]!.icon).toBe(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  expect((await readToolPackage(plugin(tool("missing.svg")), null)).tiles["acme-prs"]!.icon).toBeUndefined();
  expect((await readToolPackage(plugin(tool("../outside.svg")), null)).tiles["acme-prs"]!.icon).toBeUndefined();
  expect((await readToolPackage(plugin(tool("icon.png")), null)).tiles["acme-prs"]!.icon).toBeUndefined();
});
