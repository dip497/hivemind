/**
 * The `hive` CLI's Windows endpoint derivation, asserted from any host: the
 * app's userData is re-derived from a mocked APPDATA and must hash to the same
 * named pipes the packaged app listens on (ipcPath comes from hive-core, the
 * one implementation both sides import).
 */
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ipcPath } from "@hivemind/core";
import { sockPath } from "../src/hcp.js";
import { win32UserDataDir } from "@hivemind/core/app-data";
import { defaultToken, driveSocketPath } from "hivemind-api";
import { defaultSocket } from "../src/pty-client.js";

const APPDATA = "C:\\Users\\u\\AppData\\Roaming";
const USER_DATA = path.join(APPDATA, "hivemind");

describe("win32 endpoints", () => {
  test("userData re-derivation follows Electron's %APPDATA%\\hivemind, read case-insensitively", () => {
    expect(win32UserDataDir({ APPDATA })).toBe(USER_DATA);
    expect(win32UserDataDir({ AppData: APPDATA })).toBe(USER_DATA); // casing of the env key varies
    expect(win32UserDataDir({})).toBeNull();
  });

  test("the hcp endpoint is the app's named pipe, stable across calls", () => {
    const a = sockPath({ platform: "win32", env: { APPDATA } });
    const b = sockPath({ platform: "win32", env: { APPDATA } });
    expect(a).toBe(b);
    expect(a).toBe(ipcPath(USER_DATA, "hcp.sock", "win32"));
    expect(a).toMatch(/^\\\\\.\\pipe\\hivemind-[0-9a-f]{12}-hcp$/);
    // A different install (different APPDATA) must not land on the same pipe.
    expect(sockPath({ platform: "win32", env: { APPDATA: "C:\\Users\\other\\AppData\\Roaming" } })).not.toBe(a);
  });

  test("env overrides win before any platform derivation", () => {
    expect(sockPath({ platform: "win32", env: { APPDATA, HIVE_HCP_SOCK: "\\\\.\\pipe\\agent" } })).toBe("\\\\.\\pipe\\agent");
    expect(defaultSocket({ platform: "win32", env: { APPDATA, HIVEMIND_PTY_SOCK: "\\\\.\\pipe\\pty" } })).toBe("\\\\.\\pipe\\pty");
  });

  test("the pty-daemon endpoint is the app's pipe, NOT a unix socket file", () => {
    const s = defaultSocket({ platform: "win32", env: { APPDATA } });
    expect(s).toBe(ipcPath(USER_DATA, "pty-daemon.sock", "win32"));
    expect(s).toMatch(/^\\\\\.\\pipe\\hivemind-[0-9a-f]{12}-pty-daemon$/);
    expect(s).not.toContain(".sock");
  });

  test("every socket is in the app's data folder, where Electron keeps it: the config folder on Linux, Application Support on a Mac", () => {
    expect(sockPath({ platform: "linux", env: { XDG_CONFIG_HOME: "/cfg" } })).toBe(path.join("/cfg", "hivemind", "hcp.sock"));
    expect(defaultSocket({ platform: "linux", env: {} })).toBe(path.join(os.homedir(), ".config", "hivemind", "pty-daemon.sock"));
    const mac = path.join(os.homedir(), "Library", "Application Support", "hivemind");
    expect([sockPath, defaultSocket, driveSocketPath].map((of) => of({ platform: "darwin", env: { XDG_CONFIG_HOME: "/cfg" } })))
      .toEqual([path.join(mac, "hcp.sock"), path.join(mac, "pty-daemon.sock"), path.join(mac, "drive.sock")]);
    // HIVEMIND_APP_DATA names another, for all of them.
    expect(driveSocketPath({ platform: "linux", env: { HIVEMIND_APP_DATA: "/data" } })).toBe(path.join("/data", "drive.sock"));
  });

  test("the token is read from the win32 userData dir; HCP_TOKEN still wins", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "hive-win32-"));
    const roaming = path.join(home, "AppData", "Roaming");
    const dir = path.join(roaming, "hivemind");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "hcp.token"), " tok-win \n");
    try {
      expect(defaultToken({ platform: "win32", env: { APPDATA: roaming } })).toBe("tok-win");
      expect(defaultToken({ platform: "win32", env: { APPDATA: roaming, HCP_TOKEN: "injected" } })).toBe("injected");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
