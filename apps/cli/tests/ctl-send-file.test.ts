/** `hive ctl send-file`, `sent-files` and `take-back-file` on a REAL drive socket and the real store:
 *  an agent sends as itself from its own folder, what it answers says the file is ready and not that
 *  it arrived, and each refusal has its exit code and its fix. */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceServer } from "@hivemind/workspace-api/server";
import { tileToken } from "@hivemind/agent-host/hooks/token";
import { serveDrive, type DriveServer } from "@hivemind/host/drive";
import { Grants } from "@hivemind/host/grants";
import { SENT_FILE_MAX, SentFileStore, sentFiles } from "@hivemind/host/sent-files";
import { hiveAsync as hive } from "./helpers.js";

const unix = process.platform !== "win32";
// Each test runs the CLI as a process, many times: on a busy machine that is seconds each.
setDefaultTimeout(120_000);
const dir = unix ? fs.realpathSync(fs.mkdtempSync("/tmp/hive-ctl-files-")) : "";
const sock = path.join(dir, "drive.sock");
const repo = path.join(dir, "a");
const TOKEN = "t0k3n";
const env = (token = TOKEN) => ({ HIVE_DRIVE_SOCK: sock, HCP_TOKEN: token });
const asAgent = () => ({ ...env(tileToken(TOKEN, "hm:me-1")), HIVEMIND_TILE: "hm:me-1" });
let phones = 1;
let drive: DriveServer;

beforeAll(async () => {
  fs.mkdirSync(repo, { recursive: true });
  const domain = sentFiles({
    store: new SentFileStore(path.join(dir, "sent")),
    place: (tile) => (tile === "me-1" || tile === "w-2" ? repo : null),
    elsewhere: () => false,
    phones: () => phones,
  });
  const server = new WorkspaceServer([domain], new Intents(new AuditLog({ file: path.join(dir, "audit.jsonl") })));
  drive = serveDrive(sock, {
    server, installToken: () => TOKEN, grants: new Grants(path.join(dir, "grants.json")), repos: () => [repo],
    workspaceOf: (tile) => (["me-1", "w-2"].includes(String(tile)) ? repo : null), nameOf: (tile) => `the ${tile} agent`,
  });
  while (!fs.existsSync(sock)) await new Promise((r) => setTimeout(r, 10));
});
afterAll(() => {
  drive?.close();
  if (unix) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!unix)("hive ctl send-file on a real drive socket", () => {
  test("an agent sends a file named from its own folder, as itself; it says the file is ready, not that it arrived; it lists it and takes it back", async () => {
    fs.writeFileSync(path.join(repo, "report.pdf"), "the report");
    const r = await hive(["ctl", "send-file", "report.pdf", "--json"], { cwd: repo, env: asAgent() });
    expect(r.code).toBe(0);
    const sent = r.json as { id: string; tile: string; name: string; size: number; ready: string };
    expect([sent.tile, sent.name, sent.size]).toEqual(["me-1", "report.pdf", 10]);
    expect(sent.ready).toMatch(/not necessarily reached/);
    expect(JSON.stringify(sent)).not.toContain(dir);
    expect(fs.readFileSync(path.join(dir, "sent", sent.id), "utf8")).toBe("the report");

    const listed = await hive(["ctl", "sent-files", "--json"], { cwd: repo, env: asAgent() });
    expect((listed.json as { files: Array<{ id: string }> }).files.map((f) => f.id)).toEqual([sent.id]);

    const back = await hive(["ctl", "take-back-file", sent.id, "--json"], { cwd: repo, env: asAgent() });
    expect([back.code, back.json]).toEqual([0, { takenBack: true }]);
    const again = await hive(["ctl", "take-back-file", sent.id, "--json"], { cwd: repo, env: asAgent() });
    expect(again.code).toBe(5);
    expect(fs.existsSync(path.join(dir, "sent", sent.id))).toBe(false);
  });

  test("each refusal has its exit code, and those it can say how to mend have a fix", async () => {
    const big = path.join(repo, "big.bin");
    fs.closeSync(fs.openSync(big, "w"));
    fs.truncateSync(big, SENT_FILE_MAX + 1);
    const failure = (r: { stderr: string }) => (JSON.parse(r.stderr) as { error: { code: string; message: string; fix?: string } }).error;

    const tooBig = await hive(["ctl", "send-file", "big.bin", "--json"], { cwd: repo, env: asAgent() });
    expect([tooBig.code, failure(tooBig).code]).toEqual([7, "FILE_TOO_BIG"]);
    expect(failure(tooBig).message).toContain("32 MiB");
    expect(failure(tooBig).fix).toContain("smaller");

    phones = 0;
    fs.writeFileSync(path.join(repo, "a.txt"), "a");
    const noPhone = await hive(["ctl", "send-file", "a.txt", "--json"], { cwd: repo, env: asAgent() });
    phones = 1;
    expect([noPhone.code, failure(noPhone).code]).toEqual([7, "NO_PHONE"]);
    expect(failure(noPhone).fix).toContain("pair a phone");

    const missing = await hive(["ctl", "send-file", "none.txt", "--json"], { cwd: repo, env: asAgent() });
    expect([missing.code, failure(missing).code]).toEqual([5, "NOT_FOUND"]);

    const another = await hive(["ctl", "send-file", "a.txt", "--tile", "w-2", "--json"], { cwd: repo, env: asAgent() });
    expect([another.code, failure(another).code]).toEqual([6, "FORBIDDEN"]);

    const nobody = await hive(["ctl", "send-file", "a.txt", "--json"], { cwd: repo, env: { ...env(), HIVEMIND_TILE: undefined } });
    expect([nobody.code, failure(nobody).code]).toEqual([2, "USAGE"]);
    const person = await hive(["ctl", "send-file", "a.txt", "--tile", "w-2", "--json"], { cwd: repo, env: { ...env(), HIVEMIND_TILE: undefined } });
    expect(person.code).toBe(0);
    expect((person.json as { tile: string }).tile).toBe("w-2");
  });
});
