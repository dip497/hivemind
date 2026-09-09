import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hive } from "./helpers.js";

test("packages inspect returns a JSON plan without an app and refuses executable fields", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-package-cli-"));
  try {
    const manifest = { apiVersion: 1, id: "example/review", name: "Review", version: "1.0.0", agents: [{ id: "reviewer", name: "Reviewer", provider: "pi", prompt: "Review the diff." }], startup: { agents: ["reviewer"] } };
    fs.writeFileSync(path.join(dir, "hivemind-package.json"), JSON.stringify(manifest));
    const result = hive(["packages", "inspect", dir, "--json"], { cwd: dir });
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ ok: true, data: { mode: "inspect-only", startup: { requiresExplicitStart: true } } });
    fs.writeFileSync(path.join(dir, "hivemind-package.json"), JSON.stringify({ ...manifest, "\x1b[2J": "untrusted key", scripts: { install: "exit 1" } }));
    const bad = hive(["packages", "inspect", dir], { cwd: dir });
    expect(bad.code).toBe(1);
    expect(bad.stderr).not.toContain("\x1b");
    expect(fs.readdirSync(dir)).toEqual(["hivemind-package.json"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
