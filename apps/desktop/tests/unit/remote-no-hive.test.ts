import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

// A machine reached through an `ssh` on PATH that runs the command here, in a home with no `hive`.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-no-hive-remote-"));
const bin = path.join(root, "bin");
const home = path.join(root, "home");
const work = path.join(root, "work");
for (const d of [bin, home, work, path.join(root, "userData")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\nfor a; do last=$a; done\nHOME=${home} PATH=/usr/bin:/bin exec sh -c "$last"\n`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.HIVE_TEST_USER_DATA = path.join(root, "userData");
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
  if (s === "electron") return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent("export const app = { getPath: () => process.env.HIVE_TEST_USER_DATA };") };
  return next(s, c);
}`)}`);

test("the first terminal on a machine with no hive runs over plain ssh, not reported as a session that is missing", async () => {
  const awake = setInterval(() => {}, 1000);
  try {
    const { spawnRemotePty, killRemotePty } = await import("../../src/main/remote/pty.ts");
    const { parseRemote } = await import("@hivemind/core/remote-uri");
    const started = path.join(work, "started");
    const target = parseRemote(`ssh://no-hive-host${work}`);
    const { pid } = await spawnRemotePty(
      { tileId: "hm:first-shell", cwd: `ssh://no-hive-host${work}`, cmd: "sh", args: ["-c", `touch ${started}; sleep 30`], cols: 80, rows: 24 },
      target,
      { onData: () => {}, onExit: () => {} },
    );
    // -1 is how a spawn says "no such session": the tile then shows it as not running.
    assert.notEqual(pid, -1);
    for (let i = 0; i < 50 && !fs.existsSync(started); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(fs.existsSync(started), true, "the shell did not start over plain ssh");
    killRemotePty("hm:first-shell");
  } finally {
    clearInterval(awake);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
