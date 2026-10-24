/** Ids route to the repo that holds them (design jira-sync §5.2): `hive show|update|close|list|new`
 *  reach a mirrored issue from another repo through the registry's external prefixes, and an id
 *  more than one repo holds is refused with every candidate named. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readIssue, registerWorkspace, writeConfig } from "@hivemind/core";
import { hive } from "./helpers.js";

let tmp: string;
let xdg: string;
const repo = (name: string) => path.join(tmp, name);
const env = () => ({ XDG_CONFIG_HOME: xdg, HIVE_AGENT_ID: "tester" });

async function workspace(name: string, prefix: string, externals: string[] = []): Promise<string> {
  const root = path.join(repo(name), ".hivemind");
  await fs.mkdir(path.join(root, "issues"), { recursive: true });
  await writeConfig(root, { prefix, next_id: 1, agents: {}, ...(externals.length ? { external_prefixes: externals } : {}) });
  await registerWorkspace(root);
  return root;
}

async function mirrored(root: string, id: string, extra: string[] = []): Promise<void> {
  const p = path.join(root, "mirror", "jira-acme-PAY", `${id}.md`);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, [
    "---", `id: ${id}`, `title: Mirrored ${id}`, "state: todo", "parent: null", "labels: []", "assignee: null", "github: null",
    "external:", "  provider: jira", "  source: 'jira:acme/PAY'", `  id: '${id.replace(/\D/g, "")}'`, `  key: ${id}`, ...extra,
    "created: '2026-10-13T08:00:00.000Z'", "updated: '2026-10-22T09:14:00.000Z'", "---", "## Description", "", "From Jira.", "",
  ].join("\n"));
}

let a: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hive-route-"));
  xdg = await fs.mkdtemp(path.join(os.tmpdir(), "hive-route-xdg-"));
  process.env.XDG_CONFIG_HOME = xdg; // registerWorkspace in this process writes the same registry
  a = await workspace("a", "AA", ["PAY", "OPS"]);
  await workspace("b", "BB");
  await mirrored(a, "PAY-318");
  await mirrored(a, "OPS-7", ["aliases:", "  - PAY-112"]);
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(xdg, { recursive: true, force: true });
});

describe("a mirrored id resolves from another repo", () => {
  test("show, update, close, new --parent and list --parent reach the repo that mirrors it", async () => {
    const from = { cwd: repo("b"), env: env() };
    const shown = hive(["show", "PAY-318", "--json"], from);
    expect(shown.code).toBe(0);
    expect((shown.json as { path: string }).path).toBe(path.join(a, "mirror", "jira-acme-PAY", "PAY-318.md"));

    expect(hive(["update", "PAY-318", "--add-label", "routed", "--json"], from).code).toBe(0);
    expect((await readIssue(a, "PAY-318")).labels).toEqual(["routed"]);

    const child = hive(["new", "Follow-up", "--parent", "PAY-318", "--json"], from);
    expect(child.code).toBe(0);
    expect(child.json).toMatchObject({ id: "AA-1", path: path.join(a, "issues", "AA-1.md") });
    const kids = hive(["list", "--parent", "PAY-318", "--json"], from);
    expect((kids.json as { issues: { id: string }[] }).issues.map((i) => i.id)).toEqual(["AA-1"]);

    expect(hive(["close", "PAY-318", "--json"], from).code).toBe(0);
    expect((await readIssue(a, "PAY-318")).state).toBe("done");
  }, 60_000);

  test("an old key resolves to the issue that moved, from another repo", () => {
    const r = hive(["show", "PAY-112", "--json"], { cwd: repo("b"), env: env() });
    expect(r.code).toBe(0);
    expect((r.json as { id: string }).id).toBe("OPS-7");
  }, 60_000);

  test("a prefix mirrored by two repos is refused with exit 5 naming both, except from inside one of them", async () => {
    const c = await workspace("c", "CC", ["PAY"]);
    await mirrored(c, "PAY-318");
    const r = hive(["show", "PAY-318", "--json"], { cwd: repo("b"), env: env() });
    expect(r.code).toBe(5);
    const msg = (r.json as { error: { message: string } }).error.message;
    expect(msg).toContain(repo("a"));
    expect(msg).toContain(repo("c"));
    const inC = hive(["show", "PAY-318", "--json"], { cwd: repo("c"), env: env() });
    expect(inC.code).toBe(0);
    expect((inC.json as { path: string }).path.startsWith(c)).toBe(true);
  }, 60_000);

  test("a prefix no repo holds is not_found (exit 5)", () => {
    const r = hive(["show", "NOPE-1", "--json"], { cwd: repo("b"), env: env() });
    expect(r.code).toBe(5);
  }, 60_000);
});

describe("hive init", () => {
  test("ignores the per-machine mirror and sync folders", async () => {
    const dir = repo("fresh");
    await fs.mkdir(dir, { recursive: true });
    const r = hive(["init", "--prefix", "FR", "--json"], { cwd: dir, env: env() });
    expect(r.code).toBe(0);
    const lines = (await fs.readFile(path.join(dir, ".gitignore"), "utf8")).split("\n");
    expect(lines).toContain(".hivemind/mirror/");
    expect(lines).toContain(".hivemind/sync/");
  }, 60_000);
});
