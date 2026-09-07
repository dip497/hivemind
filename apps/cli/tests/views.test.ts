import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hive } from "./helpers.js";

describe("hive views", () => {
  test("install → list → remove, and an invalid package is refused", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-views-cli-"));
    const env = { XDG_CONFIG_HOME: path.join(tmp, "xdg") };
    const src = path.join(tmp, "orbit");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "hivemind-view.json"), JSON.stringify({ id: "orbit", name: "Orbit", version: "0.1.0", entry: "index.html" }));
    fs.writeFileSync(path.join(src, "index.html"), "<!doctype html>");

    let r = hive(["views", "list", "--json"], { cwd: tmp, env });
    expect(r.code).toBe(0);
    expect((r.json as { data: unknown[] }).data).toEqual([]);

    r = hive(["views", "install", src, "--json"], { cwd: tmp, env });
    expect(r.code).toBe(0);
    expect((r.json as { data: { id: string; dir: string } }).data.dir).toBe(path.join(tmp, "xdg", "hivemind", "views", "orbit"));

    r = hive(["views", "list"], { cwd: tmp, env });
    expect(r.stdout).toMatch(/^orbit\s+0\.1\.0\s+user\s+Orbit$/m);

    const bad = path.join(tmp, "bad");
    fs.mkdirSync(bad);
    fs.writeFileSync(path.join(bad, "hivemind-view.json"), JSON.stringify({ id: "bad", name: "Bad", version: "0.1.0", entry: "index.html", permissions: ["net:fetch"] }));
    fs.writeFileSync(path.join(bad, "index.html"), "");
    r = hive(["views", "install", bad, "--json"], { cwd: tmp, env });
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ ok: false, code: "invalid_view" });
    expect((r.json as { error: string }).error).toMatch(/unknown permission "net:fetch"/);

    r = hive(["views", "remove", "orbit", "--json"], { cwd: tmp, env });
    expect(r.code).toBe(0);
    r = hive(["views", "remove", "orbit", "--json"], { cwd: tmp, env });
    expect(r.json).toMatchObject({ ok: false, code: "not_found" });
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
