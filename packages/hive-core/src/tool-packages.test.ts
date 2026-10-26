// A tool plugin is a folder the app loads into itself, so what it says it is gets checked before
// anything of it is installed or loaded: its id is its folder's, its module is inside its folder,
// and a setting cannot be mistaken for one of its tools being switched off.
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createToolRegistry } from "./tool-registry.js";
import { parseToolManifest } from "./tool-format.js";
import { BUNDLED_TOOL_PLUGINS } from "./tool-plugins.js";
import { listToolPackages, readToolPackage } from "./tool-packages.js";
import { installPackage, removePlugin } from "./package-install.js";

const dirs: string[] = [];
process.env.HIVE_SETTINGS = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hm-tool-settings-")), "settings.json");
const savedXdg = process.env.XDG_CONFIG_HOME;
beforeEach(() => { process.env.XDG_CONFIG_HOME = temp(); });
afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "hm-tool-")); dirs.push(d); return d; };

const MANIFEST = {
  id: "@acme/prs", name: "PRs", version: "1.0.0", apiVersion: 1, entry: "index.js",
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
  expect((await readToolPackage(plugin(), "@acme/prs")).id).toBe("@acme/prs");
});

test("the app's own owner is not one an added plugin can take", async () => {
  await expect(readToolPackage(plugin({ id: "@hivemind/web" }), null)).rejects.toThrow("kept for the plugins that come with the app");
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
  const { members: [m] } = await installPackage(plugin());
  fs.writeFileSync(path.join(m!.dir, "hivemind-tool.json"), JSON.stringify({ ...MANIFEST, apiVersion: 99 }));
  const [p] = await listToolPackages();
  expect(p!.problem).toContain("needs a newer app");
});

test("installed as a package of one, listed, and removed again", async () => {
  const { members: [m] } = await installPackage(plugin({ permissions: ["workspace:spawn", "root"] }));
  // Only permissions the protocol knows are kept.
  expect(m!.permissions).toEqual(["workspace:spawn"]);
  expect((await listToolPackages()).map((x) => [x.id, x.problem, x.package?.id])).toEqual([["@acme/prs", null, "@acme/prs"]]);
  await removePlugin("tool", "@acme/prs");
  expect(await listToolPackages()).toEqual([]);
});

test("a tile kind an app tool already draws cannot be taken by an added one", async () => {
  const p = await readToolPackage(plugin({ tools: [{ key: "web", label: "Web", tileKind: "browser" }] }), null);
  expect(() => createToolRegistry([...BUNDLED_TOOL_PLUGINS, p])).toThrow("Tile kind already contributed: browser");
});

test("the tool the e2e suite loads is one this app reads, with its command and icon, beside the app's own tools", async () => {
  const p = await readToolPackage(path.resolve(import.meta.dir, "../../../apps/desktop/tests/e2e/fixtures/tools/commits"), null);
  expect([p.id, p.problem, p.pluginCommands.map((c) => c.name), p.tiles.commits?.icon?.startsWith("data:image/svg+xml")]).toEqual(["@example/commits", null, ["list"], true]);
  expect(() => createToolRegistry([...BUNDLED_TOOL_PLUGINS, p])).not.toThrow();
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

test("a plugin's agent skill is read only when it is a folder inside it, named as its SKILL.md says, and not one of hive's own", async () => {
  const skill = (name: string, front = `name: ${name}\ndescription: does things`) => ({ [`skills/${name}/SKILL.md`]: `---\n${front}\n---\nbody\n` });
  const cases: { skills: unknown; files: Record<string, string>; refused?: string }[] = [
    { skills: ["skills/prs"], files: skill("prs") },
    { skills: ["../prs"], files: {}, refused: `skill "../prs" is not a folder inside its folder` },
    { skills: ["skills/hive-work"], files: skill("hive-work"), refused: `skill "hive-work" has the name of one of hive's own skills` },
    { skills: ["skills/prs"], files: { "skills/prs/README.md": "x" }, refused: "skill skills/prs has no SKILL.md" },
    { skills: ["skills/prs"], files: skill("prs", "name: other\ndescription: x"), refused: "frontmatter says name: other, not prs" },
    { skills: ["skills/prs"], files: skill("prs", "name: prs"), refused: "has no description" },
    { skills: ["skills/prs", "more/prs"], files: skill("prs"), refused: `skill "prs" is listed twice` },
  ];
  for (const c of cases) {
    const dir = plugin({ skills: c.skills }, { "index.js": "export default { tiles: {} };" });
    for (const [rel, text] of Object.entries(c.files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    if (c.refused) await expect(readToolPackage(dir, null)).rejects.toThrow(c.refused);
    else expect((await readToolPackage(dir, null)).skills).toEqual(c.skills as string[]);
  }
  // A link in a skill could hand an agent any file on the machine.
  const linked = plugin({ skills: ["skills/prs"] });
  fs.mkdirSync(path.join(linked, "skills", "prs"), { recursive: true });
  fs.writeFileSync(path.join(linked, "skills", "prs", "SKILL.md"), "---\nname: prs\ndescription: x\n---\n");
  fs.symlinkSync("/etc/hostname", path.join(linked, "skills", "prs", "host.md"));
  await expect(readToolPackage(linked, null)).rejects.toThrow("host.md is not a file");
});
