/** `hive ctl` issue verbs against a real temp workspace — asserts the JSON
 *  shapes match what the MCP tools returned (issueToJson etc.). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createIssue, readIssue, registerWorkspace, writeConfig } from "@hivemind/core";
import { hive } from "./helpers.js";

let ws: string;
let xdg: string;
let id: string;
const env = () => ({ XDG_CONFIG_HOME: xdg, HIVE_AGENT_ID: "tester", HIVEMIND_TILE: undefined, HIVE_HCP_SOCK: undefined, HIVE_DRIVE_SOCK: undefined });

beforeAll(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "hive-ctl-ws-"));
  xdg = await fs.mkdtemp(path.join(os.tmpdir(), "hive-ctl-xdg-"));
  const root = path.join(ws, ".hivemind");
  await fs.mkdir(path.join(root, "issues"), { recursive: true });
  await writeConfig(root, { prefix: "TT", next_id: 1, agents: {} } as never);
  const issue = await createIssue(root, {
    title: "Ship ctl parity",
    description: "so agents need one vocabulary",
    acceptanceCriteria: [{ done: false, text: "set-state works" }, { done: false, text: "comments land" }],
  });
  id = issue.id;
});
afterAll(async () => {
  await fs.rm(ws, { recursive: true, force: true });
  await fs.rm(xdg, { recursive: true, force: true });
});

describe("hive ctl issue verbs", () => {
  test("set-state returns the issueToJson shape and records the note", () => {
    const r = hive(["ctl", "set-state", id, "in_progress", "--note", "claiming", "--json"], { cwd: ws, env: env() });
    expect(r.code).toBe(0);
    const j = r.json as Record<string, unknown>;
    expect(Object.keys(j).sort()).toEqual(
      ["acceptanceCriteria", "activity", "assignee", "created", "description", "github", "id", "labels", "links", "parent", "state", "title", "updated"],
    );
    expect(j.id).toBe(id);
    expect(j.state).toBe("in_progress");
    const act = j.activity as Array<{ message: string; who?: string }>;
    expect(JSON.stringify(act)).toContain("claiming");
    expect(JSON.stringify(act)).toContain("tester");
  });

  test("hive update keeps frontmatter it doesn't name, and both --json shapes carry the tracker fields", async () => {
    const root = path.join(ws, ".hivemind");
    const mirrored = await createIssue(root, { title: "Mirrored", branch: "TT-2-mirrored" });
    const raw = await fs.readFile(mirrored.path, "utf8");
    await fs.writeFile(mirrored.path, raw.replace("\nupdated:", "\nexternal: { provider: jira, source: 'jira:acme/PAY', id: '10423', key: PAY-318 }\njira: { rank: '0|hz' }\nupdated:"));
    const up = hive(["update", mirrored.id, "--title", "Mirrored, renamed", "--json"], { cwd: ws, env: env() });
    expect([up.code, up.json]).toMatchObject([0, { title: "Mirrored, renamed", branch: "TT-2-mirrored", external: { key: "PAY-318" }, jira: { rank: "0|hz" } }]);
    const back = await readIssue(root, mirrored.id);
    expect([back.title, back.jira, back.external?.id]).toEqual(["Mirrored, renamed", { rank: "0|hz" }, "10423"]);
    const set = hive(["ctl", "set-state", mirrored.id, "in_review", "--json"], { cwd: ws, env: env() });
    expect([set.code, set.json]).toMatchObject([0, { state: "in_review", branch: "TT-2-mirrored", external: { key: "PAY-318", source: "jira:acme/PAY" } }]);
  });

  test("set-state rejects an unknown state with exit 2 and a structured error", () => {
    const r = hive(["ctl", "set-state", id, "flying", "--json"], { cwd: ws, env: env() });
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ error: { code: "USAGE" } });
  });

  test("add-comment → { activity: last 3 }", () => {
    const r = hive(["ctl", "add-comment", id, "hello from ctl", "--json"], { cwd: ws, env: env() });
    expect(r.code).toBe(0);
    const j = r.json as { activity: unknown[] };
    expect(j.activity.length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(j.activity)).toContain("hello from ctl");
  });

  test("mark-acceptance → { criterion } and out-of-range is exit 2", () => {
    const r = hive(["ctl", "mark-acceptance", id, "1", "--json"], { cwd: ws, env: env() });
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ criterion: { done: true, text: "comments land" } });
    const undo = hive(["ctl", "mark-acceptance", id, "1", "--undone", "--json"], { cwd: ws, env: env() });
    expect(undo.json).toEqual({ criterion: { done: false, text: "comments land" } });
    const bad = hive(["ctl", "mark-acceptance", id, "9", "--json"], { cwd: ws, env: env() });
    expect(bad.code).toBe(2);
    expect(bad.json).toMatchObject({ error: { code: "USAGE" } });
  });

  test("unknown issue id is exit 5 / not found", () => {
    const r = hive(["ctl", "add-comment", "TT-999", "x", "--json"], { cwd: ws, env: env() });
    expect(r.code).toBe(5);
    expect(r.json).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  test("delete-issue → { deleted }", () => {
    const r = hive(["ctl", "delete-issue", id, "--json"], { cwd: ws, env: env() });
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ deleted: id });
    expect(hive(["show", id, "--json"], { cwd: ws, env: env() }).code).not.toBe(0);
  });

  test("list-workspaces is { workspaces: [{prefix,title,repo}] }", () => {
    const r = hive(["ctl", "list-workspaces", "--json"], { cwd: ws, env: env() });
    expect(r.code).toBe(0);
    const { workspaces } = r.json as { workspaces: Array<Record<string, unknown>> };
    expect(Array.isArray(workspaces)).toBe(true);
    for (const w of workspaces) expect(Object.keys(w).sort()).toEqual(["prefix", "repo", "title"]);
  });

  test("list-workspaces prints each workspace's prefix, title and folder, one a line", async () => {
    const was = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try { await registerWorkspace(path.join(ws, ".hivemind")); } finally { if (was === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = was; }
    const r = hive(["ctl", "list-workspaces"], { cwd: ws, env: env() });
    expect([r.code, r.stdout]).toEqual([0, `TT\t${path.basename(ws)}\t${ws}\n`]);
  });

  test("hive list --json outside a tracker fails: exit 5 and {error:{code:NO_ROOT}} on stderr, nothing on stdout", () => {
    const r = hive(["list", "--json"], { cwd: xdg, env: env() });
    expect([r.code, r.stdout, JSON.parse(r.stderr)]).toEqual([5, "", { error: { code: "NO_ROOT", message: expect.stringContaining("no .hivemind/ found") } }]);
  });

  test("report outside a tile is a usage error, not a crash", () => {
    const r = hive(["ctl", "report", "done", "--json"], { cwd: ws, env: env() });
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ error: { code: "USAGE" } });
  });

  test("app not running → exit 3 UNAVAILABLE", () => {
    const r = hive(["ctl", "agents", "--json"], { cwd: ws, env: { ...env(), HIVE_DRIVE_SOCK: path.join(xdg, "nope.sock") } });
    expect(r.code).toBe(3);
    expect(r.json).toMatchObject({ error: { code: "UNAVAILABLE" } });
  });
});
