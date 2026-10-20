import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hive } from "./helpers.js";

describe("hive plugins, views", () => {
  test("install → list → remove, and an invalid package is refused", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-views-cli-"));
    const env = { XDG_CONFIG_HOME: path.join(tmp, "xdg") };
    const src = path.join(tmp, "orbit");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "hivemind-view.json"), JSON.stringify({ id: "orbit", name: "Orbit", version: "0.1.0", entry: "index.html" }));
    fs.writeFileSync(path.join(src, "index.html"), "<!doctype html>");

    let r = hive(["plugins", "list", "--kind", "view", "--json"], { cwd: tmp, env });
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ views: [] });

    r = hive(["plugins", "install", src, "--json"], { cwd: tmp, env });
    expect(r.code).toBe(0);
    expect((r.json as { id: string; dir: string }).dir).toBe(path.join(tmp, "xdg", "hivemind", "views", "orbit"));

    r = hive(["plugins", "list", "--kind", "view"], { cwd: tmp, env });
    expect(r.stdout).toMatch(/^on\s+view:orbit\s+Orbit$/m);

    const bad = path.join(tmp, "bad");
    fs.mkdirSync(bad);
    fs.writeFileSync(path.join(bad, "hivemind-view.json"), JSON.stringify({ id: "bad", name: "Bad", version: "0.1.0", entry: "index.html", permissions: ["net:fetch"] }));
    fs.writeFileSync(path.join(bad, "index.html"), "");
    r = hive(["plugins", "install", bad, "--json"], { cwd: tmp, env });
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ error: { code: "INVALID_VIEW" } });
    expect((r.json as { error: { message: string } }).error.message).toMatch(/unknown permission "net:fetch"/);

    r = hive(["plugins", "remove", "orbit", "--json"], { cwd: tmp, env });
    expect(r.code).toBe(0);
    r = hive(["plugins", "remove", "view:orbit", "--json"], { cwd: tmp, env });
    expect(r.json).toMatchObject({ error: { message: expect.stringContaining("there is no view \"orbit\"") } });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("new: a starter scoped to its owner, with the SDK the app serves as its types", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-views-new-"));
    const env = { XDG_CONFIG_HOME: path.join(tmp, "xdg") };
    let r = hive(["plugins", "new", "view", "pulse", "--owner", "@Dip497", "--json"], { cwd: tmp, env });
    expect(r.json).toMatchObject({ id: "@dip497/pulse" });
    const dir = path.join(tmp, "pulse");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "hivemind-view.json"), "utf8")).id).toBe("@dip497/pulse");
    expect(fs.readFileSync(path.join(dir, "build.mjs"), "utf8")).toContain('external: ["@hivemind/view-sdk"]');
    const sdk = path.join(__dirname, "..", "..", "..", "packages", "hive-view-sdk", "src", "protocol.ts");
    expect(fs.readFileSync(path.join(dir, "types/view-sdk/protocol.ts"), "utf8")).toEndWith(fs.readFileSync(sdk, "utf8"));
    // …and the fake host the view's own tests run against.
    expect(JSON.parse(fs.readFileSync(path.join(dir, "tsconfig.json"), "utf8")).compilerOptions.paths["@hivemind/view-sdk/testing"]).toEqual(["./types/view-sdk/testing.ts"]);
    expect(fs.readFileSync(path.join(dir, "types/view-sdk/testing.ts"), "utf8")).toContain("export function fakeHost(");
    // The manifest it writes is one the app installs.
    r = hive(["plugins", "install", dir, "--json"], { cwd: tmp, env });
    expect(r.json).toMatchObject({ id: "@dip497/pulse" });

    expect(hive(["plugins", "new", "view", "pulse", "--owner", "dip497", "--json"], { cwd: tmp, env }).json).toMatchObject({ error: { code: "EXISTS" } });
    expect(hive(["plugins", "new", "view", "Bad--name", "--owner", "dip497", "--json"], { cwd: tmp, env }).json).toMatchObject({ error: { code: "BAD_NAME" } });
    // No login to scope it with, and none given: say how, rather than invent one.
    expect(hive(["plugins", "new", "view", "other", "--json"], { cwd: tmp, env: { ...env, PATH: path.dirname(process.execPath) } }).json).toMatchObject({ error: { code: "NO_OWNER" } });
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
