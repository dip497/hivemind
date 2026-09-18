import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installView, listInstalledViews, readViewPackage, removeView, userViewsDir } from "./views.js";

let tmp: string;
const savedXdg = process.env.XDG_CONFIG_HOME;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-views-")); process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg"); });
afterEach(() => { process.env.XDG_CONFIG_HOME = savedXdg; fs.rmSync(tmp, { recursive: true, force: true }); });

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

  test("install copies into the user dir, list finds it, remove deletes it", async () => {
    pkg(path.join(tmp, "src", "orbit"), good("orbit"));
    fs.mkdirSync(path.join(tmp, "src", "orbit", "node_modules", "x"), { recursive: true });
    const v = await installView(path.join(tmp, "src", "orbit"));
    expect(v.dir).toBe(path.join(userViewsDir(), "orbit"));
    expect(fs.existsSync(path.join(v.dir, "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(v.dir, "node_modules"))).toBe(false);
    expect((await listInstalledViews()).map((x) => [x.id, x.source, x.error])).toEqual([["orbit", "user", null]]);
    await removeView("orbit");
    expect(await listInstalledViews()).toEqual([]);
    await expect(removeView("orbit")).rejects.toMatchObject({ code: "not_found" });
    await expect(removeView("../etc")).rejects.toMatchObject({ code: "invalid_view" });
  });

  test("a view from the registry installs as @owner/name, beside a bare one of the same name", async () => {
    pkg(path.join(tmp, "src", "board"), good("board"));
    pkg(path.join(tmp, "src", "hub-board"), good("@dip497/board"));
    await installView(path.join(tmp, "src", "board"));
    const scoped = await installView(path.join(tmp, "src", "hub-board"));
    expect(scoped.dir).toBe(path.join(userViewsDir(), "@dip497", "board"));
    expect((await listInstalledViews()).map((x) => [x.id, x.error])).toEqual([["@dip497/board", null], ["board", null]]);
    await removeView("@dip497/board");
    expect((await listInstalledViews()).map((x) => x.id)).toEqual(["board"]);
    // The nested form is the only one: no other path may reach `rm -rf`.
    for (const bad of ["dip497/board", "@dip497/../board", "@dip497/board/x"]) {
      await expect(removeView(bad)).rejects.toMatchObject({ code: "invalid_view" });
    }
  });

  test("a scoped folder whose manifest names someone else is refused", async () => {
    pkg(path.join(userViewsDir(), "@dip497", "board"), good("@alice/board"));
    const [v] = await listInstalledViews();
    expect(v.id).toBe("@dip497/board");
    expect(v.error).toMatch(/does not match manifest id "@alice\/board"/);
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

  test("replacement publishes the new version and removes staging files", async () => {
    const source = path.join(tmp, "source");
    pkg(source, good("orbit"));
    await installView(source);
    fs.writeFileSync(path.join(source, "hivemind-view.json"), JSON.stringify({ ...good("orbit"), version: "2.0.0" }));
    expect((await installView(source)).manifest?.version).toBe("2.0.0");
    expect(fs.readdirSync(userViewsDir())).toEqual(["orbit"]);
  });

  test("repo-local views are listed after user ones; a duplicate id is shadowed", async () => {
    const repo = path.join(tmp, "repo");
    pkg(path.join(repo, ".hivemind", "views", "orbit"), good("orbit"));
    pkg(path.join(repo, ".hivemind", "views", "ring"), good("ring"));
    pkg(path.join(userViewsDir(), "orbit"), good("orbit"));
    const all = await listInstalledViews(repo);
    expect(all.map((x) => [x.id, x.source, x.error])).toEqual([
      ["orbit", "user", null],
      ["orbit", "repo", 'shadowed by the user-installed view "orbit"'],
      ["ring", "repo", null],
    ]);
  });
});
