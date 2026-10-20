// Every plugin you add is installed as a package, and goes as one: a folder holding one plugin is
// a package of one. The record says which version is in use and whether it is on; the files of a
// version are never changed once installed.
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installPackage, removePlugin, switchPlugin } from "./package-install.js";
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
