import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

// A machine reached through an `ssh` on PATH that runs the command here, in a home whose `hive`
// runs an older daemon: it answers ping without a protocol and its status names none it speaks.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-older-remote-"));
const bin = path.join(root, "bin");
const home = path.join(root, "home");
const work = path.join(root, "work");
for (const d of [bin, path.join(home, ".local", "bin"), work, path.join(root, "userData")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\nfor a; do last=$a; done\nHOME=${home} exec sh -c "$last"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(home, ".local", "bin", "hive"), `#!/usr/bin/env node
const a = process.argv.slice(2).join(" ");
if (a === "--version") console.log("2026.1.0");
else if (a === "daemon --help") console.log("bridge  connect to the terminal daemon");
else if (a === "daemon status --json") console.log(JSON.stringify({ data: { running: true } }));
else if (a === "daemon bridge") {
  process.stdout.write("HIVE-BRIDGE-READY\\n");
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.t === "ping") process.stdout.write(JSON.stringify({ t: "pong", reqId: m.reqId }) + "\\n");
    }
  });
}
`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.HIVE_TEST_USER_DATA = path.join(root, "userData");
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
  if (s === "electron") return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent("export const app = { getPath: () => process.env.HIVE_TEST_USER_DATA };") };
  return next(s, c);
}`)}`);

test("a machine whose hive is older than this app fails the terminal with how to update it, and starts nothing over plain ssh", async () => {
  // The app's ssh children never hold the event loop open; here nothing else would.
  const awake = setInterval(() => {}, 1000);
  try {
    const { spawnRemotePty } = await import("../../src/main/remote/pty.ts");
    const { parseRemote } = await import("@hivemind/core/remote-uri");
    const started = path.join(work, "started");
    const opening = spawnRemotePty(
      { tileId: "hm:restored-agent", cwd: `ssh://older-hive-host${work}`, cmd: "touch", args: [started], cols: 80, rows: 24 },
      parseRemote(`ssh://older-hive-host${work}`),
      { onData: () => {}, onExit: () => {} },
    );
    await assert.rejects(opening, /older than this app: press Update hive in Machines/);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(fs.existsSync(started), false, "the agent was started again over plain ssh");
  } finally {
    clearInterval(awake);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
