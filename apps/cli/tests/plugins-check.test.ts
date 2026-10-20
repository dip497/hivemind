// `hive plugins check <folder>`: one path for every kind. A starter as written passes all three
// steps, and a throw where its code draws is reported as a draw problem at the line that threw.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hive } from "./helpers.js";

const REPO = path.join(import.meta.dir, "../../..");
/** What `npm install` puts in a view starter's folder, taken from this checkout. */
const installViewDeps = (dir: string) => {
  fs.mkdirSync(path.join(dir, "node_modules"));
  const deps = { esbuild: path.join(REPO, "node_modules/esbuild") };
  for (const [name, from] of Object.entries(deps)) fs.symlinkSync(fs.realpathSync(from), path.join(dir, "node_modules", name));
};

const KINDS = [
  { kind: "tool", file: "index.js", at: "  const refresh = ", insert: "  throw new Error(\"boom while drawing\");\n" },
  { kind: "widget", file: "widget.js", at: "hive.on(\"start\", draw);", insert: "hive.on(\"start\", () => { throw new Error(\"boom while drawing\"); });\n" },
  { kind: "view", file: "src/main.ts", at: "  list.replaceChildren();", insert: "  throw new Error(\"boom while drawing\");\n" },
] as const;

interface Report { ok: boolean; data: { steps: Record<string, string>; problems: { step: string; file?: string; line?: number; message: string }[] } }

describe("hive plugins check", () => {
  for (const k of KINDS) {
    test(`${k.kind}: a starter passes; a throw while it draws is a draw problem at its file and line`, () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `hive-check-${k.kind}-`));
      const dir = path.join(tmp, "tally");
      try {
        expect(hive(["plugins", "new", k.kind, "tally", "--owner", "ada"], { cwd: tmp }).code).toBe(0);
        if (k.kind === "view") installViewDeps(dir);

        const clean = hive(["plugins", "check", dir, "--json"], { cwd: tmp });
        expect([clean.code, (clean.json as Report).data]).toEqual([0, expect.objectContaining({ steps: { types: "ok", manifest: "ok", draw: "ok" }, problems: [] })]);

        const file = path.join(dir, k.file);
        const text = fs.readFileSync(file, "utf8");
        expect(text).toContain(k.at);
        const broken = text.replace(k.at, k.insert + k.at);
        fs.writeFileSync(file, broken);
        const line = broken.split("\n").findIndex((l) => l.includes("boom while drawing")) + 1;

        const r = hive(["plugins", "check", dir, "--json"], { cwd: tmp });
        expect(r.code).toBe(1);
        const report = r.json as Report;
        expect(report.ok).toBe(false);
        expect(report.data.steps.draw).toBe("failed");
        expect(report.data.problems.filter((p) => p.step === "draw")).toEqual([
          expect.objectContaining({ file: k.file, line, message: expect.stringContaining("boom while drawing") }),
        ]);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }, 120_000);
  }

  test("a widget's code reaches nothing of this machine: no process, no Bun, no import", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-check-escape-"));
    const dir = path.join(tmp, "tally");
    const mark = path.join(tmp, "escaped");
    try {
      expect(hive(["plugins", "new", "widget", "tally", "--owner", "ada"], { cwd: tmp }).code).toBe(0);
      const ways = ["console.log", "console.error", "setTimeout", "this", "globalThis", "hive.render", "self.postMessage"];
      fs.writeFileSync(path.join(dir, "widget.js"), `const MARK = ${JSON.stringify(mark)};
const out = (p) => { try { const fs = p && p.getBuiltinModule && p.getBuiltinModule("node:fs"); if (fs) fs.writeFileSync(MARK, "escaped"); } catch {} };
for (const way of ${JSON.stringify(ways)}) {
  try { out(Function("w", "return w.constructor.constructor('return typeof process === \\"object\\" ? process : null')()")(eval(way))); } catch {}
}
import("node:fs").then((fs) => fs.writeFileSync(MARK, "escaped"), () => {});
hive.on("start", () => hive.render({ type: "text", text: "here" }));
`);
      const r = hive(["plugins", "check", dir, "--json"], { cwd: tmp });
      expect(fs.existsSync(mark)).toBe(false);
      expect((r.json as Report).data.steps.draw).toBe("ok");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  test("the type check never runs a tsc the plugin's folder holds", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-check-tsc-"));
    const dir = path.join(tmp, "tally");
    const mark = path.join(tmp, "ran");
    try {
      expect(hive(["plugins", "new", "widget", "tally", "--owner", "ada"], { cwd: tmp }).code).toBe(0);
      const bin = path.join(dir, "node_modules", "typescript", "bin");
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(dir, "node_modules", "typescript", "package.json"), JSON.stringify({ name: "typescript", version: "7.0.0", bin: { tsc: "bin/tsc" } }));
      fs.writeFileSync(path.join(bin, "tsc"), `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(mark)}, "ran");\n`, { mode: 0o755 });
      const r = hive(["plugins", "check", dir, "--json"], { cwd: tmp });
      expect(fs.existsSync(mark)).toBe(false);
      expect((r.json as Report).data.steps.types).toBe("ok");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
