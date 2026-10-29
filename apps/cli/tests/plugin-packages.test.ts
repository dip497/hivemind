// `hive plugins` and packages: a folder with a hivemind-package.json installs every member it
// names as one package, and the list says which package each belongs to.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { hive } from "./helpers.js";

let tmp: string;
let run: (...args: string[]) => ReturnType<typeof hive>;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-plugin-packages-"));
  // No app: a test run inside a Hivemind tile would otherwise reach the live one.
  const env = { XDG_CONFIG_HOME: path.join(tmp, "config"), HIVE_SETTINGS: undefined, HIVE_HCP_SOCK: path.join(tmp, "no-app.sock"), HIVE_DRIVE_SOCK: path.join(tmp, "no-drive.sock") };
  run = (...args: string[]) => hive(["plugins", ...args], { cwd: tmp, env });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A package holding a tool, a widget and a view, at `version`. */
function kit(version = "1.0.0", files: Record<string, string> = {}): string {
  const root = path.join(tmp, "kit");
  const all: Record<string, string> = {
    "hivemind-package.json": JSON.stringify({
      apiVersion: 2, id: "@acme/kit", name: "Kit", version,
      tools: [{ path: "tools/prs" }], widgets: [{ path: "widgets/dog" }], views: [{ path: "views/island" }],
      agents: [{ id: "@acme/reviewer", name: "Reviewer", provider: "claude", prompt: "Review the diff." }],
    }),
    "tools/prs/hivemind-tool.json": JSON.stringify({ id: "@acme/prs", name: "PRs", version: "1.0.0", apiVersion: 1, entry: "index.js", tools: [{ key: "prs", label: "PRs", tileKind: "acme-prs" }] }),
    "tools/prs/index.js": "export default { tiles: {} };",
    "widgets/dog/widget.json": JSON.stringify({ id: "@acme/dog", name: "Dog", version: "1.0.0", draw: { type: "text", text: "woof" } }),
    "views/island/hivemind-view.json": JSON.stringify({ id: "@acme/island", name: "Island", version: "1.0.0", entry: "index.html", permissions: ["workspace:issues"] }),
    "views/island/index.html": "<!doctype html>",
    ...files,
  };
  for (const [f, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  return root;
}

describe("hive plugins, packages", () => {
  test("a package installs as one: --json names each member with its kind and permissions, and the list names its package", () => {
    const r = run("install", kit(), "--json");
    expect(r.json).toMatchObject({
      id: "@acme/kit", name: "Kit", version: "1.0.0", on: false, replaced: null,
      members: expect.arrayContaining([
        expect.objectContaining({ kind: "tool", id: "@acme/prs" }),
        expect.objectContaining({ kind: "widget", id: "@acme/dog" }),
        expect.objectContaining({ kind: "view", id: "@acme/island", permissions: ["workspace:issues"] }),
        expect.objectContaining({ kind: "agent-preset", id: "@acme/reviewer" }),
      ]),
    });
    expect(run("list").stdout).toMatch(/^off\s+widget:@acme\/dog\s+Dog\s+\[@acme\/kit 1\.0\.0, off\]$/m);
  }, 60_000);

  test("one plugin of a package is refused apart from it, exit 7, naming the package; the package is switched and removed whole", () => {
    expect(run("install", kit(), "--json").code).toBe(0);
    const removing = run("remove", "widget:@acme/dog");
    expect([removing.code, removing.stderr]).toEqual([7, expect.stringContaining("[PART_OF_A_PACKAGE] widget @acme/dog is part of the package @acme/kit: remove the whole package with `hive plugins remove @acme/kit`")]);
    expect(run("enable", "widget:@acme/dog", "--json")).toMatchObject({ code: 7, json: { error: { code: "PART_OF_A_PACKAGE", message: "widget @acme/dog is part of the package @acme/kit, which is off: switch the package on with `hive plugins enable @acme/kit`" } } });
    const dog = path.join(tmp, "dog");
    fs.mkdirSync(dog);
    fs.writeFileSync(path.join(dog, "widget.json"), JSON.stringify({ id: "@acme/dog", name: "Dog", draw: { type: "text", text: "woof" } }));
    expect(run("install", dog, "--json")).toMatchObject({ code: 7, json: { error: { code: "PART_OF_A_PACKAGE", message: expect.stringContaining("is part of the package @acme/kit") } } });

    expect(run("enable", "@acme/kit", "--json")).toMatchObject({ code: 0, json: { package: "@acme/kit", enabled: true } });
    expect(run("list").stdout).toMatch(/^on \s+widget:@acme\/dog\s+Dog\s+\[@acme\/kit 1\.0\.0\]$/m);
    expect(run("remove", "@acme/kit", "--json")).toMatchObject({ code: 0, json: { package: "@acme/kit", removed: expect.arrayContaining(["widget:@acme/dog", "tool:@acme/prs"]) } });
    expect(run("list", "--kind", "widget").stdout).not.toContain("@acme/dog");
  }, 60_000);

  test("an update that asks for more is shown first with --dry-run, then installs off; rollback puts the old version back on", () => {
    expect(run("install", kit(), "--json").code).toBe(0);
    expect(run("enable", "@acme/kit").code).toBe(0);
    const more = { "views/island/hivemind-view.json": JSON.stringify({ id: "@acme/island", name: "Island", version: "1.0.0", entry: "index.html", permissions: ["workspace:issues", "workspace:spawn"] }) };
    kit("2.0.0", more);

    const dry = run("install", path.join(tmp, "kit"), "--dry-run");
    expect(dry.stdout).toContain("would install @acme/kit (Kit), version 2.0.0, replacing 1.0.0; nothing was installed");
    expect(dry.stdout).toContain("view @acme/island: changed, now asks for workspace:spawn (switches the package off)");
    expect(run("list").stdout).toMatch(/\[@acme\/kit 1\.0\.0\]$/m);

    const updated = run("install", path.join(tmp, "kit"));
    expect(updated.stdout).toContain("It is off: a change above needs you to trust it again. `hive plugins rollback @acme/kit` puts back 1.0.0.");
    expect(run("list").stdout).toMatch(/^off\s+view:@acme\/island\s+Island\s+\[@acme\/kit 2\.0\.0, off\]$/m);

    expect(run("rollback", "@acme/kit", "--json")).toMatchObject({ code: 0, json: { id: "@acme/kit", version: "1.0.0", on: true, from: "2.0.0" } });
    expect(run("list").stdout).toMatch(/^on \s+view:@acme\/island\s+Island\s+\[@acme\/kit 1\.0\.0\]$/m);
  }, 60_000);

  test("a package that opens with a view says which, and the command that switches to it; --json carries startView, and the open comes first in next, without its widgets, which the view brings", () => {
    const harbour = path.join(tmp, "harbour");
    const files: Record<string, string> = {
      "hivemind-package.json": JSON.stringify({ apiVersion: 2, id: "@acme/harbour", name: "Harbour", version: "1.0.0", views: [{ path: "views/dock" }, { path: "views/isle" }], widgets: [{ path: "widgets/bell" }], startup: { view: "@acme/isle" } }),
      "widgets/bell/widget.json": JSON.stringify({ id: "@acme/bell", name: "Bell", version: "1.0.0", draw: { type: "text", text: "ding" } }),
      "views/dock/hivemind-view.json": JSON.stringify({ id: "@acme/dock", name: "Dock", version: "1.0.0", entry: "index.html" }),
      "views/dock/index.html": "<!doctype html>",
      "views/isle/hivemind-view.json": JSON.stringify({ id: "@acme/isle", name: "Isle", version: "1.0.0", entry: "index.html" }),
      "views/isle/index.html": "<!doctype html>",
    };
    for (const [f, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(harbour, f)), { recursive: true });
      fs.writeFileSync(path.join(harbour, f), text);
    }
    const said = run("install", harbour);
    expect(said.stdout).toContain("It opens with the view Isle, which brings its widget. The app offers to switch to it, unless it has offered that view before; `hive ctl plugin open view:@acme/isle` switches the running app now.");
    const r = run("install", harbour, "--json");
    expect(r.json).toMatchObject({ on: true, startView: { id: "@acme/isle", name: "Isle", open: "hive ctl plugin open view:@acme/isle" } });
    expect((r.json as { next: string[] }).next).toEqual(["hive ctl plugin open view:@acme/isle", "hive ctl plugin open view:@acme/dock"]);
    // One without a start view says nothing of one.
    const plain = run("install", kit(), "--json");
    expect(plain.json).toMatchObject({ startView: null });
    expect(run("install", kit()).stdout).not.toContain("opens with the view");
  }, 60_000);

  test("a package that offers a live wallpaper says so with the command that uses it; --json carries startWallpaper, in no step of next; the list shows its wallpapers with the package", () => {
    const harbour = path.join(tmp, "harbour");
    const files: Record<string, string> = {
      "hivemind-package.json": JSON.stringify({ apiVersion: 2, id: "@acme/harbour", name: "Harbour", version: "1.0.0", wallpapers: [{ path: "wallpapers/tide" }, { path: "wallpapers/fog" }], startup: { wallpaper: "@acme/harbour/tide" } }),
      "wallpapers/tide/hivemind-wallpaper.json": JSON.stringify({ protocol: 1, name: "Tide", entry: "main.js" }),
      "wallpapers/tide/main.js": "",
      "wallpapers/fog/hivemind-wallpaper.json": JSON.stringify({ protocol: 1, name: "Fog", entry: "main.js" }),
      "wallpapers/fog/main.js": "",
    };
    for (const [f, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(harbour, f)), { recursive: true });
      fs.writeFileSync(path.join(harbour, f), text);
    }
    const use = "hive config set appearance.wallpaper.kind '\"@acme/harbour/tide\"'";
    expect(run("install", harbour).stdout).toContain(`It offers its live wallpaper Tide as the background: the app asks whether to use it. \`${use}\` uses it now.`);
    const r = run("install", harbour, "--json");
    expect(r.json).toMatchObject({ on: true, startWallpaper: { id: "@acme/harbour/tide", name: "Tide", use }, next: [] });
    expect(run("list").stdout).toMatch(/^on \s+wallpaper:@acme\/harbour\/tide\s+Tide\s+\[@acme\/harbour 1\.0\.0\]$/m);
    expect((run("list", "--kind", "wallpaper", "--json").json as { plugins: unknown[] }).plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "wallpaper:@acme/harbour/fog", name: "Fog", enabled: true, problem: null, package: expect.objectContaining({ id: "@acme/harbour" }) }),
    ]));
    // One that offers none says nothing of one.
    expect(run("install", kit(), "--json").json).toMatchObject({ startWallpaper: null });
    expect(run("install", kit()).stdout).not.toContain("live wallpaper");
  }, 60_000);

  test("a package listed on HiveHub installs whole by its id, every file checked; a listing whose manifest names another package is refused", () => {
    const root = kit();
    const files = (dir: string, rel = ""): string[] => fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? files(dir, path.join(rel, e.name)) : [path.join(rel, e.name)]));
    const entry = (id: string) => ({
      id, type: "package", name: "Kit", description: "A kit.", author: "acme", version: "1.0.0", path: "kit",
      files: files(root).map((f) => ({ path: f, sha256: createHash("sha256").update(fs.readFileSync(path.join(root, f))).digest("hex") })),
      members: [{ kind: "widget", id: "@acme/dog", name: "Dog", permissions: [] }],
    });
    const index = path.join(tmp, "index.json");
    fs.writeFileSync(index, JSON.stringify({ version: 1, plugins: [entry("@acme/kit"), entry("@acme/other")] }));
    const hub = (...args: string[]) => hive(["plugins", ...args], { cwd: tmp, env: { XDG_CONFIG_HOME: path.join(tmp, "config"), HIVE_SETTINGS: undefined, HIVE_HCP_SOCK: path.join(tmp, "no-app.sock"), HIVE_DRIVE_SOCK: path.join(tmp, "no-drive.sock"), HIVEMIND_PLUGIN_INDEX: pathToFileURL(index).href } });

    expect(hub("install", "@acme/other", "--json")).toMatchObject({ code: 1, json: { error: { message: expect.stringContaining(`says it is "@acme/kit", not @acme/other`) } } });
    const got = hub("install", "@acme/kit", "--json");
    expect(got.json).toMatchObject({ id: "@acme/kit", version: "1.0.0" });
    expect((got.json as { members: Array<{ kind: string }> }).members.map((m) => m.kind).sort()).toEqual(["agent-preset", "tool", "view", "widget"]);
  }, 60_000);
});
