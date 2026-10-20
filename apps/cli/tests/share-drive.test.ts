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
/** Two of the host's workspaces in folders of one name: the person's old checkout, and the one shared. */
const twins = [{ repo: path.join(dir, "manageark"), workspace: "ws-aaaa1111" }, { repo: path.join(dir, "work", "manageark"), workspace: "ws-bbbb2222" }];
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
    answer("host.status", () => ({ workspaces: [{ repo, workspace: "ws-1234" }, ...twins] })),
    answer("people.invite", (at) => `hivemind://join/${path.basename(String(at))}`),
    answer("people.requests", () => ({ answering: "ask", requests: [] })),
    answer("agent.list", () => ({ seq: 0, agents: [] })),
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
    expect(list.json).toEqual({ people: [{ person: "p-guest", name: "Guest", role: "edit", present: true }] });
    const allow = await hive(["people", "allow", "3", "-w", "team", "--json"], { env: env() });
    expect(allow.code).toBe(1); // not waiting
    expect(asked.at(-1)).toEqual({ method: "people.answer", params: [repo, 3, true], actor: { kind: "person" } });
  });

  test("join asks the host the link names, and says what it answered", async () => {
    const r = await hive(["join", "hivemind://join/x", "--json"], { env: env() });
    expect(r.json).toEqual({ ok: true, role: "edit" });
    expect(asked.at(-1)).toEqual({ method: "host.join", params: ["hivemind://join/x"], actor: { kind: "person" } });
  });

  test("an agent's token may not share or join", async () => {
    const asAgent = env(sock, tileToken(TOKEN, "hm:w-1"));
    const n = asked.length;
    for (const args of [["people", "list", "-w", "team"], ["join", "hivemind://join/x"]]) {
      const r = await hive([...args, "--json"], { env: asAgent });
      expect(r.json).toMatchObject({ error: { code: "REFUSED" } });
    }
    expect(asked.slice(n).map((a) => a.method)).toEqual(["host.status"]);
  });

  test("refused a join, an agent is told who joins and how: the person, with `hive join` in a terminal of their own", async () => {
    const r = await hive(["join", "hivemind://join/x", "--json"], { env: env(sock, tileToken(TOKEN, "hm:w-1")) });
    expect(r.json).toMatchObject({ error: { code: "REFUSED" } });
    expect((r.json as { error: { message: string } }).error.message).toContain("run `hive join <link>` in a terminal of your own, not from an agent's tile");
  });

  test("a name two of the host's workspaces answer to is refused by share, people, grant and ctl alike, each listed with its id and folder; its id names one", async () => {
    const n = asked.length;
    for (const args of [["share", "manageark"], ["people", "list", "-w", "manageark"], ["grant", "create", "bot", "-w", "manageark"], ["ctl", "agents", "--repo", "manageark"]]) {
      const r = await hive([...args, "--json"], { env: env(), cwd: dir });
      expect(r.code).toBe(2);
      const said = JSON.stringify(r.json);
      for (const t of twins) expect(said).toContain(`manageark (${t.workspace}) at ${t.repo}`);
    }
    expect(asked.slice(n).map((a) => a.method).filter((m) => m !== "host.status")).toEqual([]);
    const byId = await hive(["share", "ws-bbbb", "--json"], { env: env(), cwd: dir });
    expect(byId.json).toMatchObject({ workspace: twins[1]!.repo, link: "hivemind://join/manageark" });
  });

  test("with neither the app nor hive host running, it says so", async () => {
    const r = await hive(["people", "list", "--json"], { env: env(path.join(dir, "none.sock")) });
    expect(r.code).toBe(3);
    expect(r.json).toMatchObject({ error: { code: "HOST_NOT_RUNNING" } });
    expect(String((r.json as { error: { message: string } }).error.message)).toMatch(/neither the hivemind app nor `hive host` is running/);
  });
});
