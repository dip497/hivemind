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
  const deps = { esbuild: path.join(REPO, "node_modules/esbuild"), typescript: path.join(REPO, "apps/cli/node_modules/typescript") };
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
});
