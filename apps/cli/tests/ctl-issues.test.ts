/** `hive ctl` issue verbs against a real temp workspace — asserts the JSON
 *  shapes match what the MCP tools returned (issueToJson etc.). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createIssue, writeConfig } from "@hivemind/core";
import { hive } from "./helpers.js";

let ws: string;
let xdg: string;
let id: string;
const env = () => ({ XDG_CONFIG_HOME: xdg, HIVE_AGENT_ID: "tester", HIVEMIND_TILE: undefined, HIVE_HCP_SOCK: undefined });

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

  test("set-state rejects an unknown state with exit 2 and a structured error", () => {
    const r = hive(["ctl", "set-state", id, "flying", "--json"], { cwd: ws, env: env() });
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ ok: false, code: "USAGE" });
  });

  test("add-comment → { ok, activity: last 3 }", () => {
    const r = hive(["ctl", "add-comment", id, "hello from ctl", "--json"], { cwd: ws, env: env() });
    expect(r.code).toBe(0);
    const j = r.json as { ok: boolean; activity: unknown[] };
    expect(j.ok).toBe(true);
    expect(j.activity.length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(j.activity)).toContain("hello from ctl");
  });

  test("mark-acceptance → { ok, criterion } and out-of-range is exit 2", () => {
    const r = hive(["ctl", "mark-acceptance", id, "1", "--json"], { cwd: ws, env: env() });
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ ok: true, criterion: { done: true, text: "comments land" } });
    const undo = hive(["ctl", "mark-acceptance", id, "1", "--undone", "--json"], { cwd: ws, env: env() });
    expect(undo.json).toEqual({ ok: true, criterion: { done: false, text: "comments land" } });
    const bad = hive(["ctl", "mark-acceptance", id, "9", "--json"], { cwd: ws, env: env() });
    expect(bad.code).toBe(2);
    expect(bad.json).toMatchObject({ ok: false, code: "USAGE" });
  });

  test("unknown issue id is exit 5 / not found", () => {
    const r = hive(["ctl", "add-comment", "TT-999", "x", "--json"], { cwd: ws, env: env() });
    expect(r.code).toBe(5);
    expect((r.json as { ok: boolean }).ok).toBe(false);
  });

  test("delete-issue → { ok, deleted }", () => {
    const r = hive(["ctl", "delete-issue", id, "--json"], { cwd: ws, env: env() });
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ ok: true, deleted: id });
    expect(hive(["show", id, "--json"], { cwd: ws, env: env() }).code).not.toBe(0);
  });

  test("list-workspaces is an array of {prefix,title,repo}", () => {
    const r = hive(["ctl", "list-workspaces", "--json"], { cwd: ws, env: env() });
    expect(r.code).toBe(0);
    expect(Array.isArray(r.json)).toBe(true);
    for (const w of r.json as Array<Record<string, unknown>>) expect(Object.keys(w).sort()).toEqual(["prefix", "repo", "title"]);
  });

  test("report outside a tile is a usage error, not a crash", () => {
    const r = hive(["ctl", "report", "done", "--json"], { cwd: ws, env: env() });
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ ok: false, code: "USAGE" });
  });

  test("app not running → exit 3 UNAVAILABLE", () => {
    const r = hive(["ctl", "list", "--json"], { cwd: ws, env: { ...env(), HIVE_HCP_SOCK: path.join(xdg, "nope.sock") } });
    expect(r.code).toBe(3);
    expect(r.json).toMatchObject({ ok: false, code: "UNAVAILABLE" });
  });
});
