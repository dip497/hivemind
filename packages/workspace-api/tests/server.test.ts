// The workspace API's contract, as a client sees it over any transport: a method's result comes
// back; an error comes back thrown, with the code the host answered; a method with an effect is
// carried out through the host's intents and recorded as its caller's, and a read is not.
import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceClient } from "../src/client.ts";
import { WorkspaceServer, howMany, named, type Domain } from "../src/server.ts";
import { ApiError, text, texts } from "../src/protocol.ts";

let tmp: string;
let file: string;
const staged: string[] = [];
const agent = { kind: "tile", tile: "tile-codex-2" } as const;

/** A domain as a host has one: it checks its params, and stages into a list rather than a repo. */
const domain: Domain<"git.status" | "git.stage" | "git.pull"> = {
  answers: {
    "git.status": (repo) => ({ branch: text(repo, "repo"), upstream: null, ahead: 0, behind: 0, files: [], conflictedFiles: [], isMerging: false, isRebasing: false, head: "" }),
    "git.stage": (repo, files) => {
      text(repo, "repo");
      staged.push(...texts(files, "files"));
    },
    "git.pull": () => {
      throw Object.assign(new Error("not a fast-forward"), { code: "ENOTFF" });
    },
  },
  effects: {
    "git.stage": (repo, files) => ({ target: named(repo), detail: howMany(files, "file") }),
    "git.pull": (repo) => ({ target: named(repo) }),
  },
};

function clientAs(actor: { kind: "tile"; tile: string } | { kind: "person" }): WorkspaceClient {
  const server = new WorkspaceServer([domain], new Intents(new AuditLog({ file })));
  // What a transport does: the call goes out as JSON, and its answer comes back as JSON.
  return new WorkspaceClient({
    call: async (method, params) => JSON.parse(JSON.stringify(await server.answer(method, JSON.parse(JSON.stringify(params)), actor))),
  });
}
const audited = () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { const { at: _at, ...rest } = JSON.parse(l); return rest; }) : []);
const codeOf = (p: Promise<unknown>) => p.then(() => "answered", (e: unknown) => (e instanceof ApiError ? e.code : `not an ApiError: ${String(e)}`));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-api-"));
  file = path.join(tmp, "audit.jsonl");
  staged.length = 0;
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("a method's result comes back; an error comes back thrown with the host's code", async () => {
  const client = clientAs({ kind: "person" });
  expect((await client.call("git.status", "/repo")).branch).toBe("/repo");
  expect(await codeOf(client.call("git.status", ""))).toBe("BAD_REQUEST");
  expect(await codeOf(client.call("git.diff", "/repo", { kind: "working" }))).toBe("UNKNOWN_METHOD");
  const failed = await client.call("git.pull", "/repo").catch((e: ApiError) => e);
  expect(failed).toMatchObject({ code: "FAILED", message: "not a fast-forward (ENOTFF)" });
});

test("params that are not a list are a bad request, and nothing runs", async () => {
  const server = new WorkspaceServer([domain], new Intents(new AuditLog({ file })));
  expect(await server.answer("git.stage", { repo: "/repo", files: ["a"] }, agent)).toEqual({ error: { code: "BAD_REQUEST", message: "params must be a list" } });
  expect(staged).toEqual([]);
  expect(audited()).toEqual([]);
});

test("a method with an effect is recorded as its caller's, named from its params, and how it ended; a read is not recorded", async () => {
  const client = clientAs(agent);
  await client.call("git.status", "/repo");
  await client.call("git.stage", "/repo", ["a.txt", "b.txt"]);
  await client.call("git.pull", "/repo").catch(() => undefined);
  await client.call("git.stage", "/repo", [7 as unknown as string]).catch(() => undefined);
  expect(staged).toEqual(["a.txt", "b.txt"]);
  expect(audited()).toEqual([
    { actor: agent, verb: "git.stage", target: "/repo", detail: "2 files", outcome: "ok" },
    { actor: agent, verb: "git.pull", target: "/repo", outcome: "error", code: "ENOTFF" },
    { actor: agent, verb: "git.stage", target: "/repo", detail: "1 file", outcome: "error", code: "BAD_REQUEST" },
  ]);
});
