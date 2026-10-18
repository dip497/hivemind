/** `hive ctl frame add` on a real drive socket and the host's real frames domain: an agent opens a
 *  frame on a folder of another machine, named by its name or id, and gets that frame again for the
 *  same folder; a name two machines share is refused with each of them and its id. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceStore } from "@hivemind/workspace-host/store";
import { newSeed } from "@hivemind/workspace-host/identity";
import { WorkspaceServer } from "@hivemind/workspace-api/server";
import { tileToken } from "@hivemind/agent-host/hooks/token";
import { serveDrive, type DriveServer } from "@hivemind/host/drive";
import { framesDomain } from "@hivemind/host/frames";
import { Grants } from "@hivemind/host/grants";
import { hiveAsync as hive } from "./helpers.js";

const unix = process.platform !== "win32";
const dir = unix ? fs.realpathSync(fs.mkdtempSync("/tmp/hive-ctl-frame-")) : "";
const sock = path.join(dir, "drive.sock");
const repo = path.join(dir, "web");
const TOKEN = "t0k3n";
const DEVICE = "ab".repeat(32);
let drive: DriveServer;
let store: WorkspaceStore;
const asAgent = { HIVE_DRIVE_SOCK: sock, HCP_TOKEN: tileToken(TOKEN, "hm:me-1") };

beforeAll(async () => {
  if (!unix) return;
  fs.mkdirSync(repo);
  store = new WorkspaceStore({ dir: path.join(dir, "store"), person: newSeed() });
  store.setCore(repo, { frames: [{ id: "own", title: "web", workspacePath: repo }], tiles: [], tileNames: {}, editorTabs: {}, frameOf: {} } as never, {});
  const machines = [{ id: "m-1", name: "build" }, { id: DEVICE, name: "Studio" }, { id: "m-2", name: "twin" }, { id: "m-3", name: "Twin" }];
  const server = new WorkspaceServer([framesDomain({
    store: () => store, worktreeList: async () => [], worktreeCreate: async () => { throw new Error("no worktrees here"); }, worktreeRemove: async () => {},
    closeTile: () => {}, machines: () => machines,
  })], new Intents(new AuditLog({ file: path.join(dir, "audit.jsonl") })));
  drive = serveDrive(sock, { server, installToken: () => TOKEN, grants: new Grants(path.join(dir, "grants.json")), repos: () => [repo], workspaceOf: () => repo, nameOf: () => "the agent" });
  while (!fs.existsSync(sock)) await new Promise((r) => setTimeout(r, 10));
});
afterAll(() => {
  drive?.close();
  if (unix) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!unix)("hive ctl frame add", () => {
  test("an agent opens a frame on a folder of another machine by the machine's name, and the same folder again gives the same frame", async () => {
    const made = await hive(["ctl", "frame", "add", "--machine", "build", "--folder", "/srv/api", "--json"], { env: asAgent });
    expect(made.code).toBe(0);
    const opened = made.json as { frame: string; path: string; opened: boolean };
    expect(opened).toMatchObject({ path: "machine://m-1/srv/api", opened: true });
    expect(store.getCore(repo)!.frames.find((f) => f.id === opened.frame)).toMatchObject({ title: "api", workspacePath: "machine://m-1/srv/api" });
    const again = await hive(["ctl", "frame", "add", "--machine", "m-1", "--folder", "/srv/api", "--json"], { env: asAgent });
    expect(again.json).toMatchObject({ frame: opened.frame, opened: false });
  });

  test("one of the person's devices is named by its name too, and the frame takes the name given", async () => {
    const r = await hive(["ctl", "frame", "add", "--machine", "studio", "--folder", "/home/me/builds", "--name", "builder", "--json"], { env: asAgent });
    expect(r.code).toBe(0);
    const { frame } = r.json as { frame: string };
    expect(store.getCore(repo)!.frames.find((f) => f.id === frame)).toMatchObject({ title: "builder", workspacePath: `machine://${DEVICE}/home/me/builds` });
  });

  test("a name two machines share opens nothing and lists each with its id; a machine nobody has is not found", async () => {
    const before = store.getCore(repo)!.frames.length;
    const twin = await hive(["ctl", "frame", "add", "--machine", "twin", "--folder", "/srv", "--json"], { env: asAgent });
    expect(twin.code).not.toBe(0);
    expect(twin.json).toMatchObject({ ok: false, code: "BAD_REQUEST" });
    expect((twin.json as { message: string }).message).toContain("twin (m-2), Twin (m-3)");
    const none = await hive(["ctl", "frame", "add", "--machine", "nowhere", "--folder", "/srv", "--json"], { env: asAgent });
    expect(none.json).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(store.getCore(repo)!.frames.length).toBe(before);
  });
});
