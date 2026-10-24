/** `hive ingest` as a sync service or an agent runs it: NDJSON on stdin, the report on stdout, and
 *  the exit codes a caller branches on. Ingest's semantics are owned by hive-core's ingest tests. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeConfig } from "@hivemind/core";
import { cmd, sealedEnv } from "./helpers.js";

let tmp: string;
let xdg: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hive-ingest-cli-"));
  xdg = await fs.mkdtemp(path.join(os.tmpdir(), "hive-ingest-cli-xdg-"));
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(xdg, { recursive: true, force: true });
});

async function workspace(name: string): Promise<string> {
  const repo = path.join(tmp, name);
  await fs.mkdir(path.join(repo, ".hivemind", "issues"), { recursive: true });
  await writeConfig(path.join(repo, ".hivemind"), { prefix: "HIVE", next_id: 1, agents: {} });
  return repo;
}

function ingest(repo: string, args: string[], stdin: string) {
  const r = spawnSync(...cmd(["ingest", "--source", "jira:acme/PAY", ...args, "--json"]), {
    cwd: repo, input: stdin, encoding: "utf8", timeout: 60_000, env: { ...sealedEnv(), XDG_CONFIG_HOME: xdg },
  });
  const last = (s: string) => { try { return JSON.parse(s.trim().split("\n").pop() || ""); } catch { return undefined; } };
  return { code: r.status, json: last(r.stdout) ?? last(r.stderr) };
}

const line = (key: string, id: string) => JSON.stringify({
  external: { id, key, remoteUpdated: "2026-10-22T09:14:00.000+0000" },
  title: `Issue ${key}`,
  status: { id: "jira:10001", name: "To Do", category: "todo" },
});
const records = `${line("PAY-318", "10423")}\n\n${line("PAY-321", "10426")}\n`;
const mirrored = (repo: string, key: string) => path.join(repo, ".hivemind", "mirror", "jira-acme-PAY", `${key}.md`);
const exists = (p: string) => fs.stat(p).then(() => true, () => false);

describe("hive ingest", () => {
  test("reads one record per line and prints the report; --dry-run writes nothing", async () => {
    const repo = await workspace("a");
    const dry = ingest(repo, ["--dry-run"], records);
    expect(dry.code).toBe(0);
    expect(dry.json).toMatchObject({ dryRun: true, created: ["PAY-318", "PAY-321"] });
    expect(await exists(mirrored(repo, "PAY-318"))).toBe(false);
    const real = ingest(repo, [], records);
    expect(real.code).toBe(0);
    expect(real.json).toMatchObject({ source: "jira:acme/PAY", dryRun: false, created: ["PAY-318", "PAY-321"], updated: [], unchanged: [], conflicts: [], archived: [] });
    expect(await exists(mirrored(repo, "PAY-318"))).toBe(true);
  });

  test("a line that isn't JSON, or a record that doesn't parse, is a bad request (exit 2) naming it", async () => {
    const repo = await workspace("b");
    const notJson = ingest(repo, [], `${line("PAY-1", "1")}\n{oops\n`);
    expect(notJson.code).toBe(2);
    expect(notJson.json.error.message).toContain("line 2");
    const bad = ingest(repo, [], `${line("PAY-1", "1")}\n${JSON.stringify({ external: { id: "2", key: "PAY-2" } })}\n`);
    expect(bad.code).toBe(2);
    expect(bad.json.error.message).toContain("record 2");
    expect(await exists(mirrored(repo, "PAY-1"))).toBe(false);
  });

  test("another live sync of the source is refused with exit 7, SYNC_LOCKED", async () => {
    const repo = await workspace("c");
    const lock = path.join(repo, ".hivemind", "sync", "jira-acme-PAY", "lock");
    await fs.mkdir(path.dirname(lock), { recursive: true });
    const now = new Date().toISOString();
    await fs.writeFile(lock, JSON.stringify({ pid: process.pid, machine: os.hostname(), since: now, heartbeat: now, token: "test" }));
    const r = ingest(repo, [], records);
    expect(r.code).toBe(7);
    expect(r.json.error.code).toBe("SYNC_LOCKED");
    expect(await exists(mirrored(repo, "PAY-318"))).toBe(false);
  });
});
