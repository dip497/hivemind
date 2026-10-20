// `hive plugins` and packages: a folder with a hivemind-package.json installs every member it
// names as one package, and the list says which package each belongs to.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
    "widgets/dog/widget.json": JSON.stringify({ id: "@acme/dog", name: "Dog", draw: { type: "text", text: "woof" } }),
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
      ok: true,
      data: {
        id: "@acme/kit", name: "Kit", version: "1.0.0", on: false, replaced: null,
        members: expect.arrayContaining([
          expect.objectContaining({ kind: "tool", id: "@acme/prs" }),
          expect.objectContaining({ kind: "widget", id: "@acme/dog" }),
          expect.objectContaining({ kind: "view", id: "@acme/island", permissions: ["workspace:issues"] }),
          expect.objectContaining({ kind: "agent-preset", id: "@acme/reviewer" }),
        ]),
      },
    });
    expect(run("list").stdout).toMatch(/^off\s+widget:@acme\/dog\s+Dog\s+\[@acme\/kit 1\.0\.0, off\]$/m);
  }, 60_000);

  test("one plugin of a package is refused apart from it, exit 7, naming the package; the package is switched and removed whole", () => {
    expect(run("install", kit(), "--json").code).toBe(0);
    const removing = run("remove", "widget:@acme/dog");
    expect([removing.code, removing.stderr]).toEqual([7, expect.stringContaining("[part_of_a_package] widget @acme/dog is part of the package @acme/kit: remove the whole package with `hive plugins remove @acme/kit`")]);
    expect(run("enable", "widget:@acme/dog", "--json")).toMatchObject({ code: 7, json: { ok: false, code: "part_of_a_package", error: "widget @acme/dog is part of the package @acme/kit, which is off: switch the package on with `hive plugins enable @acme/kit`" } });
    const dog = path.join(tmp, "dog");
    fs.mkdirSync(dog);
    fs.writeFileSync(path.join(dog, "widget.json"), JSON.stringify({ id: "@acme/dog", name: "Dog", draw: { type: "text", text: "woof" } }));
    expect(run("install", dog, "--json")).toMatchObject({ code: 7, json: { code: "part_of_a_package", error: expect.stringContaining("is part of the package @acme/kit") } });

    expect(run("enable", "@acme/kit", "--json")).toMatchObject({ code: 0, json: { data: { package: "@acme/kit", enabled: true } } });
    expect(run("list").stdout).toMatch(/^on \s+widget:@acme\/dog\s+Dog\s+\[@acme\/kit 1\.0\.0\]$/m);
    expect(run("remove", "@acme/kit", "--json")).toMatchObject({ code: 0, json: { data: { package: "@acme/kit", removed: expect.arrayContaining(["widget:@acme/dog", "tool:@acme/prs"]) } } });
    expect(run("list", "--kind", "widget").stdout).not.toContain("@acme/dog");
  }, 60_000);
});
