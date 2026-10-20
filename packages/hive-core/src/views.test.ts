import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listInstalledViews, readViewPackage } from "./views.js";
import { installPackage, removePlugin } from "./package-install.js";
import { packagesDir } from "./installed-packages.js";

const installView = async (dir: string) => (await installPackage(dir)).members[0]!;

let tmp: string;
const savedXdg = process.env.XDG_CONFIG_HOME;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-views-")); process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg"); });
// Unset again when it was unset: `= undefined` would set the text "undefined" (see settings.test.ts).
afterEach(() => { if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg; fs.rmSync(tmp, { recursive: true, force: true }); });

function pkg(dir: string, manifest: unknown, entry = "index.html") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "hivemind-view.json"), JSON.stringify(manifest));
  if (entry) fs.writeFileSync(path.join(dir, entry), "<!doctype html>");
}
const good = (id: string) => ({ id, name: id, version: "1.0.0", entry: "index.html" });

describe("view packages", () => {
  test("readViewPackage: valid, missing manifest, bad manifest, id mismatch, missing entry", async () => {
    pkg(path.join(tmp, "orbit"), good("orbit"));
    expect((await readViewPackage(path.join(tmp, "orbit"), "user")).error).toBeNull();
    fs.mkdirSync(path.join(tmp, "empty"));
    expect((await readViewPackage(path.join(tmp, "empty"), "user")).error).toMatch(/cannot read hivemind-view.json/);
    pkg(path.join(tmp, "bad"), { id: "bad", permissions: ["fs:read"] });
    expect((await readViewPackage(path.join(tmp, "bad"), "user")).error).toMatch(/unknown permission "fs:read"/);
    pkg(path.join(tmp, "other"), good("orbit"));
    expect((await readViewPackage(path.join(tmp, "other"), "user")).error).toMatch(/does not match manifest id/);
    expect((await readViewPackage(path.join(tmp, "other"), "user", false)).error).toBeNull(); // a source dir may be named anything
    pkg(path.join(tmp, "noentry"), good("noentry"), "");
    expect((await readViewPackage(path.join(tmp, "noentry"), "user")).error).toMatch(/entry "index.html" not found/);
  });

  test("a view's icon is the .svg its manifest names, as a data URL; a missing or over 32 KB one leaves the view loading with none", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>';
    pkg(path.join(tmp, "board"), { ...good("board"), icon: "icon.svg" });
    fs.writeFileSync(path.join(tmp, "board", "icon.svg"), svg);
    const v = await readViewPackage(path.join(tmp, "board"), "user");
    expect([v.error, v.icon]).toEqual([null, `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`]);
    pkg(path.join(tmp, "plain"), { ...good("plain"), icon: "gone.svg" });
    const plain = await readViewPackage(path.join(tmp, "plain"), "user");
    expect([plain.error, plain.icon]).toEqual([null, undefined]);
    pkg(path.join(tmp, "heavy"), { ...good("heavy"), icon: "icon.svg" });
    fs.writeFileSync(path.join(tmp, "heavy", "icon.svg"), `<svg>${" ".repeat(32 * 1024)}</svg>`);
    const heavy = await readViewPackage(path.join(tmp, "heavy"), "user");
    expect([heavy.error, heavy.icon]).toEqual([null, undefined]);
  });

  test("install copies it into a package, list finds it, remove deletes it", async () => {
    pkg(path.join(tmp, "src", "orbit"), good("orbit"));
    fs.mkdirSync(path.join(tmp, "src", "orbit", "node_modules", "x"), { recursive: true });
    const v = await installView(path.join(tmp, "src", "orbit"));
    expect(v.dir.startsWith(path.join(packagesDir(), "store", "orbit") + path.sep)).toBe(true);
    expect(fs.existsSync(path.join(v.dir, "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(v.dir, "node_modules"))).toBe(false);
    expect((await listInstalledViews()).map((x) => [x.id, x.source, x.error])).toEqual([["orbit", "user", null]]);
    await removePlugin("view", "orbit");
    expect(await listInstalledViews()).toEqual([]);
    await expect(removePlugin("view", "orbit")).rejects.toThrow("no view orbit is installed");
  });

  test("a view from the registry installs as @owner/name, beside a bare one of the same name", async () => {
    pkg(path.join(tmp, "src", "notes"), good("notes"));
    pkg(path.join(tmp, "src", "hub-notes"), good("@someone/notes"));
    await installView(path.join(tmp, "src", "notes"));
    await installView(path.join(tmp, "src", "hub-notes"));
    expect((await listInstalledViews()).map((x) => [x.id, x.error]).sort()).toEqual([["@someone/notes", null], ["notes", null]]);
    await removePlugin("view", "@someone/notes");
    expect((await listInstalledViews()).map((x) => x.id)).toEqual(["notes"]);
  });

  test("an installed view whose manifest was changed to name someone else does not load", async () => {
    pkg(path.join(tmp, "src", "notes"), good("@someone/notes"));
    const v = await installView(path.join(tmp, "src", "notes"));
    fs.writeFileSync(path.join(v.dir, "hivemind-view.json"), JSON.stringify(good("@alice/notes")));
    const [listed] = await listInstalledViews();
    expect(listed!.id).toBe("@someone/notes");
    expect(listed!.error).toMatch(/says it is "@alice\/notes", not "@someone\/notes"/);
  });

  test("install refuses an invalid package", async () => {
    pkg(path.join(tmp, "src", "bad"), { ...good("bad"), permissions: ["net:fetch"] });
    await expect(installView(path.join(tmp, "src", "bad"))).rejects.toMatchObject({ code: "invalid_view" });
    expect(await listInstalledViews()).toEqual([]);
  });

  test("a failed replacement copy preserves the installed version", async () => {
    const source = path.join(tmp, "source");
    pkg(source, good("orbit"));
    await installView(source);
    fs.writeFileSync(path.join(source, "hivemind-view.json"), JSON.stringify({ ...good("orbit"), version: "2.0.0" }));
    fs.symlinkSync(path.join(tmp, "missing-asset"), path.join(source, "broken-asset"));
    await expect(installView(source)).rejects.toThrow();
    const installed = await listInstalledViews();
    expect(installed).toHaveLength(1);
    expect(installed[0]!.manifest?.version).toBe("1.0.0");
    expect(fs.existsSync(path.join(installed[0]!.dir, "index.html"))).toBe(true);
  });

  test("replacement publishes the new version, keeps the one before it, and leaves no staging behind", async () => {
    const source = path.join(tmp, "source");
    pkg(source, good("orbit"));
    await installView(source);
    fs.writeFileSync(path.join(source, "hivemind-view.json"), JSON.stringify({ ...good("orbit"), version: "2.0.0" }));
    await installView(source);
    expect((await listInstalledViews())[0]!.manifest?.version).toBe("2.0.0");
    expect(fs.readdirSync(packagesDir()).filter((f) => f.startsWith("."))).toEqual([]);
    expect(fs.readdirSync(path.join(packagesDir(), "store", "orbit")).map((f) => f.split("-")[0]).sort()).toEqual(["1.0.0", "2.0.0"]);
  });

  test("repo-local views are listed after user ones; a duplicate id is shadowed", async () => {
    const repo = path.join(tmp, "repo");
    pkg(path.join(repo, ".hivemind", "views", "orbit"), good("orbit"));
    pkg(path.join(repo, ".hivemind", "views", "ring"), good("ring"));
    pkg(path.join(tmp, "src", "orbit"), good("orbit"));
    await installView(path.join(tmp, "src", "orbit"));
    const all = await listInstalledViews(repo);
    expect(all.map((x) => [x.id, x.source, x.error])).toEqual([
      ["orbit", "user", null],
      ["orbit", "repo", 'shadowed by the user-installed view "orbit"'],
      ["ring", "repo", null],
    ]);
  });

  test("the app's own are listed first, and one installed under the id of one replaces it", async () => {
    const own = path.join(tmp, "app-views");
    pkg(path.join(own, "windows"), good("windows"));
    pkg(path.join(own, "dock"), good("dock"));
    pkg(path.join(tmp, "src", "dock"), good("dock"));
    await installView(path.join(tmp, "src", "dock"));
    const all = await listInstalledViews(null, own);
    expect(all.map((x) => [x.id, x.source, x.error])).toEqual([
      ["dock", "app", 'replaced by the installed view "dock"'],
      ["windows", "app", null],
      ["dock", "user", null],
    ]);
  });

  test("a view cannot be installed under the id of a view the app is built around", async () => {
    pkg(path.join(tmp, "src", "windows"), good("windows"));
    await expect(installView(path.join(tmp, "src", "windows"))).rejects.toThrow("windows is the id of a view that comes with the app");
  });
});
