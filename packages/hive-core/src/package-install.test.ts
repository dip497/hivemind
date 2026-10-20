// Every plugin you add is installed as a package, and goes as one: a folder holding one plugin is
// a package of one. The record says which version is in use and whether it is on; the files of a
// version are never changed once installed.
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installPackage, removePlugin, switchPackage, switchPlugin } from "./package-install.js";
import { packagesDir, readInstalledPackages } from "./installed-packages.js";
import { listWidgets } from "./widgets.js";
import { listToolPackages } from "./tool-packages.js";
import { isPluginOn } from "./plugin-settings.js";
import { readSettings } from "./settings.js";

let tmp: string;
const saved = { xdg: process.env.XDG_CONFIG_HOME, settings: process.env.HIVE_SETTINGS };
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-packages-"));
  process.env.XDG_CONFIG_HOME = path.join(tmp, "config");
  process.env.HIVE_SETTINGS = path.join(tmp, "settings.json");
});
afterEach(() => {
  for (const [k, v] of [["XDG_CONFIG_HOME", saved.xdg], ["HIVE_SETTINGS", saved.settings]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function folder(name: string, files: Record<string, string>): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
  return dir;
}
const widget = () => folder("counter", { "widget.json": JSON.stringify({ name: "Counter" }), "widget.js": "hive.render({ type: 'text', text: '0' });" });
const tool = (code = "export default { tiles: {} };", more: Record<string, string> = {}) => folder("prs", {
  "hivemind-tool.json": JSON.stringify({ id: "@acme/prs", name: "PRs", version: "1.0.0", apiVersion: 1, entry: "index.js", tools: [{ key: "prs", label: "PRs", tileKind: "acme-prs" }] }),
  "index.js": code, ...more,
});

test("installing a widget folder gives a package of one, and removing the widget removes its package", async () => {
  await installPackage(widget());
  const [record] = await readInstalledPackages();
  expect(record).toMatchObject({ id: "counter", name: "Counter", version: "0.0.0", on: true, members: [{ kind: "widget", id: "counter", path: "." }] });
  expect(record!.digest).toMatch(/^[a-f0-9]{64}$/);
  const listed = (await listWidgets()).find((w) => w.id === "counter");
  expect(listed?.package).toEqual({ id: "counter", version: "0.0.0", on: true, members: 1 });

  await removePlugin("widget", "counter");
  expect(await readInstalledPackages()).toEqual([]);
  expect((await listWidgets()).some((w) => w.id === "counter")).toBe(false);
  expect(fs.existsSync(path.join(packagesDir(), "store", "counter"))).toBe(false);
});

test("a package holding code that runs in the app is installed off; the same files again keep its switch", async () => {
  const src = tool();
  expect((await installPackage(src)).record.on).toBe(false);
  await switchPlugin("tool", "@acme/prs", true);
  expect((await installPackage(src)).record.on).toBe(true);
  const states = (await readSettings()).plugins.state;
  expect(isPluginOn(states, "tool", (await listToolPackages())[0]!)).toBe(true);
});

test("changed code goes off, and the version before it is kept", async () => {
  const src = tool();
  const first = await installPackage(src);
  await switchPlugin("tool", "@acme/prs", true);
  fs.writeFileSync(path.join(src, "index.js"), "export default { tiles: { changed: true } };");
  const { record } = await installPackage(src);
  expect(record.on).toBe(false);
  expect(record.previous?.digest).toBe(first.record.digest);
});

test("code moved across a file boundary is changed code", async () => {
  const entry = "export default { tiles: {} };";
  const a = await installPackage(tool(entry, { "z.js": "steal()" }));
  fs.rmSync(path.join(tmp, "prs"), { recursive: true });
  // The same bytes in a row, with z.js folded into the end of index.js after a \0.
  const b = await installPackage(tool(`${entry}\0file\0z.js\0steal()`));
  expect(b.record.digest).not.toBe(a.record.digest);
});

test("switching a package of one switches the package, and an old switch of the plugin's own cannot keep it off", async () => {
  fs.writeFileSync(process.env.HIVE_SETTINGS!, JSON.stringify({ plugins: { state: { "widget:counter": { enabled: false, options: { start: 3 } } } } }));
  await installPackage(widget());
  await switchPlugin("widget", "counter", false);
  expect((await readInstalledPackages())[0]!.on).toBe(false);
  await switchPlugin("widget", "counter", true);
  const states = (await readSettings()).plugins.state;
  expect(isPluginOn(states, "widget", (await listWidgets()).find((w) => w.id === "counter")!)).toBe(true);
  // What the person set it to stays.
  expect(states["widget:counter"]).toEqual({ options: { start: 3 } });
});

/** A package holding one of each kind, written as `hivemind-package.json` names them. */
function bundle(name = "kit", owner = "acme", overrides: Record<string, unknown> = {}): string {
  const root = folder(name, {});
  const put = (rel: string, files: Record<string, string>) => {
    fs.mkdirSync(path.join(root, rel), { recursive: true });
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(root, rel, f), text);
  };
  put("tools/prs", {
    "hivemind-tool.json": JSON.stringify({ id: `@${owner}/prs`, name: "PRs", version: "1.0.0", apiVersion: 1, entry: "index.js", tools: [{ key: "prs", label: "PRs", tileKind: `${owner}-prs` }] }),
    "index.js": "export default { tiles: {} };",
  });
  put("widgets/dog", { "widget.json": JSON.stringify({ id: `@${owner}/dog`, name: "Dog", draw: { type: "text", text: "woof" } }) });
  put("views/island", { "hivemind-view.json": JSON.stringify({ id: `@${owner}/island`, name: "Island", version: "1.0.0", entry: "index.html", permissions: ["workspace:issues"] }), "index.html": "<!doctype html>" });
  fs.writeFileSync(path.join(root, "hivemind-package.json"), JSON.stringify({
    apiVersion: 2, id: `@${owner}/${name}`, name: "Kit", version: "1.0.0",
    tools: [{ path: "tools/prs" }], widgets: [{ path: "widgets/dog" }], views: [{ path: "views/island" }],
    agents: [{ id: `@${owner}/reviewer`, name: "Reviewer", provider: "claude", prompt: "Review the diff." }],
    ...overrides,
  }));
  return root;
}

test("a package with one of each kind installs as one, each member where the app reads its kind", async () => {
  const { record } = await installPackage(bundle());
  expect(record.members.map((m) => `${m.kind}:${m.id}`).sort()).toEqual(["agent-preset:@acme/reviewer", "tool:@acme/prs", "view:@acme/island", "widget:@acme/dog"]);
  // It holds code that runs in the app and an agent's instructions: off until the person switches it on.
  expect(record.on).toBe(false);
  expect((await listToolPackages()).map((t) => [t.id, t.problem, t.package?.id])).toEqual([["@acme/prs", null, "@acme/kit"]]);
  expect((await listWidgets()).find((w) => w.id === "@acme/dog")?.package?.id).toBe("@acme/kit");
  const { listInstalledViews } = await import("./views.js");
  expect((await listInstalledViews()).map((v) => [v.id, v.error, v.package?.id])).toEqual([["@acme/island", null, "@acme/kit"]]);
});

test("a member whose id has another owner is refused, and nothing is installed", async () => {
  const src = bundle();
  fs.writeFileSync(path.join(src, "widgets/dog/widget.json"), JSON.stringify({ id: "@mallory/dog", name: "Dog", draw: { type: "text", text: "woof" } }));
  await expect(installPackage(src)).rejects.toThrow("widget @mallory/dog is not @acme's: every member of @acme/kit is @acme/<name>");
  expect(await readInstalledPackages()).toEqual([]);
  expect(fs.readdirSync(packagesDir()).filter((f) => f !== "installed.json.lock")).toEqual([]);
});

test("a member another installed package holds is refused, naming that package", async () => {
  await installPackage(bundle());
  await expect(installPackage(bundle("pets"))).rejects.toThrow("tool plugin @acme/prs is part of the package @acme/kit: install @acme/kit again to update it, or remove @acme/kit first");
  expect((await readInstalledPackages()).map((r) => r.id)).toEqual(["@acme/kit"]);
});

test("one plugin of a bigger package is not removed apart from it, and is switched on only while its package is on", async () => {
  await installPackage(bundle());
  await expect(removePlugin("widget", "@acme/dog")).rejects.toMatchObject({ code: "part_of_a_package", message: "widget @acme/dog is part of the package @acme/kit: remove the whole package with `hive plugins remove @acme/kit`" });
  await expect(switchPlugin("widget", "@acme/dog", true)).rejects.toThrow("widget @acme/dog is part of the package @acme/kit, which is off: switch the package on with `hive plugins enable @acme/kit`");
  await switchPackage("@acme/kit", true);
  await switchPlugin("widget", "@acme/dog", false);
  const dog = () => listWidgets().then((all) => all.find((w) => w.id === "@acme/dog")!);
  const on = async () => isPluginOn((await readSettings()).plugins.state, "widget", await dog());
  expect([(await readInstalledPackages())[0]!.on, await on()]).toEqual([true, false]);
  await switchPlugin("widget", "@acme/dog", true);
  expect(await on()).toBe(true);
});

test("a plugin installed on its own is taken over only by a package that says it replaces it, and keeps its settings", async () => {
  const dog = folder("dog", { "widget.json": JSON.stringify({ id: "@acme/dog", name: "Dog", draw: { type: "text", text: "woof" } }) });
  await installPackage(dog);
  fs.writeFileSync(process.env.HIVE_SETTINGS!, JSON.stringify({ plugins: { state: { "widget:@acme/dog": { options: { bark: "loud" } } } } }));
  await expect(installPackage(bundle())).rejects.toThrow('widget @acme/dog is installed on its own: add "replaces": ["@acme/dog"] to @acme/kit\'s hivemind-package.json to take it over, or remove it first');
  fs.rmSync(path.join(tmp, "kit"), { recursive: true });
  const { tookOver } = await installPackage(bundle("kit", "acme", { replaces: ["@acme/dog"] }));
  expect(tookOver).toEqual(["@acme/dog"]);
  expect((await readInstalledPackages()).map((r) => r.id)).toEqual(["@acme/kit"]);
  expect(fs.existsSync(path.join(packagesDir(), "store", "acme--dog"))).toBe(false);
  expect((await readSettings()).plugins.state["widget:@acme/dog"]).toEqual({ options: { bark: "loud" } });
});

test("a package replaces only its own owner's plugins", async () => {
  await expect(installPackage(bundle("kit", "acme", { replaces: ["@mallory/dog"] }))).rejects.toThrow("replaces: @mallory/dog is not @acme's");
});
