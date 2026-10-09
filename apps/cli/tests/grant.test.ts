/** `hive grant`: the person makes, lists and takes back grants on the drive socket of the app or
 *  `hive host` (a REAL drive socket and grants store), and a token it prints lets that program in. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceServer } from "@hivemind/workspace-api/server";
import { tileToken } from "@hivemind/agent-host/hooks/token";
import { serveDrive, type DriveServer } from "@hivemind/host/drive";
import { Grants, grantsDomain } from "@hivemind/host/grants";
import { hiveAsync as hive } from "./helpers.js";

const unix = process.platform !== "win32";
const dir = unix ? fs.mkdtempSync("/tmp/hive-grant-") : "";
const sock = path.join(dir, "drive.sock");
const repoA = path.join(dir, "a");
const repoB = path.join(dir, "b");
const TOKEN = "t0k3n";
const env = (token = TOKEN) => ({ XDG_CONFIG_HOME: dir, HIVEMIND_APP_DATA: path.join(dir, "hivemind"), HIVE_DRIVE_SOCK: sock, HCP_TOKEN: token, HIVEMIND_TILE: "" });
let grants: Grants;
let drive: DriveServer;

beforeAll(async () => {
  for (const r of [repoA, repoB]) fs.mkdirSync(r, { recursive: true });
  grants = new Grants(path.join(dir, "grants.json"));
  const server = new WorkspaceServer([grantsDomain(() => grants)], new Intents(new AuditLog({ file: path.join(dir, "audit.jsonl") })));
  drive = serveDrive(sock, { server, installToken: () => TOKEN, grants, repos: () => [repoA, repoB], holds: () => false });
  while (!fs.existsSync(sock)) await new Promise((r) => setTimeout(r, 10));
});
afterAll(() => {
  drive?.close();
  if (unix) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!unix)("hive grant", () => {
  test("create prints a token that is the grant, for each workspace given; list shows it without the token; revoke takes it back", async () => {
    const made = await hive(["grant", "create", "review-bot", "-w", repoA, "--workspace", repoB, "--role", "agents", "--json"], { env: env() });
    expect(made.code).toBe(0);
    const { grant, token } = (made.json as { data: { grant: { id: string; repos: string[]; role: string }; token: string } }).data;
    expect(grant.repos).toEqual([fs.realpathSync(repoA), fs.realpathSync(repoB)]);
    expect(grant.role).toBe("agents");
    expect(grants.holder(token)?.id).toBe(grant.id);

    const listed = await hive(["grant", "list", "--json"], { env: env() });
    expect(JSON.stringify(listed.json)).not.toContain(token);
    expect((listed.json as { data: Array<{ id: string }> }).data.map((g) => g.id)).toContain(grant.id);

    const revoked = await hive(["grant", "revoke", grant.id, "--json"], { env: env() });
    expect(revoked.json).toEqual({ ok: true, data: { revoked: true } });
    expect(grants.holder(token)).toBeNull();
    const again = await hive(["grant", "revoke", grant.id, "--json"], { env: env() });
    expect(again.code).toBe(5);
  });

  test("an agent's token makes no grant", async () => {
    const n = grants.list().length;
    const r = await hive(["grant", "create", "sneaky", "-w", repoA, "--json"], { env: env(tileToken(TOKEN, "tile-1")) });
    expect(r.code).toBe(6);
    expect(grants.list().length).toBe(n);
  });

  test("with nothing serving the drive socket, it says so", async () => {
    const r = await hive(["grant", "list", "--json"], { env: { ...env(), HIVE_DRIVE_SOCK: path.join(dir, "none.sock") } });
    expect(r.code).toBe(3);
  });
});
