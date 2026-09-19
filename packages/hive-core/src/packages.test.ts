import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectPackage, parsePackageManifest, PACKAGE_LIMITS } from "./packages.js";

let dir: string;
const providers = [{ id: "test-agent", enabled: true, modelFlag: false, supervision: "none" }];
const manifest = () => ({
  apiVersion: 1, id: "example/review-room", name: "Review room", version: "1.0.0",
  views: [{ path: "views/room" }],
  agents: [{ id: "reviewer", name: "Reviewer", provider: "test-agent", prompt: "Review the diff." }],
  startup: { view: "room", agents: ["reviewer"], maxConcurrent: 1 },
});
const write = (name: string, value: unknown) => fs.writeFile(path.join(dir, name), JSON.stringify(value));
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hive-package-"));
  await fs.mkdir(path.join(dir, "views/room"), { recursive: true });
  await write("hivemind-package.json", manifest());
  await write("views/room/hivemind-view.json", { id: "room", name: "Room", version: "1.0.0", entry: "main.js", protocol: 1, permissions: [] });
  await fs.writeFile(path.join(dir, "views/room/main.js"), `throw new Error("package code must not execute");`);
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("workspace package inspection", () => {
  test("reviews a view and agent together without executing or installing them", async () => {
    const r = await inspectPackage(dir, providers);
    expect(r.mode).toBe("inspect-only");
    expect(r.views.map((v) => v.id)).toEqual(["room"]);
    expect(r.startup?.agents[0]?.prompt).toBe("Review the diff.");
    expect(r.startup?.requiresExplicitStart).toBe(true);
    expect(r.files).toHaveLength(3);
    expect((await fs.readdir(dir)).sort()).toEqual(["hivemind-package.json", "views"]);
    expect(r.digest.value).toMatch(/^[a-f0-9]{64}$/);
  });
  test("hash covers assets, not only manifest metadata", async () => {
    const a = await inspectPackage(dir, providers);
    expect((await inspectPackage(dir, providers)).digest).toEqual(a.digest);
    await fs.writeFile(path.join(dir, "views/room/main.js"), "different bytes");
    expect((await inspectPackage(dir, providers)).digest).not.toEqual(a.digest);
  });
  test.each(["../outside", "/tmp/outside", "views/../room", "views\\room"])("refuses escaping component path %s", (bad) => {
    expect(() => parsePackageManifest({ ...manifest(), views: [{ path: bad }] })).toThrow();
  });
  test("unknown executable hooks, environment and permission overrides fail closed", () => {
    for (const extra of [{ scripts: { install: "curl | sh" } }, { providers: [{ entry: "evil.js" }] }, { permissions: ["fs:*"] }]) {
      expect(() => parsePackageManifest({ ...manifest(), ...extra })).toThrow();
    }
    for (const extra of [{ env: { TOKEN: "secret" } }, { args: ["--dangerously-skip-permissions"] }, { mode: "bypassPermissions" }]) {
      expect(() => parsePackageManifest({ ...manifest(), agents: [{ ...manifest().agents[0], ...extra }] })).toThrow();
    }
  });
  test("rejects missing startup references, duplicates, and unbounded bursts", async () => {
    expect(() => parsePackageManifest({ ...manifest(), startup: { agents: ["missing"] } })).toThrow("unknown startup agent");
    expect(() => parsePackageManifest({ ...manifest(), agents: [...manifest().agents, ...manifest().agents] })).toThrow("duplicate");
    expect(() => parsePackageManifest({ ...manifest(), startup: { agents: ["reviewer", "reviewer"] } })).toThrow("duplicate");
    expect(() => parsePackageManifest({ ...manifest(), startup: { agents: ["reviewer"], maxConcurrent: 50 } })).toThrow();
    await write("hivemind-package.json", { ...manifest(), startup: { view: "missing" } });
    await expect(inspectPackage(dir, providers)).rejects.toThrow("unknown startup view");
  });
  test("rejects unsupported providers and unsupported model overrides", async () => {
    await expect(inspectPackage(dir, [])).rejects.toThrow("provider is not supported");
    await write("hivemind-package.json", { ...manifest(), agents: [{ ...manifest().agents[0], model: "made-up" }] });
    await expect(inspectPackage(dir, providers)).rejects.toThrow("model selection");
  });
  test("rejects symlinks, hardlinks, and linked directories", async () => {
    const target = path.join(dir, "views/room/main.js");
    await fs.symlink(target, path.join(dir, "link.js"));
    await expect(inspectPackage(dir, providers)).rejects.toThrow("symlink");
    await fs.unlink(path.join(dir, "link.js"));
    await fs.symlink(path.dirname(target), path.join(dir, "linked-dir"));
    await expect(inspectPackage(dir, providers)).rejects.toThrow("symlink");
    await fs.unlink(path.join(dir, "linked-dir"));
    await fs.link(target, path.join(dir, "hard.js"));
    await expect(inspectPackage(dir, providers)).rejects.toThrow("non-linked");
  });
  test("rejects oversized files before reading their content", async () => {
    const f = await fs.open(path.join(dir, "large.bin"), "w");
    await f.truncate(PACKAGE_LIMITS.fileBytes + 1); await f.close();
    await expect(inspectPackage(dir, providers)).rejects.toThrow("too large");
  });
  test("bounds manifest size and directory depth even for unused assets", async () => {
    const file = path.join(dir, "hivemind-package.json");
    const original = await fs.readFile(file);
    await fs.writeFile(file, " ".repeat(PACKAGE_LIMITS.jsonBytes + 1));
    await expect(inspectPackage(dir, providers)).rejects.toThrow("too large");
    await fs.writeFile(file, original);
    await fs.mkdir(path.join(dir, ...Array.from({ length: PACKAGE_LIMITS.depth + 1 }, () => "nested")), { recursive: true });
    await expect(inspectPackage(dir, providers)).rejects.toThrow("too deep");
  });
  test("counts empty directories toward the package entry limit", async () => {
    for (let i = 0; i <= PACKAGE_LIMITS.files; i++) await fs.mkdir(path.join(dir, `empty-${i}`));
    await expect(inspectPackage(dir, providers)).rejects.toThrow("too many entries");
  });
  test("refuses reserved view ids, future protocols, unknown permissions, and missing entries", async () => {
    const base = { id: "room", name: "Room", version: "1.0.0", entry: "main.js", permissions: [] };
    for (const [extra, error] of [[{ id: "canvas" }, "reserved"], [{ protocol: 999 }, "protocol"], [{ permissions: ["fs:read"] }, "permission"], [{ entry: "missing.js" }, "missing view entry"]] as const) {
      await write("views/room/hivemind-view.json", { ...base, ...extra });
      await expect(inspectPackage(dir, providers)).rejects.toThrow(error);
    }
  });
});
