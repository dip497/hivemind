// frame.open and frame.close: a frame for a folder of the workspace or for a worktree of it on a
// branch, found again by its folder; closed with its tiles and its worktree only when asked.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceStore } from "@hivemind/workspace-host/store";
import { newSeed } from "@hivemind/workspace-host/identity";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import { framesDomain } from "../src/frames.ts";
import { worktreeCreate, worktreeList, worktreeRemove } from "../src/git-adapter.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-frames-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const repo = path.join(tmp, "api");
const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
git("init", "-q", "-b", "main");
git("commit", "-q", "--allow-empty", "-m", "first");
git("checkout", "-q", "-b", "other");
git("commit", "-q", "--allow-empty", "-m", "on other");
const otherHead = git("rev-parse", "HEAD");
git("checkout", "-q", "main");

const store = new WorkspaceStore({ dir: path.join(tmp, "store"), person: newSeed() });
store.setCore(repo, { frames: [{ id: "own", title: "api", workspacePath: repo }], tiles: [{ id: "t1", kind: "shell", label: "sh" }], tileNames: {}, editorTabs: {}, frameOf: {} } as never, {});
const closed: string[] = [];
const server = new WorkspaceServer([framesDomain({ store: () => store, worktreeList, worktreeCreate, worktreeRemove, closeTile: (bare) => { closed.push(bare); }, machines: () => [{ id: "m-1", name: "build" }] })], new Intents(new AuditLog({ file: path.join(tmp, "audit.jsonl") })));
const as = (actor: Connection["actor"]): Connection => ({ actor, send: () => {}, closed: new AbortController().signal });
const person = as({ kind: "person" });
const program = as({ kind: "peer", person: "client:1", device: "client:1", access: "agents", client: "bot" });
const call = async (from: Connection, method: string, ...params: unknown[]) => server.answer(method, params, from);
const result = <T>(a: Awaited<ReturnType<typeof call>>): T => {
  if ("error" in a) throw new Error(`${a.error.code}: ${a.error.message}`);
  return a.result as T;
};

test("a worktree frame is made on a new branch from its base, nested in the workspace's own frame, and opening it again gives the same frame", async () => {
  const first = result<{ frame: string; path: string; opened: boolean; created: boolean }>(await call(program, "frame.open", repo, { worktree: { branch: "fix-1", base: "other" } }));
  assert.equal(first.opened, true);
  assert.equal(first.created, true);
  assert.equal(execFileSync("git", ["-C", first.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), otherHead);
  const frame = store.getCore(repo)!.frames.find((f) => f.id === first.frame)!;
  assert.deepEqual({ parent: frame.parentFrameId, branch: frame.branch, worktreePath: frame.worktreePath, title: frame.title }, { parent: "own", branch: "fix-1", worktreePath: first.path, title: "fix-1" });
  const again = result<typeof first>(await call(program, "frame.open", repo, { worktree: { branch: "fix-1", base: "other" } }));
  assert.deepEqual(again, { frame: first.frame, path: first.path, opened: false, created: false });
});

test("a folder on another machine runs as the person there: a program may not open a frame on it, the person may", async () => {
  const refused = await call(program, "frame.open", repo, { path: "/srv/api", machine: "build" });
  assert.equal("error" in refused && refused.error.code, "FORBIDDEN");
  assert.equal(result<{ path: string }>(await call(person, "frame.open", repo, { path: "/srv/api", machine: "build" })).path, "machine://m-1/srv/api");
});

test("a folder of the workspace gets a frame of its own, found again by the folder; a program may not name one outside it, the person may", async () => {
  const docs = path.join(repo, "docs");
  const first = result<{ frame: string; opened: boolean }>(await call(program, "frame.open", repo, { path: docs }));
  assert.equal(first.opened, true);
  assert.equal(result<{ frame: string }>(await call(program, "frame.open", repo, { path: docs })).frame, first.frame);
  const outside = await call(program, "frame.open", repo, { path: tmp });
  assert.equal("error" in outside && outside.error.code, "FORBIDDEN");
  assert.equal(result<{ opened: boolean }>(await call(person, "frame.open", repo, { path: tmp })).opened, true);
});

test("a frame holding tiles closes only when asked to close them; its worktree goes only when asked, and git keeps one with changes", async () => {
  const wt = result<{ frame: string; path: string }>(await call(person, "frame.open", repo, { worktree: { branch: "fix-2" } }));
  store.setCore(repo, { ...store.getCore(repo)!, frameOf: { t1: wt.frame } }, {});
  const holding = await call(person, "frame.close", repo, wt.frame);
  assert.equal("error" in holding && holding.error.code, "BAD_REQUEST");

  fs.writeFileSync(path.join(wt.path, "dirty.txt"), "x");
  const dirty = await call(person, "frame.close", repo, wt.frame, { closeTiles: true, removeWorktree: true });
  assert.ok("error" in dirty, "git refuses to remove a worktree with changes");
  assert.ok(store.getCore(repo)!.frames.some((f) => f.id === wt.frame), "and the frame stays");
  assert.deepEqual(closed, [], "and its tiles stay");

  fs.rmSync(path.join(wt.path, "dirty.txt"));
  const done = result<{ closed: string[]; tilesClosed: number; worktreeRemoved: boolean }>(await call(person, "frame.close", repo, wt.frame, { closeTiles: true, removeWorktree: true }));
  assert.deepEqual(done, { closed: [wt.frame], tilesClosed: 1, worktreeRemoved: true });
  assert.deepEqual(closed, ["t1"]);
  assert.equal(fs.existsSync(wt.path), false);
  assert.equal(store.getCore(repo)!.frames.some((f) => f.id === wt.frame), false);
});

test("closing a frame without removeWorktree keeps the worktree on disk", async () => {
  const wt = result<{ frame: string; path: string }>(await call(person, "frame.open", repo, { worktree: { branch: "fix-3" } }));
  result(await call(person, "frame.close", repo, wt.frame));
  assert.equal(fs.existsSync(wt.path), true);
});

test("a workspace open with nothing saved yet takes a frame; a folder that is no workspace here takes none", async () => {
  const fresh = path.join(tmp, "fresh");
  fs.mkdirSync(fresh);
  assert.equal(store.getCore(fresh), null, "a window opened it, and saved nothing yet");
  const opened = result<{ frame: string; opened: boolean }>(await call(person, "frame.open", fresh, { path: fresh }));
  assert.equal(opened.opened, true);
  assert.ok(store.getCore(fresh)!.frames.some((f) => f.id === opened.frame));
  const none = await call(person, "frame.open", path.join(tmp, "nowhere"), { path: tmp });
  assert.equal("error" in none && none.error.code, "NOT_FOUND");
});
