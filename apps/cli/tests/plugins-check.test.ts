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

interface Report { steps: Record<string, string>; problems: { step: string; file?: string; line?: number; message: string }[] }

describe("hive plugins check", () => {
  for (const k of KINDS) {
    test(`${k.kind}: a starter passes; a throw while it draws is a draw problem at its file and line`, () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `hive-check-${k.kind}-`));
      const dir = path.join(tmp, "tally");
      try {
        expect(hive(["plugins", "new", k.kind, "tally", "--owner", "ada"], { cwd: tmp }).code).toBe(0);
        if (k.kind === "view") installViewDeps(dir);

        const clean = hive(["plugins", "check", dir, "--json"], { cwd: tmp });
        expect([clean.code, (clean.json as Report)]).toEqual([0, expect.objectContaining({ steps: { types: "ok", manifest: "ok", draw: "ok" }, problems: [] })]);

        const file = path.join(dir, k.file);
        const text = fs.readFileSync(file, "utf8");
        expect(text).toContain(k.at);
        const broken = text.replace(k.at, k.insert + k.at);
        fs.writeFileSync(file, broken);
        const line = broken.split("\n").findIndex((l) => l.includes("boom while drawing")) + 1;

        const r = hive(["plugins", "check", dir, "--json"], { cwd: tmp });
        expect(r.code).toBe(1);
        const report = r.json as Report;
        expect(report.steps.draw).toBe("failed");
        expect(report.problems.filter((p) => p.step === "draw")).toEqual([
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
      expect((r.json as Report).steps.draw).toBe("ok");
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
      expect((r.json as Report).steps.types).toBe("ok");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  test("a tool's code runs in its own folder, seeing none of the environment but PATH and HOME", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-check-env-"));
    const dir = path.join(tmp, "tally");
    try {
      expect(hive(["plugins", "new", "tool", "tally", "--owner", "ada"], { cwd: tmp }).code).toBe(0);
      const entry = path.join(dir, "index.js");
      fs.writeFileSync(entry, `process.getBuiltinModule("node:fs").writeFileSync(new URL("./seen.json", import.meta.url), JSON.stringify({ env: process.env, cwd: process.cwd() }));\n` + fs.readFileSync(entry, "utf8"));
      const r = hive(["plugins", "check", dir, "--json"], { cwd: tmp, env: { HIVE_CHECK_SECRET: "s3cret" } });
      expect((r.json as Report).steps.draw).toBe("ok");
      const seen = JSON.parse(fs.readFileSync(path.join(dir, "seen.json"), "utf8")) as { env: Record<string, string>; cwd: string };
      expect(seen.env.HIVE_CHECK_SECRET).toBeUndefined();
      expect([seen.env.PATH, seen.env.HOME]).toEqual([process.env.PATH, process.env.HOME]);
      expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(dir));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);


  test("no tsconfig of the plugin's is read: hostile ones write nothing outside its folder and change nothing in it", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-check-config-"));
    const dir = path.join(tmp, "tally");
    const outside = path.join(tmp, "outside");
    const writes = { generateTrace: path.join(outside, "trace"), outDir: path.join(outside, "out"), declarationDir: path.join(outside, "decl"), tsBuildInfoFile: path.join(outside, "info"), noEmit: false, declaration: true, incremental: true };
    const snapshot = (d: string): Record<string, string> => Object.fromEntries((fs.readdirSync(d, { recursive: true }) as string[]).sort().map((f) => {
      const at = path.join(d, f);
      return [f, fs.lstatSync(at).isSymbolicLink() ? `-> ${fs.readlinkSync(at)}` : fs.statSync(at).isFile() ? fs.readFileSync(at, "utf8") : "dir"];
    }));
    const hostile: Array<[string, () => void]> = [
      ["extends a package", () => {
        fs.mkdirSync(path.join(dir, "node_modules", "evil"), { recursive: true });
        fs.writeFileSync(path.join(dir, "node_modules", "evil", "tsconfig.json"), JSON.stringify({ compilerOptions: writes }));
        fs.writeFileSync(path.join(dir, "jsconfig.json"), JSON.stringify({ extends: "evil/tsconfig.json", include: ["*.js"] }));
      }],
      ["generateTrace, outDir and declarationDir outside", () => {
        fs.writeFileSync(path.join(dir, "jsconfig.json"), JSON.stringify({ compilerOptions: { allowJs: true, checkJs: true, ...writes }, include: ["*.js"] }));
      }],
      ["its root config a link to one outside", () => {
        fs.writeFileSync(path.join(tmp, "evil.json"), JSON.stringify({ compilerOptions: { allowJs: true, checkJs: true, ...writes }, include: [path.join(dir, "*.js")] }));
        fs.symlinkSync(path.join(tmp, "evil.json"), path.join(dir, "jsconfig.json"));
      }],
    ];
    try {
      expect(hive(["plugins", "new", "widget", "tally", "--owner", "ada"], { cwd: tmp }).code).toBe(0);
      for (const [how, make] of hostile) {
        fs.rmSync(path.join(dir, "jsconfig.json"), { force: true });
        make();
        const before = snapshot(dir);
        const r = hive(["plugins", "check", dir, "--json"], { cwd: tmp });
        expect([how, fs.existsSync(outside) ? fs.readdirSync(outside) : []]).toEqual([how, []]);
        expect([how, snapshot(dir)]).toEqual([how, before]);
        expect([how, (r.json as Report).steps.types]).toEqual([how, "ok"]);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 180_000);

  test("a code file that is a link to outside the plugin's folder is refused", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-check-link-"));
    const dir = path.join(tmp, "tally");
    try {
      expect(hive(["plugins", "new", "widget", "tally", "--owner", "ada"], { cwd: tmp }).code).toBe(0);
      fs.writeFileSync(path.join(tmp, "elsewhere.js"), "const x = 1;\n");
      fs.symlinkSync(path.join(tmp, "elsewhere.js"), path.join(dir, "extra.js"));
      const r = hive(["plugins", "check", dir, "--json"], { cwd: tmp });
      expect(r.code).toBe(1);
      expect((r.json as Report).problems).toContainEqual(expect.objectContaining({ step: "types", file: "extra.js", message: expect.stringContaining("outside the plugin's folder") }));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  test("a misspelt host.runn in a tool is a types problem at its line", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-check-runn-"));
    const dir = path.join(tmp, "tally");
    try {
      expect(hive(["plugins", "new", "tool", "tally", "--owner", "ada"], { cwd: tmp }).code).toBe(0);
      const entry = path.join(dir, "index.js");
      const text = fs.readFileSync(entry, "utf8").replace("host.run(", "host.runn(");
      fs.writeFileSync(entry, text);
      const r = hive(["plugins", "check", dir, "--json"], { cwd: tmp });
      expect((r.json as Report).problems).toEqual(expect.arrayContaining([
        expect.objectContaining({ file: "index.js", line: text.split("\n").findIndex((l) => l.includes("host.runn(")) + 1, message: expect.stringContaining("Property 'runn' does not exist on type 'TileHost'") }),
      ]));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  // A tool's service is a program the app runs on its own (often a bundle built and checked where
  // its source is): its code isn't checked against the tile SDK, and a starter's tile still is.
  test("a tool's service program is not type-checked as tile code; its tile still is", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-check-service-"));
    const dir = path.join(tmp, "tally");
    try {
      expect(hive(["plugins", "new", "tool", "tally", "--owner", "ada"], { cwd: tmp }).code).toBe(0);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "hivemind-tool.json"), "utf8"));
      fs.writeFileSync(path.join(dir, "hivemind-tool.json"), JSON.stringify({ ...manifest, service: { command: ["node", "service.mjs"], role: "view" } }));
      fs.writeFileSync(path.join(dir, "service.mjs"), "export const total = (a, b) => a.nope + b;\n");
      const clean = hive(["plugins", "check", dir, "--json"], { cwd: tmp });
      expect(((clean.json as Report).problems).filter((p) => p.file === "service.mjs")).toEqual([]);
      fs.writeFileSync(path.join(dir, "extra.mjs"), "export const total = (a, b) => a.nope + b;\n");
      const r = hive(["plugins", "check", dir, "--json"], { cwd: tmp });
      expect((r.json as Report).problems).toContainEqual(expect.objectContaining({ step: "types", file: "extra.mjs" }));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
