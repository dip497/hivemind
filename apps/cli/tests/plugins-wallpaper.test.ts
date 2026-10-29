// `hive plugins new wallpaper` and `hive plugins check` of a live wallpaper. The starter is a package
// of its own that offers it, which the check accepts once built; `--in` makes it one more member of
// a package. The draw check loads a wallpaper's built entry in headless Chromium against a host
// that checks what it sends as the app does, and refuses one that never connects or says what the
// app does not take.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { hive } from "./helpers.js";

const REPO = path.join(import.meta.dir, "../../..");
const SKILLS = [".claude/skills/hivemind-live-wallpaper/SKILL.md", ".claude/skills/ascii-character-animation/SKILL.md"];

/** Whether this computer has what the draw check draws in: Playwright where Node finds it, with its
 *  Chromium. Without it the draw is not run (its step says so), so the tests of it cannot run. */
function hasChromium(): boolean {
  const at = (process.env.NODE_PATH ?? "").split(path.delimiter).filter(Boolean).map((root) => path.join(root, "playwright")).find((p) => fs.existsSync(path.join(p, "package.json")));
  try {
    const pw = createRequire(import.meta.url)(at ?? "playwright") as { chromium: { executablePath(): string } };
    return fs.existsSync(pw.chromium.executablePath());
  } catch { return false; }
}
const drawable = hasChromium();

let tmp: string;
let run: (...args: string[]) => ReturnType<typeof hive>;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-wallpaper-"));
  // No app: a test run inside a Hivemind tile would otherwise reach the live one.
  const env = { XDG_CONFIG_HOME: path.join(tmp, "config"), HIVE_SETTINGS: undefined, HIVE_HCP_SOCK: path.join(tmp, "no-app.sock"), HIVE_DRIVE_SOCK: path.join(tmp, "no-drive.sock") };
  run = (...args: string[]) => hive(["plugins", ...args], { cwd: tmp, env });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const read = (rel: string) => fs.readFileSync(path.join(tmp, rel), "utf8");

/** What `npm install` and `npm run build` do in a starter's folder, with this checkout's esbuild. */
function build(dir: string) {
  if (!fs.existsSync(path.join(dir, "node_modules"))) {
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.symlinkSync(fs.realpathSync(path.join(REPO, "node_modules/esbuild")), path.join(dir, "node_modules", "esbuild"));
  }
  const r = spawnSync("node", ["build.mjs"], { cwd: dir, encoding: "utf8" });
  expect([r.status, r.stderr]).toEqual([0, ""]);
}

/** A package `@ada/kit` holding one wallpaper, `tide`, whose code is `main.js` as written. */
function handWritten(main: string) {
  const files: Record<string, string> = {
    "kit/hivemind-package.json": JSON.stringify({ apiVersion: 2, id: "@ada/kit", name: "Kit", version: "0.1.0", wallpapers: [{ path: "wallpapers/tide" }] }),
    "kit/wallpapers/tide/hivemind-wallpaper.json": JSON.stringify({ protocol: 2, name: "Tide", entry: "main.js" }),
    "kit/wallpapers/tide/main.js": main,
  };
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
    fs.writeFileSync(path.join(tmp, f), text);
  }
}

interface Problem { step: string; file?: string; line?: number; message: string; member?: string }
interface Report { steps: Record<string, string>; members: Array<{ path: string; id: string | null; steps: Record<string, string> | null }>; problems: Problem[] }

describe("hive plugins new wallpaper", () => {
  test.skipIf(!drawable)("starts a package of its own that offers it, which check accepts once built; a throw while it draws is placed at its line", () => {
    const r = run("new", "wallpaper", "pond", "--owner", "ada");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("A live wallpaper is never installed alone: it ships in a package");
    expect(JSON.parse(read("pond/hivemind-package.json"))).toMatchObject({ id: "@ada/pond", wallpapers: [{ path: "wallpapers/pond" }], startup: { wallpaper: "@ada/pond/pond" } });
    // For the person's coding agent, at the package's root: the brief and this repository's own skills.
    const prompt = read("pond/PROMPT.md");
    for (const line of ["npm --prefix wallpapers/pond install ", "npm --prefix wallpapers/pond run build ", "hive plugins check . ", "hive plugins install . ", "hive config set appearance.wallpaper.kind '\"@ada/pond/pond\"' "]) {
      expect(prompt).toContain(`\n${line}`);
    }
    expect(prompt.match(/<\/?[A-Z][A-Za-z]*[\s>/]/g)).toBeNull();
    for (const skill of SKILLS) expect(read(`pond/${skill}`)).toBe(fs.readFileSync(path.join(REPO, skill), "utf8"));

    const dir = path.join(tmp, "pond", "wallpapers", "pond");
    build(dir);
    const clean = run("check", "pond", "--json");
    expect([clean.code, (clean.json as Report).problems, (clean.json as Report).steps]).toEqual([0, [], { manifest: "ok", "wallpaper wallpapers/pond": "ok", hub: "ok" }]);
    expect((clean.json as Report).members).toEqual([{ kind: "wallpaper", path: "wallpapers/pond", id: "@ada/pond/pond", steps: { types: "ok", manifest: "ok", draw: "ok" } }]);

    const main = path.join(dir, "src", "main.ts");
    const at = "  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);";
    const text = fs.readFileSync(main, "utf8");
    expect(text).toContain(at);
    const broken = text.replace(at, "  throw new Error(\"boom while drawing\");\n" + at);
    fs.writeFileSync(main, broken);
    build(dir);
    const thrown = run("check", "pond", "--json");
    expect(thrown.code).toBe(1);
    expect((thrown.json as Report).problems.filter((p) => p.step === "draw")[0]).toEqual(expect.objectContaining({
      file: "wallpapers/pond/src/main.ts", line: broken.split("\n").findIndex((l) => l.includes("boom while drawing")) + 1, member: "wallpapers/pond",
      message: expect.stringContaining("it threw: boom while drawing"),
    }));
  }, 180_000);

  test("--in makes it a member of that package, named in its wallpapers, with its brief in its folder and the skills at the package's root", () => {
    expect(run("new", "package", "kit", "--owner", "ada").code).toBe(0);
    const r = run("new", "wallpaper", "pond", "--in", "kit", "--json");
    expect([r.code, r.json]).toEqual([0, expect.objectContaining({ kind: "wallpaper", id: "@ada/kit/pond", package: "@ada/kit", dir: path.join(tmp, "kit", "wallpapers", "pond") })]);
    const manifest = JSON.parse(read("kit/hivemind-package.json"));
    expect([manifest.wallpapers, manifest.startup]).toEqual([[{ path: "wallpapers/pond" }], undefined]);
    expect(read("kit/wallpapers/pond/PROMPT.md")).toContain("\nhive plugins check ../.. ");
    for (const skill of SKILLS) expect(fs.existsSync(path.join(tmp, "kit", skill))).toBe(true);
    // Read as an install reads it: not built yet, it is named at the line naming it.
    const check = run("check", "kit", "--json");
    expect([check.code, (check.json as Report).problems]).toEqual([1, [expect.objectContaining({
      step: "manifest", member: "wallpapers/pond", message: expect.stringContaining("its entry, dist/main.js, is not a file in its folder: build it first"),
    })]]);
  }, 120_000);
});

describe.skipIf(!drawable)("hive plugins check, a live wallpaper's draw", () => {
  test("a wallpaper whose page never takes the app's port is refused: it did not connect", () => {
    handWritten("document.body.textContent = \"no port taken\";\n");
    const r = run("check", "kit", "--json");
    expect([r.code, (r.json as Report).problems]).toEqual([1, [expect.objectContaining({
      step: "draw", member: "wallpapers/tide", message: "it did not connect within 3 s: call connectWallpaper() as its page loads",
    })]]);
  }, 60_000);

  test("a wallpaper that says more than ready and drawn is refused, as the app refuses it", () => {
    handWritten(`addEventListener("message", (e) => {
  const port = e.ports[0];
  if (!port) return;
  port.onmessage = (m) => {
    if (m.data.type === "hello") port.postMessage({ type: "drawn" });
    if (m.data.type === "pointer" && m.data.over) port.postMessage({ type: "hover", id: "ghost" });
  };
  port.postMessage({ type: "ready", protocol: 2 });
});
`);
    const r = run("check", "kit", "--json");
    expect([r.code, (r.json as Report).problems]).toEqual([1, [expect.objectContaining({
      step: "draw", member: "wallpapers/tide", message: "the app would refuse what it sent: unknown message type \"hover\"",
    })]]);
  }, 60_000);
});
