/** `hive share`, `hive people` and `hive join` on a REAL drive socket (the host's serveDrive and
 *  workspace server, a scripted domain), which the app and `hive host` both serve: as the person,
 *  in the host's JSON shapes; an agent's token may not share or join; and with nothing running
 *  they say so. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Intents, type Actor } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import { tileToken } from "@hivemind/agent-host/hooks/token";
import { serveDrive, type DriveServer } from "@hivemind/host/drive";
import { Grants } from "@hivemind/host/grants";
import { hiveAsync as hive } from "./helpers.js";

const unix = process.platform !== "win32";
const dir = unix ? fs.realpathSync(fs.mkdtempSync("/tmp/hive-share-")) : "";
const sock = path.join(dir, "drive.sock");
const repo = path.join(dir, "team");
const TOKEN = "t0k3n";
const asked: Array<{ method: string; params: unknown[]; actor: Actor }> = [];
const env = (s = sock, token = TOKEN) => ({ XDG_CONFIG_HOME: dir, HIVEMIND_APP_DATA: path.join(dir, "hivemind"), HIVE_DRIVE_SOCK: s, HCP_TOKEN: token });
let drive: DriveServer;

const answer = (method: string, reply: (...params: unknown[]) => unknown) => [method, (from: Connection, ...params: unknown[]) => {
  asked.push({ method, params, actor: from.actor });
  return reply(...params);
}] as const;

beforeAll(async () => {
  fs.mkdirSync(repo);
  const answers = Object.fromEntries([
    answer("host.status", () => ({ workspaces: [{ repo, workspace: "ws-1234" }] })),
    answer("people.list", () => [{ person: "p-guest", name: "Guest", role: "edit", present: true }]),
    answer("people.answer", () => ({ answered: false })),
    answer("host.join", (link) => ({ ok: link === "hivemind://join/x", role: "edit" })),
  ]);
  const server = new WorkspaceServer([{ answers, effects: {} }], new Intents(new AuditLog({ file: path.join(dir, "audit.jsonl") })));
  drive = serveDrive(sock, {
    server, installToken: () => TOKEN, grants: new Grants(path.join(dir, "grants.json")), repos: () => [repo],
    workspaceOf: (tile) => (tile === "w-1" ? repo : null), nameOf: (tile) => `the ${tile} agent`,
  });
  while (!fs.existsSync(sock)) await new Promise((r) => setTimeout(r, 10));
});
afterAll(() => {
  drive?.close();
  if (unix) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!unix)("hive share/people/join on the drive socket", () => {
  test("people are listed and answered as the person, in the host's JSON", async () => {
    const list = await hive(["people", "list", "--json"], { env: env(), cwd: repo });
    expect(list.json).toEqual({ ok: true, data: [{ person: "p-guest", name: "Guest", role: "edit", present: true }] });
    const allow = await hive(["people", "allow", "3", "-w", "team", "--json"], { env: env() });
    expect(allow.code).toBe(1); // not waiting
    expect(asked.at(-1)).toEqual({ method: "people.answer", params: [repo, 3, true], actor: { kind: "person" } });
  });

  test("join asks the host the link names, and says what it answered", async () => {
    const r = await hive(["join", "hivemind://join/x", "--json"], { env: env() });
    expect(r.json).toEqual({ ok: true, data: { ok: true, role: "edit" } });
    expect(asked.at(-1)).toEqual({ method: "host.join", params: ["hivemind://join/x"], actor: { kind: "person" } });
  });

  test("an agent's token may not share or join", async () => {
    const asAgent = env(sock, tileToken(TOKEN, "hm:w-1"));
    const n = asked.length;
    for (const args of [["people", "list", "-w", "team"], ["join", "hivemind://join/x"]]) {
      const r = await hive([...args, "--json"], { env: asAgent });
      expect(r.json).toMatchObject({ ok: false, code: "refused" });
    }
    expect(asked.slice(n).map((a) => a.method)).toEqual(["host.status"]);
  });

  test("with neither the app nor hive host running, it says so", async () => {
    const r = await hive(["people", "list", "--json"], { env: env(path.join(dir, "none.sock")) });
    expect(r.code).toBe(3);
    expect(r.json).toMatchObject({ ok: false, code: "host_not_running" });
    expect(String((r.json as { error: string }).error)).toMatch(/neither the hivemind app nor `hive host` is running/);
  });
});
