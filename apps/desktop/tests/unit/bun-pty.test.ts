// The adapter only runs under bun, so the harness runs in a real bun process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_BUN } from "../../src/main/bun-pty.ts";

const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "bun-pty-harness.ts");
const ver = spawnSync("bun", ["--version"], { encoding: "utf8" });
const v = ver.status === 0 ? ver.stdout.trim() : "";
const atLeast = (a: string, b: string) => {
  const [x, y] = [a, b].map((s) => s.split(".").map((n) => parseInt(n, 10)));
  for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return x![i]! > y![i]!;
  return true;
};
const skip = process.platform === "win32" ? "unix only" : !v ? "bun not installed" : !atLeast(v, MIN_BUN) ? `bun ${v} < ${MIN_BUN}` : false;

test("bun-pty: input, size, resize, utf8, pause/resume, exit ordering", { skip, timeout: 60_000 }, () => {
  const r = spawnSync("bun", [HARNESS], { encoding: "utf8", timeout: 55_000 });
  const line = r.stdout.trim().split("\n").pop() ?? "";
  let got: Record<string, unknown>;
  try { got = JSON.parse(line); } catch { assert.fail(`harness output not JSON:\n${r.stdout}\n${r.stderr}`); }
  assert.deepEqual(got, {
    pid: true, input: true, size: true, pwd: true, resize: true, utf8: true,
    pausedHeld: true, resumed: true, exitCode: 7, tailBeforeExit: true,
  });
});
