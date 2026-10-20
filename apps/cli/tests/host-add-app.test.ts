/** On a machine where the app serves the workspaces (its drive socket, no `hive host`): `hive host
 *  add` has the app serve one more folder, with no window, and `hive share` names a folder the app
 *  does not serve yet, by its path or its issue prefix, and has it served; a name three folders
 *  answer to is refused with each of them. `hive host install` refuses while the app runs. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceStore } from "@hivemind/workspace-host/store";
import { newSeed } from "@hivemind/workspace-host/identity";
import { WorkspaceServer } from "@hivemind/workspace-api/server";
import { serveDrive, type DriveServer } from "@hivemind/host/drive";
import { controlApi } from "@hivemind/host/control-api";
import { makeDispatch, type MethodDeps } from "@hivemind/host/control/methods";
import { Grants } from "@hivemind/host/grants";
import { tileToken } from "@hivemind/agent-host/hooks/token";
import { hive, hiveAsync } from "./helpers.js";

const unix = process.platform !== "win32";
const dir = unix ? fs.realpathSync(fs.mkdtempSync("/tmp/hive-app-add-")) : "";
const sock = path.join(dir, "drive.sock");
const appData = path.join(dir, "data");
const TOKEN = "t0k3n";
/** The app serves one "manageark"; two more folders of that name are only on disk, one registered. */
const served = path.join(dir, "old", "manageark");
const registeredOne = path.join(dir, "work", "manageark");
const loose = path.join(dir, "manageark");
const env = { XDG_CONFIG_HOME: path.join(dir, "config"), HIVEMIND_APP_DATA: appData, HIVE_DRIVE_SOCK: sock, HCP_TOKEN: TOKEN, HIVEMIND_TILE: "" };
let drive: DriveServer;
let store: WorkspaceStore;

beforeAll(async () => {
  if (!unix) return;
  for (const d of [served, registeredOne, loose, appData]) fs.mkdirSync(d, { recursive: true });
  expect(hive(["init", "--prefix", "MAAG", "--no-agentic"], { cwd: registeredOne, env }).code).toBe(0);
  store = new WorkspaceStore({ dir: path.join(dir, "store"), person: newSeed() });
  store.setCore(served, { frames: [], tiles: [] });
  const { api } = makeDispatch({ workspaces: store } as unknown as MethodDeps);
  // Who is let in by a link is not what is under test here.
  const people = { answers: { "people.invite": async (_f: unknown, repo: unknown) => `hivemind://join/${path.basename(String(repo))}`, "people.requests": async () => ({ answering: "ask", requests: [] }) }, effects: {} };
  const server = new WorkspaceServer([controlApi({ control: async () => api }), people], new Intents(new AuditLog({ file: path.join(dir, "audit.jsonl") })));
  drive = serveDrive(sock, { server, installToken: () => TOKEN, grants: new Grants(path.join(dir, "grants.json")), repos: () => store.repos(), workspaceOf: () => served, nameOf: () => "" });
  while (!fs.existsSync(sock)) await new Promise((r) => setTimeout(r, 10));
});
afterAll(() => {
  drive?.close();
  if (unix) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!unix)("with the app serving this machine", () => {
  test("`hive host add` has the app serve the folder: it lists it, with an id", async () => {
    const extra = path.join(dir, "extra");
    fs.mkdirSync(extra);
    const r = await hiveAsync(["host", "add", extra, "--json"], { env });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ repo: extra });
    expect(store.repos()).toContain(extra);
    expect(store.ownership(extra)?.workspaceId).toBe((r.json as { workspace: string }).workspace);
  });

  test("an agent's tile may not serve a folder: it is refused, told the person runs `hive host add`, and nothing is served", async () => {
    const home = path.join(dir, "home");
    fs.mkdirSync(home);
    const r = await hiveAsync(["host", "add", home, "--json"], { env: { HIVE_DRIVE_SOCK: sock, HCP_TOKEN: tileToken(TOKEN, "hm:me-1") } });
    expect(r.code).not.toBe(0);
    expect(JSON.stringify(r.json)).toContain("run `hive host add <folder>` in a terminal of your own");
    expect(store.repos()).not.toContain(home);
  });

  test("a name three folders answer to is refused with each; the folder's path, or its prefix, shares it, served first", async () => {
    const twice = await hiveAsync(["share", "manageark", "--json"], { env, cwd: dir });
    expect(twice.code).toBe(2);
    const said = JSON.stringify(twice.json);
    for (const d of [served, registeredOne, loose]) expect(said).toContain(`at ${d}`);
    expect(said).toContain("MAAG");
    expect(store.repos()).not.toContain(registeredOne);

    const byPrefix = await hiveAsync(["share", "maag", "--json"], { env, cwd: dir });
    expect(byPrefix.json).toMatchObject({ workspace: registeredOne, link: "hivemind://join/manageark" });
    expect(store.repos()).toContain(registeredOne);
    const byPath = await hiveAsync(["share", loose, "--json"], { env, cwd: os.tmpdir() });
    expect(byPath.json).toMatchObject({ workspace: loose });
  });

  test("`hive host install` refuses while the app runs, and names what works", () => {
    if (process.platform !== "linux") return;
    const lock = path.join(appData, "SingletonLock");
    fs.symlinkSync(`${os.hostname()}-${process.pid}`, lock);
    // Stand-ins that only record a call, so a missing refusal never reaches this machine's systemd.
    const bin = path.join(dir, "bin");
    const called = path.join(dir, "service-calls");
    fs.mkdirSync(bin, { recursive: true });
    for (const cmd of ["systemctl", "loginctl"]) fs.writeFileSync(path.join(bin, cmd), `#!/bin/sh\necho ${cmd} "$@" >> ${called}\n`, { mode: 0o755 });
    try {
      const r = hive(["host", "install", "--json"], { env: { ...env, XDG_CONFIG_HOME: path.join(dir, "units"), PATH: `${bin}:${process.env.PATH}` } });
      expect(r.code).toBe(3);
      expect(r.json).toMatchObject({ error: { code: "APP_RUNNING" } });
      expect((r.json as { error: { message: string } }).error.message).toContain("`hive host add <folder>` serves one more folder through it");
      expect(fs.existsSync(path.join(dir, "units", "systemd"))).toBe(false);
      expect(fs.existsSync(called)).toBe(false);
    } finally {
      fs.rmSync(lock);
    }
  });
});
