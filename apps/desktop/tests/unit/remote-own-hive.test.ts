import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

// A machine reached through an `ssh` on PATH that runs the command here, in a home of its own
// (`rhome`), where `curl` hands out a stand-in `hive`. That `hive` runs a terminal server per
// HIVEMIND_APP_DATA folder and writes down every message it is sent in that folder's `seen`.
const VERSION = "9999.1.0";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-own-remote-"));
const bin = path.join(root, "bin");
const remoteBin = path.join(root, "remote-bin");
const rhome = path.join(root, "rhome");
const work = path.join(root, "work");
for (const d of [bin, remoteBin, rhome, work, path.join(root, "userData")]) fs.mkdirSync(d, { recursive: true });
const standIn = path.join(root, "hive");
fs.writeFileSync(standIn, `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2).join(" ");
if (a === "--version") { console.log("${VERSION}"); process.exit(0); }
if (a === "daemon --help") { console.log("bridge  connect to the terminal daemon"); process.exit(0); }
if (a !== "daemon bridge") process.exit(2);
const dir = process.env.HIVEMIND_APP_DATA;
fs.mkdirSync(dir, { recursive: true });
let protocol = 1;
try { protocol = Number(fs.readFileSync(path.join(dir, "protocol"), "utf8")); } catch {}
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stdout.write("HIVE-BRIDGE-READY\\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\\n")) >= 0; buf = buf.slice(i + 1)) {
    const m = JSON.parse(buf.slice(0, i));
    fs.appendFileSync(path.join(dir, "seen"), m.t + " " + (m.id ?? "") + "\\n");
    if (m.t === "ping") send({ t: "pong", reqId: m.reqId, ...(protocol ? { protocol } : {}) });
    if (m.t === "attach") send({ t: "attached", reqId: m.reqId, id: m.id, pid: 4242, isNew: true, replay: "" });
    if (m.t === "list") send({ t: "sessions", reqId: m.reqId, ids: [], detail: [] });
    if (m.t === "shutdown") process.exit(0);
  }
});
process.stdin.on("end", () => process.exit(0));
`, { mode: 0o755 });
fs.writeFileSync(path.join(remoteBin, "curl"), `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done\ncp ${standIn} "$out"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\nfor a; do last=$a; done\nHOME=${rhome} PATH=${remoteBin}:${path.dirname(process.execPath)}:/usr/bin:/bin exec sh -c "$last"\n`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
// Nothing found here may be copied there: the machine downloads its own.
process.env.HIVE_BIN = "";
process.env.HIVE_TEST_USER_DATA = path.join(root, "userData");
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
  if (s === "electron") return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent("export const app = { getPath: () => process.env.HIVE_TEST_USER_DATA, getVersion: () => '${VERSION}' };") };
  return next(s, c);
}`)}`);

const people = path.join(rhome, ".hivemind", "people");
const seen = (folder: string) => { try { return fs.readFileSync(path.join(people, folder, "seen"), "utf8"); } catch { return ""; } };

test("a colleague on the same login keeps their own terminal server, even one an older app started; this person's runs this app's own hive, put there for it", async () => {
  // The app's ssh children never hold the event loop open; here nothing else would.
  const awake = setInterval(() => {}, 1000);
  try {
    // A colleague's server, started by an older app: a newer one would replace it if it were shared.
    const colleague = "c0ffee0000000000";
    fs.mkdirSync(path.join(people, colleague), { recursive: true });
    fs.writeFileSync(path.join(people, colleague, "protocol"), "0");
    const { spawnRemotePty, killRemotePty } = await import("../../src/main/remote/pty.ts");
    const { hivePerson } = await import("../../src/main/remote/hive-there.ts");
    const { parseRemote } = await import("@hivemind/core/remote-uri");
    const { pid } = await spawnRemotePty(
      { tileId: "hm:agent", cwd: `ssh://shared-login${work}`, cmd: "claude", cols: 80, rows: 24 },
      parseRemote(`ssh://shared-login${work}`),
      { onData: () => {}, onExit: () => {} },
    );
    assert.equal(pid, -4242, "the terminal did not start in a terminal server of this app's");
    const mine = hivePerson();
    assert.notEqual(mine, colleague);
    assert.match(seen(mine), /^attach hm:agent$/m);
    assert.equal(seen(colleague), "", "the colleague's server was spoken to");
    const there = path.join(rhome, ".hivemind", "bin", VERSION, "hive");
    assert.equal(fs.readFileSync(there, "utf8"), fs.readFileSync(standIn, "utf8"), "this app's version was not put there");
    killRemotePty("hm:agent");
  } finally {
    clearInterval(awake);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
