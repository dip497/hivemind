// Driving agents from another of the person's devices (agent-control.ts, spec/agents.md): what may
// be started in a workspace, starting one with what was asked for and nothing else, interrupting its
// turn with its manifest's keys only while it works or waits, closing it, and what it changed in
// the folder it runs in (agent-diff.ts), read from a real git repository.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentProviderDef } from "@hivemind/agents";
import { KEY_GAP_MS } from "@hivemind/agent-host/keys";
import type { CoreLayout } from "@hivemind/workspace-doc/shapes";
import { agentControl, PROMPT_MAX, type Start } from "../src/agent-control.ts";
import { PATCH_MAX } from "../src/agent-diff.ts";
import { WorkspaceServer } from "@hivemind/workspace-api/server";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-agent-control-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BOX = "b0".repeat(32);

const claude = {
  id: "claude", label: "Claude Code", bin: "claude", enabled: true,
  options: [
    { id: "mode", label: "Permission mode", flag: "--permission-mode", values: { plan: ["--permission-mode", "plan"] }, default: "default" },
    { id: "model", label: "Model", flag: "--model" },
    { id: "effort", label: "Effort", flag: "--effort" },
  ],
} as unknown as AgentProviderDef;

/** A device holding one workspace, at `repo`, whose agents its options act on as recorded. */
function device(repo = "/home/p/api") {
  const core: CoreLayout = {
    frames: [
      { id: "f-api", title: "api", workspacePath: repo },
      { id: "f-box", title: "on the box", workspacePath: `machine://${BOX}/srv/api` },
    ],
    tiles: [{ id: "t1", kind: "claude", label: "Claude" }],
  } as CoreLayout;
  const started: Array<{ repo: string; start: Start }> = [];
  const typed: Array<{ tile: string; data: string; at: number }> = [];
  const state = { now: "working" as string, terminal: true, keys: ["escape"] as string[] | undefined, folder: repo as string | null };
  const domain = agentControl({
    programs: async () => [claude],
    core: (r) => (r === repo ? core : null),
    machines: { self: () => ({ device: "d1".repeat(32), name: "desk" }), mine: (d) => (d === BOX ? "build-box" : undefined), whose: () => undefined, saved: () => undefined },
    start: async (r, start) => { started.push({ repo: r, start }); return "t9"; },
    status: (tile) => (tile === "t1" ? { state: state.now } : undefined),
    interruptKeys: () => state.keys,
    type: (tile, data) => { typed.push({ tile, data, at: Date.now() }); return state.terminal; },
    close: async (tile) => tile === "t1",
    folderOf: (tile) => (tile === "t1" ? state.folder : null),
  });
  const from = {} as never;
  const call = (method: keyof typeof domain.answers, ...params: unknown[]) => (domain.answers[method] as (f: never, ...p: unknown[]) => unknown)(from, ...params);
  return { repo, started, typed, state, call, domain };
}

/** `asked` is refused as a bad request saying `pattern`. */
const refused = async (asked: () => unknown, pattern: RegExp) =>
  assert.rejects(Promise.resolve().then(asked), (e: Error & { code?: string }) => e.code === "BAD_REQUEST" && pattern.test(e.message));

test("what may be started: the agents this device starts with their model and mode choices, and the workspace's frames on the machine each one's folder is on", async () => {
  const d = device();
  assert.deepEqual(await d.call("agent.startable", d.repo), {
    programs: [{ id: "claude", label: "Claude Code", options: [
      { id: "mode", label: "Permission mode", values: ["plan", "default"] },
      { id: "model", label: "Model", values: [] },
    ] }],
    frames: [{ id: "f-api", name: "api", machine: "desk" }, { id: "f-box", name: "on the box", machine: "build-box" }],
  });
  await refused(() => d.call("agent.startable", "/home/p/elsewhere"), /no such workspace/);
});

test("starting asks for what was given, checked: an agent this device starts, one of the workspace's frames, a prompt of at most 10,000 characters with no control characters but newlines and tabs, and lines for model and mode", async () => {
  const d = device();
  assert.deepEqual(await d.call("agent.start", d.repo, { program: "claude", frame: "f-box", prompt: "fix the nav\n\tthen test it", model: "opus", mode: "plan" }), { tile: "t9" });
  assert.deepEqual(await d.call("agent.start", d.repo, { program: "claude", prompt: "", model: "", mode: null }), { tile: "t9" });
  assert.deepEqual(d.started, [
    { repo: d.repo, start: { program: "claude", frame: "f-box", prompt: "fix the nav\n\tthen test it", model: "opus", mode: "plan" } },
    { repo: d.repo, start: { program: "claude" } },
  ]);
  await refused(() => d.call("agent.start", d.repo, { program: "codex" }), /not an agent this device starts/);
  await refused(() => d.call("agent.start", d.repo, { program: "claude", frame: "f-gone" }), /no frame f-gone/);
  await refused(() => d.call("agent.start", d.repo, { program: "claude", prompt: "x".repeat(PROMPT_MAX + 1) }), /at most 10000 characters/);
  await refused(() => d.call("agent.start", d.repo, { program: "claude", prompt: "go\x1b[2J" }), /no control characters/);
  await refused(() => d.call("agent.start", d.repo, { program: "claude", model: "opus\n--dangerously-skip-permissions" }), /one line/);
  await refused(() => d.call("agent.start", d.repo, { program: "claude", mode: "y".repeat(201) }), /one line of at most 200/);
  await refused(() => d.call("agent.start", d.repo, "claude"), /start must be an object/);
  await refused(() => d.call("agent.start", "/home/p/elsewhere", { program: "claude" }), /no such workspace/);
  assert.equal(d.started.length, 2, "nothing refused was started");
});

test("an agent's turn is interrupted with its manifest's keys, a moment apart, only while it works or waits; one whose manifest says none is refused, and one with no terminal was not interrupted", async () => {
  const d = device();
  d.state.keys = ["escape", "ctrl-c"];
  assert.deepEqual(await d.call("agent.interrupt", "hm:t1"), { interrupted: true });
  await wait(KEY_GAP_MS * 3);
  assert.deepEqual(d.typed.map(({ tile, data }) => ({ tile, data })), [{ tile: "t1", data: "\x1b" }, { tile: "t1", data: "\x03" }]);
  assert.ok(d.typed[1]!.at - d.typed[0]!.at >= KEY_GAP_MS - 5, "the second key a moment after the first");
  d.typed.length = 0;
  d.state.now = "waiting";
  assert.deepEqual(await d.call("agent.interrupt", "t1"), { interrupted: true });
  for (const now of ["idle", "done", "exited"]) {
    d.state.now = now;
    assert.deepEqual(await d.call("agent.interrupt", "t1"), { interrupted: false }, now);
  }
  d.state.now = "working";
  d.state.terminal = false;
  assert.deepEqual(await d.call("agent.interrupt", "t1"), { interrupted: false });
  d.state.keys = undefined;
  await refused(() => d.call("agent.interrupt", "t1"), /no keys that interrupt/);
});

test("closing an agent says whether a workspace here had it", async () => {
  const d = device();
  assert.deepEqual(await d.call("agent.close", "hm:t1"), { closed: true });
  assert.deepEqual(await d.call("agent.close", "t7"), { closed: false });
});

/** A git repository with one commit of `files`. */
function repoWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(tmp, "repo-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Priya", "-c", "user.email=priya@example.com", ...args], { cwd: dir });
  git("init", "-q", "-b", "main");
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
  git("add", ".");
  git("commit", "-q", "-m", "first");
  return dir;
}

test("what an agent changed in the folder it runs in: each file with its status and the lines the patch adds and removes in it, and the patch, a new file in it whole", async () => {
  const folder = repoWith({ "nav.ts": "one\ntwo\nthree\n", "old.ts": "gone\n" });
  fs.writeFileSync(path.join(folder, "nav.ts"), "one\n2\nthree\nfour\n");
  fs.rmSync(path.join(folder, "old.ts"));
  fs.writeFileSync(path.join(folder, "new.ts"), "hello\nworld\n");
  fs.writeFileSync(path.join(folder, "blob.bin"), Buffer.from([0, 1, 2]));
  const d = device(folder);
  const changes = (await d.call("agent.diff", "t1")) as { files: unknown[]; patch: string; truncated: boolean };
  const byPath = (files: unknown[]) => [...(files as Array<{ path: string }>)].sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(byPath(changes.files), [
    { path: "blob.bin", status: "?", added: 0, removed: 0 },
    { path: "nav.ts", status: "M", added: 2, removed: 1 },
    { path: "new.ts", status: "?", added: 2, removed: 0 },
    { path: "old.ts", status: "D", added: 0, removed: 1 },
  ]);
  assert.match(changes.patch, /^diff --git a\/nav\.ts b\/nav\.ts\n/m);
  assert.match(changes.patch, /^-two\n\+2\n/m);
  assert.match(changes.patch, /diff --git a\/new\.ts b\/new\.ts\nnew file mode 100644\n--- \/dev\/null\n\+\+\+ b\/new\.ts\n@@ -0,0 \+1,2 @@\n\+hello\n\+world\n/);
  assert.doesNotMatch(changes.patch, /blob\.bin/, "a file that is not text is listed, not shown");
  assert.equal(changes.truncated, false);
});

test("a patch past 512 KiB is cut at the end of a line and says so; a folder that is no git repository changed nothing; one on another machine, or no agent here, is refused", async () => {
  const folder = repoWith({ "big.txt": "" });
  fs.writeFileSync(path.join(folder, "big.txt"), `${"a line of the file\n".repeat(40_000)}`);
  const d = device(folder);
  const big = (await d.call("agent.diff", "t1")) as { patch: string; truncated: boolean };
  assert.equal(big.truncated, true);
  assert.ok(Buffer.byteLength(big.patch) <= PATCH_MAX && Buffer.byteLength(big.patch) > PATCH_MAX - 100);
  assert.ok(big.patch.endsWith("\n"));

  // A repository with no commit yet: every file in it is new.
  const fresh = fs.mkdtempSync(path.join(tmp, "fresh-"));
  execFileSync("git", ["init", "-q"], { cwd: fresh });
  fs.writeFileSync(path.join(fresh, "a.ts"), "one\n");
  d.state.folder = fresh;
  const first = (await d.call("agent.diff", "t1")) as { files: unknown[]; patch: string };
  assert.deepEqual(first.files, [{ path: "a.ts", status: "?", added: 1, removed: 0 }]);
  assert.match(first.patch, /^\+one$/m);

  const plain = fs.mkdtempSync(path.join(tmp, "plain-"));
  d.state.folder = plain;
  assert.deepEqual(await d.call("agent.diff", "t1"), { files: [], patch: "", truncated: false });
  d.state.folder = `machine://${BOX}/srv/api`;
  await assert.rejects(Promise.resolve().then(() => d.call("agent.diff", "t1")), (e: Error & { code?: string }) => e.code === "FAILED" && /another machine/.test(e.message));
  await refused(() => d.call("agent.diff", "t7"), /no such agent/);
});

test("starting, interrupting and closing an agent from another device is recorded against its tile as that device; seeing what may be started, or what an agent changed, is not", async () => {
  const d = device();
  const audit = path.join(tmp, `audit-${Date.now()}.jsonl`);
  const server = new WorkspaceServer([d.domain], new Intents(new AuditLog({ file: audit })));
  const phone = { kind: "peer", person: "p".repeat(64), device: "d".repeat(64), access: "owner" } as const;
  const from = { actor: phone, send: () => {}, closed: new AbortController().signal };
  for (const [method, params] of [
    ["agent.startable", [d.repo]], ["agent.start", [d.repo, { program: "claude" }]], ["agent.interrupt", ["hm:t1"]], ["agent.close", ["hm:t1"]],
  ] as const) {
    assert.ok("result" in (await server.answer(method, params, from)), method);
  }
  const records = fs.readFileSync(audit, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { verb: string; target?: string; actor: unknown });
  assert.deepEqual(records.map(({ verb, target, actor }) => ({ verb, target, actor })), [
    { verb: "agent.start", target: "t9", actor: phone },
    { verb: "agent.interrupt", target: "t1", actor: phone },
    { verb: "agent.close", target: "t1", actor: phone },
  ]);
});
