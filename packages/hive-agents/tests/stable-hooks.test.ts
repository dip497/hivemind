// Codex runs a hook only once its user has trusted that exact command. Its commands are the same
// whichever install or build of the app starts it, so it asks once: the paths are in the agent's
// environment, and only there.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { hookPathsFor } from "../src/node.js";
import { defFromManifest } from "../src/manifest.js";
import { manifestRuntime } from "../src/runtime-manifest.js";
import type { RuntimePaths } from "../src/runtime.js";
import { AUTHORED, authoredYaml } from "./authored.js";

const codex = defFromManifest(YAML.parse(authoredYaml(AUTHORED.find((a) => a.id === "codex")!)));

/** One app's paths: its own binary, config folder and sockets. */
function paths(root: string, execPath: string): RuntimePaths {
  const ctx = { tileSessionsDir: `${root}/tile-sessions`, trackerPath: `${root}/t.cjs`, hcpSock: `${root}/hcp.sock`, execPath, eventHookPath: `${root}/e.cjs` } as Parameters<typeof hookPathsFor>[1];
  return { private: `${root}/agents/codex`, execPath, tileSessionsDir: ctx.tileSessionsDir, home: "/home/u", hooks: hookPathsFor(codex, ctx), hcpSock: ctx.hcpSock, hcpToken: () => "t" };
}
const launch = (p: RuntimePaths, tileId: string) =>
  manifestRuntime(codex, () => undefined)!.launch!({ tileId, cwd: "/w", args: [], env: {}, phase: "spawn", platform: "linux", paths: p });

test("codex's hooks read the same from every install and build, and name none of their paths", () => {
  const installed = launch(paths("/home/u/.config/hivemind", "/home/u/.hivemind-app/hivemind"), "hm:a");
  const dev = launch(paths("/home/u/.config/hivemind-dev", "/src/node_modules/electron/dist/electron"), "hm:b");
  const doc = (plan: typeof installed) => plan.argsBefore![plan.argsBefore!.indexOf("-c") + 1]!;
  expect(doc(installed)).toBe(doc(dev));
  expect(doc(installed)).not.toContain("/home/u");
  expect(doc(installed)).toContain("$HIVEMIND_HOOK_EVENT");
  // Each app says where its own are, at launch.
  expect(installed.env).toMatchObject({ HIVEMIND_HOOK_EXEC: "/home/u/.hivemind-app/hivemind", HIVEMIND_HOOK_EVENT: "/home/u/.config/hivemind/e.cjs", HIVEMIND_HOOK_EVENT_ARG: "/home/u/.config/hivemind/hcp.sock" });
  expect(dev.env).toMatchObject({ HIVEMIND_HOOK_EXEC: "/src/node_modules/electron/dist/electron", HIVEMIND_HOOK_EVENT: "/home/u/.config/hivemind-dev/e.cjs" });
});

test("run through a shell with the environment its launch gave it, a hook command runs that app's script with its argument", () => {
  const root = mkdtempSync(join(tmpdir(), "hm-stable-hook-"));
  const out = join(root, "ran.json");
  writeFileSync(join(root, "e.cjs"), `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ arg: process.argv[2], event: process.env.HIVE_EVENT }));`);
  const plan = launch(paths(root, process.execPath), "hm:a");
  // The first command in the document (session.started), as codex reads it: a TOML string.
  const command = JSON.parse(/command=("(?:[^"\\]|\\.)*")/.exec(plan.argsBefore![1]!)![1]!) as string;
  execFileSync("/bin/sh", ["-lc", command], { env: { PATH: process.env.PATH!, ...plan.env } });
  const ran = JSON.parse(readFileSync(out, "utf8")) as { arg: string; event: string };
  expect(ran.arg).toBe(join(root, "hcp.sock"));
  expect(ran.event).toBeTruthy();
});
