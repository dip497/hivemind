/** `hive ctl open` on a real drive socket: a path is sent absolute, read from where it runs, with
 *  its line kept; an address as written. */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import { ApiError } from "@hivemind/workspace-api/protocol";
import { serveDrive, type DriveServer } from "@hivemind/host/drive";
import { Grants } from "@hivemind/host/grants";
import { hiveAsync as hive } from "./helpers.js";

const unix = process.platform !== "win32";
setDefaultTimeout(30_000);
const dir = unix ? fs.realpathSync(fs.mkdtempSync("/tmp/hive-ctl-open-")) : "";
const sock = path.join(dir, "drive.sock");
const repo = path.join(dir, "repo");
const TOKEN = "t0k3n";
const asked: unknown[][] = [];
let drive: DriveServer;
const env = () => ({ HIVE_DRIVE_SOCK: sock, HCP_TOKEN: TOKEN });

beforeAll(async () => {
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  const answers = {
    "opener.open": (_from: Connection, thing: unknown, tile: unknown) => {
      asked.push(tile === undefined ? [thing] : [thing, tile]);
      if (String(thing).startsWith("smb:")) throw new ApiError("UNSUPPORTED", "not opened: smb: links open only once you allow them");
      return { to: "code", path: String(thing).replace(/:\d+(?::\d+)?$/, ""), line: 12, tile: "editor-1" };
    },
  };
  const server = new WorkspaceServer([{ answers, effects: {} }], new Intents(new AuditLog({ file: path.join(dir, "audit.jsonl") })));
  drive = serveDrive(sock, {
    server, installToken: () => TOKEN, grants: new Grants(path.join(dir, "grants.json")), repos: () => [repo],
    workspaceOf: (tile) => (tile === "me-1" ? repo : null), nameOf: (tile) => `the ${tile} agent`,
  });
  while (!fs.existsSync(sock)) await new Promise((r) => setTimeout(r, 10));
});
afterAll(() => {
  drive?.close();
  if (unix) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!unix)("hive ctl open", () => {
  test("a path is sent absolute, from where it runs, its line and column kept", async () => {
    const r = await hive(["ctl", "open", "src/a.ts:12:4", "--json"], { cwd: repo, env: env() });
    expect([r.code, r.json]).toEqual([0, { to: "code", path: path.join(repo, "src/a.ts"), line: 12, tile: "editor-1" }]);
    expect(asked.at(-1)).toEqual([`${path.join(repo, "src/a.ts")}:12:4`]);
  });

  test("an address goes as written, a name with a line is a path", async () => {
    await hive(["ctl", "open", "https://example.com/a?b=1", "--json"], { cwd: repo, env: env() });
    expect(asked.at(-1)).toEqual(["https://example.com/a?b=1"]);
    await hive(["ctl", "open", "README.md:3", "--json"], { cwd: repo, env: env() });
    expect(asked.at(-1)).toEqual([`${path.join(repo, "README.md")}:3`]);
  });

  test("an agent asking for a kind of link only the person opens exits 7, and is told to hand it to them", async () => {
    const r = await hive(["ctl", "open", "smb://box/share", "--json"], { cwd: repo, env: env() });
    const error = (r.json as { error: { code: string; fix?: string } }).error;
    expect([r.code, error.code]).toEqual([7, "UNSUPPORTED"]);
    expect(error.fix).toContain("only the person can open this kind of link");
  });
});
