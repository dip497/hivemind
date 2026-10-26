import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hiveThere, installCopyCommand, parseProbe, personFolder, probeScript } from "./ssh.js";

// Each remote command runs here through a real `sh`, in a home of its own, as ssh would run it there.
let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "hive-there-")); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

// The login names one socket for everyone, as a shared account's profile might.
const there = (cmd: string, input?: Buffer | string) =>
  spawnSync("sh", ["-c", cmd], { env: { PATH: "/usr/bin:/bin", HOME: home, HIVEMIND_PTY_SOCK: "/tmp/everyone.sock" }, input, encoding: "utf8" });

/** A `hive` of `version` that answers the probe and prints its person's folder. */
const fakeHive = (version: string) => Buffer.from(`#!/bin/sh
case "$1" in --version) echo ${version} ;; daemon) echo "bridge  connect to the terminal daemon" ;; *) echo "data=$HIVEMIND_APP_DATA$HIVEMIND_PTY_SOCK" ;; esac
`);

const bin = (v: string) => path.join(home, ".hivemind", "bin", v);
const install = (v: string, body: Buffer) => {
  const r = there(installCopyCommand(v, body.length), body);
  expect(r.status).toBe(0);
  return r.stdout.trim();
};

test("a version is put in a folder of its own, where the probe finds it ready", () => {
  expect(parseProbe(there(probeScript("2026.10.6")).stdout).daemon).toBeUndefined();
  const at = install("2026.10.6", fakeHive("2026.10.6"));
  expect(at).toBe(path.join(bin("2026.10.6"), "hive"));
  const found = parseProbe(there(probeScript("2026.10.6")).stdout);
  expect(found).toMatchObject({ hivePath: at, hiveVersion: "2026.10.6", daemon: true });
  // Another version there is not this app's.
  expect(parseProbe(there(probeScript("2026.10.7")).stdout).daemon).toBeUndefined();
});

test("a copy cut short is not put in place", () => {
  const body = fakeHive("2026.10.6");
  const r = there(installCopyCommand("2026.10.6", body.length + 10), body);
  expect(r.status).not.toBe(0);
  expect(fs.existsSync(path.join(bin("2026.10.6"), "hive"))).toBe(false);
});

test("people who share a login each get their own folder", () => {
  install("2026.10.6", fakeHive("2026.10.6"));
  const alice = personFolder("a".repeat(64));
  const bob = personFolder("b".repeat(64));
  expect(there(hiveThere("2026.10.6", alice, ["ps"])).stdout.trim()).toBe(`data=${home}/.hivemind/people/${alice}`);
  expect(there(hiveThere("2026.10.6", bob, ["ps"])).stdout.trim()).toBe(`data=${home}/.hivemind/people/${bob}`);
});

test("installing a version removes old copies, but the newest two and one still running", async () => {
  const old = ["2026.9.0", "2026.9.1", "2026.9.2", "2026.9.3"];
  for (const [i, v] of old.entries()) {
    fs.mkdirSync(bin(v), { recursive: true });
    fs.writeFileSync(path.join(bin(v), "hive"), fakeHive(v), { mode: 0o755 });
    const t = new Date(Date.now() - (10 - i) * 60_000);
    fs.utimesSync(bin(v), t, t);
  }
  // The oldest still runs a process: its binary is a real program, not a script.
  fs.copyFileSync("/bin/sleep", path.join(bin("2026.9.0"), "hive"));
  const running = spawn(path.join(bin("2026.9.0"), "hive"), ["30"], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 200));
    install("2026.10.6", fakeHive("2026.10.6"));
    const kept = fs.readdirSync(path.join(home, ".hivemind", "bin")).sort();
    expect(kept).toEqual(["2026.10.6", "2026.9.0", "2026.9.2", "2026.9.3"]);
  } finally {
    running.kill();
  }
});

test("a version or person that could break out of the shell is refused", () => {
  expect(() => hiveThere("1.0; rm -rf ~", personFolder("a".repeat(64)), [])).toThrow();
  expect(() => hiveThere("1.0", "../../etc", [])).toThrow();
  expect(() => probeScript("$(id)")).toThrow();
  expect(() => installCopyCommand("1 2", 3)).toThrow();
});
