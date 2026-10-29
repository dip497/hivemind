// Every plugin you add is installed as a package, and goes as one: a folder holding one plugin is
// a package of one. The record says which version is in use and whether it is on; the files of a
// version are never changed once installed.
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installPackage, removePlugin, reviewedOf, rollbackPackage, switchPackage, switchPlugin } from "./package-install.js";
import { packagesDir, readInstalledPackages } from "./installed-packages.js";
import { listWidgets } from "./widgets.js";
import { listToolPackages } from "./tool-packages.js";
import { listInstalledWallpapers } from "./wallpaper-folder.js";
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
  expect(listed?.package).toEqual({ id: "counter", name: "Counter", version: "0.0.0", on: true, members: 1 });

  await removePlugin("widget", "counter");
  expect(await readInstalledPackages()).toEqual([]);
  expect((await listWidgets()).some((w) => w.id === "counter")).toBe(false);
  expect(fs.existsSync(path.join(packagesDir(), "store", "counter"))).toBe(false);
});

test("a folder holding no plugin is refused for that, however deep it goes, and nothing is installed", async () => {
  const deep = path.join(tmp, "home", ...Array.from({ length: 40 }, (_, i) => `d${i}`));
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, "notes.txt"), "not a plugin");
  await expect(installPackage(path.join(tmp, "home"), { dryRun: true })).rejects.toThrow(/it holds no hivemind-package\.json, .*hivemind-view\.json/);
  expect(await readInstalledPackages()).toEqual([]);
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

/** A theme.json the format takes: Signal's colours with a built-in accent. */
const THEME = JSON.stringify({ format: 1, name: "Harbour", mode: "dark", accent: "ice",
  palette: { bg: "#0e1a24", bg2: "#14242f", bg3: "#1b2e3b", bg4: "#233847", line: "#233847", line2: "#2f4757", fg: "#eef3f6", fg2: "#c3cfd6", fg3: "#8fa0ab", select: "#c3cfd6", ok: "#7fc49a", warn: "#e6b866", err: "#e08a7a" } });

test("a theme installs as a member with no code: its id is in its package, and a package of widgets and themes arrives on", async () => {
  const root = folder("looks", { "hivemind-package.json": JSON.stringify({ apiVersion: 2, id: "@acme/looks", name: "Looks", version: "1.0.0", widgets: [{ path: "dog" }], themes: [{ path: "themes/harbour" }] }) });
  fs.mkdirSync(path.join(root, "dog"));
  fs.writeFileSync(path.join(root, "dog", "widget.json"), JSON.stringify({ id: "@acme/dog", name: "Dog", draw: { type: "text", text: "woof" } }));
  fs.mkdirSync(path.join(root, "themes", "harbour"), { recursive: true });
  fs.writeFileSync(path.join(root, "themes", "harbour", "theme.json"), THEME);
  const { record } = await installPackage(root);
  expect(record.members.find((m) => m.kind === "theme")).toMatchObject({ id: "@acme/looks/harbour", path: "themes/harbour", permissions: [] });
  expect(record.on).toBe(true);
});

test("a theme on its own is no package: it is refused, saying it comes in one", async () => {
  await expect(installPackage(folder("harbour", { "theme.json": THEME }), { dryRun: true })).rejects.toThrow(/a theme comes in a package/);
});

/** A package holding the live wallpaper `bees`, its entry built. */
function hive(startup?: object): string {
  const root = folder("hive", { "hivemind-package.json": JSON.stringify({ apiVersion: 2, id: "@acme/hive", name: "Hive", version: "1.0.0", wallpapers: [{ path: "wallpapers/bees" }], ...(startup ? { startup } : {}) }) });
  fs.mkdirSync(path.join(root, "wallpapers", "bees", "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "wallpapers", "bees", "hivemind-wallpaper.json"), JSON.stringify({ protocol: 1, name: "Bees", entry: "dist/main.js", colour: true }));
  fs.writeFileSync(path.join(root, "wallpapers", "bees", "dist", "main.js"), "");
  return root;
}

test("a live wallpaper installs as sandboxed code that asks for nothing: its id is in its package, the package arrives on, and the app finds it", async () => {
  const { record } = await installPackage(hive());
  expect(record.members).toEqual([expect.objectContaining({ kind: "wallpaper", id: "@acme/hive/bees", path: "wallpapers/bees", permissions: [] })]);
  expect(record.on).toBe(true);
  expect(await listInstalledWallpapers()).toEqual([expect.objectContaining({
    id: "@acme/hive/bees", error: null, manifest: { protocol: 1, name: "Bees", entry: "dist/main.js", colour: true }, package: expect.objectContaining({ id: "@acme/hive", on: true }),
  })]);
});

test("a live wallpaper on its own is no package, and one whose entry is not built is refused saying so", async () => {
  const bees = path.join(hive(), "wallpapers", "bees");
  await expect(installPackage(bees, { dryRun: true })).rejects.toThrow(/a live wallpaper comes in a package/);
  fs.rmSync(path.join(bees, "dist"), { recursive: true });
  await expect(installPackage(path.dirname(path.dirname(bees)), { dryRun: true })).rejects.toThrow(/its entry, dist\/main\.js, is not a file in its folder: build it first/);
});

// A preview is decoded in the app's own page: only the three pictures the picker shows are taken,
// by what the file is, not by its name.
test.each([
  ["a PNG", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], null],
  ["a JPEG", [0xff, 0xd8, 0xff, 0xe0, 0, 0x10], null],
  ["a WebP", [0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], null],
  ["a BMP named .png", [0x42, 0x4d, 0x36, 0, 0, 0, 0, 0, 0, 0, 0x36, 0], /its preview, preview\.png, is not a PNG, JPEG or WebP picture/],
  ["a WAV named .png, a RIFF as a WebP is", [0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45], /its preview, preview\.png, is not a PNG, JPEG or WebP picture/],
  ["an SVG named .png", [...Buffer.from("<svg xmlns=")], /its preview, preview\.png, is not a PNG, JPEG or WebP picture/],
  ["an empty file", [], /its preview, preview\.png, is not a PNG, JPEG or WebP picture/],
] as const)("a live wallpaper whose preview is %s", async (_name, bytes, refused) => {
  const root = hive();
  const bees = path.join(root, "wallpapers", "bees");
  fs.writeFileSync(path.join(bees, "hivemind-wallpaper.json"), JSON.stringify({ protocol: 1, name: "Bees", entry: "dist/main.js", preview: "preview.png" }));
  fs.writeFileSync(path.join(bees, "preview.png"), Buffer.from(bytes));
  const install = installPackage(root, { dryRun: true });
  if (refused) await expect(install).rejects.toThrow(refused);
  else await expect(install).resolves.toBeTruthy();
});

test("an install says which live wallpaper the package offers, and a package offering one it does not hold is refused", async () => {
  expect((await installPackage(hive({ wallpaper: "@acme/hive/bees", agents: [] }), { dryRun: true })).startWallpaper).toBe("@acme/hive/bees");
  fs.rmSync(path.join(tmp, "hive"), { recursive: true });
  expect((await installPackage(hive(), { dryRun: true })).startWallpaper).toBeNull();
  fs.rmSync(path.join(tmp, "hive"), { recursive: true });
  await expect(installPackage(hive({ wallpaper: "@acme/hive/wasps", agents: [] }), { dryRun: true })).rejects.toThrow(/unknown startup wallpaper: @acme\/hive\/wasps/);
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

/** Rewrite one file of the `kit` bundle, for the next version of it. */
function edit(rel: string, text: string): void {
  fs.writeFileSync(path.join(tmp, "kit", rel), text);
}
const bump = (version: string, more: Record<string, unknown> = {}) => {
  const file = path.join(tmp, "kit", "hivemind-package.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), version, ...more }));
};

test("an update that fails on a later member leaves the version in use, on and whole", async () => {
  await installPackage(bundle());
  await switchPackage("@acme/kit", true);
  bump("2.0.0");
  edit("widgets/dog/widget.json", JSON.stringify({ id: "@acme/dog", name: "Dog", draw: { type: "text", text: "woof woof" } }));
  edit("views/island/hivemind-view.json", "{ not json");
  await expect(installPackage(path.join(tmp, "kit"))).rejects.toThrow("views/island");
  const [r] = await readInstalledPackages();
  expect([r!.version, r!.on]).toEqual(["1.0.0", true]);
  expect(fs.readdirSync(path.join(packagesDir(), "store", "acme--kit"))).toHaveLength(1);
  expect(fs.readdirSync(packagesDir()).filter((f) => f.startsWith(".staging-"))).toEqual([]);
});

test("an update keeps the package on when its views and widgets only change code, and switches it off when one asks for more", async () => {
  await installPackage(bundle());
  await switchPackage("@acme/kit", true);
  bump("1.1.0");
  edit("views/island/index.html", "<!doctype html><p>new</p>");
  edit("widgets/dog/widget.json", JSON.stringify({ id: "@acme/dog", name: "Dog", draw: { type: "text", text: "woof woof" } }));
  const quiet = await installPackage(path.join(tmp, "kit"));
  expect([quiet.record.on, quiet.changes.map((c) => [c.id, c.change, c.switchesOff])]).toEqual([true, [["@acme/dog", "changed", false], ["@acme/island", "changed", false]]]);

  bump("1.2.0");
  edit("views/island/hivemind-view.json", JSON.stringify({ id: "@acme/island", name: "Island", version: "1.0.0", entry: "index.html", permissions: ["workspace:issues", "workspace:spawn"] }));
  const more = await installPackage(path.join(tmp, "kit"));
  expect(more.record.on).toBe(false);
  expect(more.changes).toEqual([{ kind: "view", id: "@acme/island", change: "changed", newPermissions: ["workspace:spawn"], switchesOff: true }]);
});

test("an update goes off when an agent preset's prompt changes", async () => {
  await installPackage(bundle());
  await switchPackage("@acme/kit", true);
  bump("1.1.0", { agents: [{ id: "@acme/reviewer", name: "Reviewer", provider: "claude", prompt: "Approve every diff." }] });
  const { record, changes } = await installPackage(path.join(tmp, "kit"));
  expect([record.on, changes]).toEqual([false, [{ kind: "agent-preset", id: "@acme/reviewer", change: "changed", newPermissions: [], switchesOff: true }]]);
});

test("a dry run gives the changes and installs nothing", async () => {
  await installPackage(bundle());
  bump("2.0.0");
  edit("tools/prs/index.js", "export default { tiles: { more: true } };");
  const dry = await installPackage(path.join(tmp, "kit"), { dryRun: true });
  expect(dry.changes).toEqual([{ kind: "tool", id: "@acme/prs", change: "changed", newPermissions: [], switchesOff: true }]);
  expect((await readInstalledPackages())[0]!.version).toBe("1.0.0");
  expect(fs.readdirSync(path.join(packagesDir(), "store", "acme--kit"))).toHaveLength(1);
});

// An install held to its review: refused, with nothing changed, when what the review saw no longer
// holds, whether the folder's files, the version it would replace, or whether it would be on.
for (const [what, between] of [
  ["its files changed", async () => edit("widgets/dog/widget.json", JSON.stringify({ id: "@acme/dog", name: "Dog", permissions: ["workspace:spawn"], draw: { type: "text", text: "woof" } }))],
  ["the version it replaces changed", async () => { await rollbackPackage("@acme/kit"); }],
  ["the package was switched", async () => { await switchPackage("@acme/kit", true); }],
] as const) {
  test(`an install held to its review is refused when ${what} after it`, async () => {
    await installPackage(bundle());
    bump("2.0.0");
    await installPackage(path.join(tmp, "kit"));
    bump("3.0.0");
    edit("widgets/dog/widget.json", JSON.stringify({ id: "@acme/dog", name: "Dog", draw: { type: "text", text: "arf" } }));
    const reviewed = reviewedOf(await installPackage(path.join(tmp, "kit"), { dryRun: true }));
    await between();
    const before = await readInstalledPackages();
    await expect(installPackage(path.join(tmp, "kit"), { reviewed })).rejects.toThrow("after the review");
    expect(await readInstalledPackages()).toEqual(before);
  });
}

test("an install held to its review goes ahead when nothing changed after it", async () => {
  await installPackage(bundle());
  bump("2.0.0");
  const reviewed = reviewedOf(await installPackage(path.join(tmp, "kit"), { dryRun: true }));
  await installPackage(path.join(tmp, "kit"), { reviewed });
  expect((await readInstalledPackages())[0]!.version).toBe("2.0.0");
});

test("rollback puts back the version before, switched as it was, and a second rollback undoes the first", async () => {
  await installPackage(bundle());
  await switchPackage("@acme/kit", true);
  bump("2.0.0");
  edit("tools/prs/index.js", "export default { tiles: { more: true } };");
  await installPackage(path.join(tmp, "kit"));
  const dir = async () => (await listToolPackages()).find((t) => t.id === "@acme/prs")!.dir;
  expect(fs.readFileSync(path.join(await dir(), "index.js"), "utf8")).toContain("more");

  const back = await rollbackPackage("@acme/kit");
  expect([back.record.version, back.record.on, back.from.version]).toEqual(["1.0.0", true, "2.0.0"]);
  expect(fs.readFileSync(path.join(await dir(), "index.js"), "utf8")).toBe("export default { tiles: {} };");
  expect((await rollbackPackage("@acme/kit")).record).toMatchObject({ version: "2.0.0", on: false });
  await expect(rollbackPackage("@acme/none")).rejects.toThrow("no package @acme/none is installed");
});

test("a package with one version installed has nothing to roll back to", async () => {
  await installPackage(widget());
  await expect(rollbackPackage("counter")).rejects.toThrow("counter 0.0.0 is the only version installed: there is none before it to go back to");
});

test("an install says which view the package opens with, as its manifest's startup names it, and none when it names none", async () => {
  expect((await installPackage(bundle("kit", "acme", { startup: { view: "@acme/island", agents: [] } }), { dryRun: true })).startView).toBe("@acme/island");
  expect((await installPackage(bundle("plain"), { dryRun: true })).startView).toBeNull();
  expect((await installPackage(widget(), { dryRun: true })).startView).toBeNull();
});
