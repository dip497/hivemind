/**
 * The Windows behaviour asserted from Linux. Every helper takes an explicit
 * platform for exactly this reason — these are the checks standing in for a
 * Windows box we don't have.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  defaultShellFor,
  hiveBinCandidates,
  ipcPath,
  repairShellSpec,
  upgradeCommand,
} from "../../src/main/platform.js";

test("ipcPath: posix keeps the socket file inside userData", () => {
  assert.equal(ipcPath("/home/u/.config/hivemind", "pty-daemon.sock", "linux"), "/home/u/.config/hivemind/pty-daemon.sock");
});

test("ipcPath: win32 yields a named pipe, not a path", () => {
  const p = ipcPath("C:\\Users\\u\\AppData\\Roaming\\hivemind", "pty-daemon.sock", "win32");
  assert.match(p, /^\\\\\.\\pipe\\hivemind-[0-9a-f]{12}-pty-daemon$/);
  assert.ok(!p.includes(".sock"), "the .sock suffix is meaningless for a pipe");
});

test("ipcPath: win32 name is STABLE across processes but unique per install", () => {
  // The daemon is spawned detached and re-derives this; if it drifted, the app
  // would connect to a pipe nothing is listening on.
  const a1 = ipcPath("C:\\Users\\u\\AppData\\Roaming\\hivemind", "hcp.sock", "win32");
  const a2 = ipcPath("C:\\Users\\u\\AppData\\Roaming\\hivemind", "hcp.sock", "win32");
  const b = ipcPath("C:\\Users\\other\\AppData\\Roaming\\hivemind", "hcp.sock", "win32");
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
});

test("ipcPath: distinct endpoints never collide", () => {
  const dir = "C:\\Users\\u\\AppData\\Roaming\\hivemind";
  const names = ["pty-daemon.sock", "hcp.sock", "plan-bridge.sock"].map((n) => ipcPath(dir, n, "win32"));
  assert.equal(new Set(names).size, 3);
});

test("defaultShellFor: powershell on windows, bash elsewhere", () => {
  assert.deepEqual(defaultShellFor("win32"), { cmd: "powershell.exe", args: ["-NoLogo"] });
  assert.deepEqual(defaultShellFor("linux"), { cmd: "/bin/bash", args: ["-il"] });
});

test("repairShellSpec: a canvas written on Linux still opens on Windows", () => {
  assert.deepEqual(repairShellSpec({ cmd: "/bin/bash", args: ["-il"] }, "win32"), { cmd: "powershell.exe", args: ["-NoLogo"] });
});

test("repairShellSpec: leaves a deliberate windows choice alone", () => {
  const spec = { cmd: "cmd.exe", args: ["/k"] };
  assert.deepEqual(repairShellSpec(spec, "win32"), spec);
  const agent = { cmd: "claude", args: ["--resume"] };
  assert.deepEqual(repairShellSpec(agent, "win32"), agent);
});

test("repairShellSpec: never rewrites anything on posix", () => {
  const spec = { cmd: "/bin/zsh", args: ["-il"] };
  assert.deepEqual(repairShellSpec(spec, "linux"), spec);
});

test("hiveBinCandidates: follows what each installer actually writes", () => {
  assert.deepEqual(hiveBinCandidates("/home/u", {}, "linux"), ["/home/u/.local/bin/hive", "/home/u/.hivemind-app/hive"]);
  const win = hiveBinCandidates("C:\\Users\\u", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32");
  assert.equal(win[0], path.join("C:\\Users\\u\\AppData\\Local", "hivemind", "bin", "hive.exe"));
});

test("hiveBinCandidates: survives a missing LOCALAPPDATA", () => {
  const win = hiveBinCandidates("C:\\Users\\u", {}, "win32");
  assert.ok(win[0].endsWith(path.join("AppData", "Local", "hivemind", "bin", "hive.exe")));
});

test("upgradeCommand: powershell on windows, bash elsewhere", () => {
  const win = upgradeCommand("dip497/hivemind", "win32");
  assert.equal(win.file, "powershell.exe");
  assert.ok(win.args.at(-1)?.includes("install.ps1"));
  const nix = upgradeCommand("dip497/hivemind", "linux");
  assert.equal(nix.file, "bash");
  assert.ok(nix.args.at(-1)?.includes("install.sh"));
});
