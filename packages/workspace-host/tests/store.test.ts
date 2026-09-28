// The workspace store through its public API, against a real directory: what it keeps, the file
// format existing installs depend on, what it refuses, and what it does when the disk fails.
import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore } from "../src/store.ts";

let tmp: string;
let dir: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-store-"));
  dir = path.join(tmp, "workspaces");
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const core = (title: string) => ({ frames: [{ id: "f1", title }], tiles: [{ id: "t1", kind: "claude" }], frameOf: { t1: "f1" } });
const restart = () => new WorkspaceStore({ dir });

// The file for repo "/work/api": the first 32 hex digits of sha256("/work/api"). Files already on
// users' disks are found by this name, so it is spelled out here rather than computed.
const API_FILE = "c24c3b6218aa37d36397127da76a9abd.json";

test("a workspace's layout is kept per repo and is there after a restart", () => {
  const s = new WorkspaceStore({ dir });
  s.setCore("/a", core("api"));
  s.setView("/a", "canvas", { v: 2, data: { positions: { t1: { x: 1, y: 2 } } } });

  const again = restart();
  expect(again.getCore("/a")).toEqual(core("api"));
  expect(again.getView("/a", "canvas")).toEqual({ v: 2, data: { positions: { t1: { x: 1, y: 2 } } } });
  expect(again.getView("/a", "windows")).toBeNull();
  expect(again.getCore("/b")).toBeNull();
});

test("what callers give and get are copies, so changing one changes nothing stored", () => {
  const s = new WorkspaceStore({ dir });
  const given = core("api");
  s.setCore("/a", given);
  given.frames[0]!.title = "changed after set";
  const got = s.getCore("/a") as ReturnType<typeof core>;
  got.frames[0]!.title = "changed after get";
  expect(s.getCore("/a")).toEqual(core("api"));
  expect(restart().getCore("/a")).toEqual(core("api"));
});

test("a file in the current format, under its hashed name, loads", () => {
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, API_FILE), JSON.stringify({
    v: 1, repo: "/work/api", core: core("from disk"), views: { canvas: { v: 2, data: { zoom: 1 } } },
  }));
  const s = new WorkspaceStore({ dir });
  expect(s.getCore("/work/api")).toEqual(core("from disk"));
  expect(s.getView("/work/api", "canvas")).toEqual({ v: 2, data: { zoom: 1 } });
});

test("files are private, leave no temp files, and stay inside the directory whatever the repo", () => {
  const s = new WorkspaceStore({ dir });
  s.setCore("/a", core("x"));
  s.setCore("../../escape", core("y"));
  const files = fs.readdirSync(dir);
  expect(files).toHaveLength(2);
  expect(files.every((f) => /^[0-9a-f]{32}\.json$/.test(f))).toBe(true);
  if (process.platform !== "win32") {
    for (const f of files) expect(fs.statSync(path.join(dir, f)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o077).toBe(0);
  }
});

test.each([
  ["not JSON", "{ not json"],
  ["another format version", JSON.stringify({ v: 2, repo: "/work/api", core: core("x"), views: {} })],
  ["another repo's record", JSON.stringify({ v: 1, repo: "/elsewhere", core: core("x"), views: {} })],
])("a file that is %s is set aside, reported, and the workspace starts empty", (_name, content) => {
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, API_FILE), content);
  const warnings: string[] = [];
  const s = new WorkspaceStore({ dir, onWarn: (m) => warnings.push(m) });

  expect(s.getCore("/work/api")).toBeNull();
  expect(warnings).toHaveLength(1);
  const aside = fs.readdirSync(dir).filter((f) => f.startsWith(`${API_FILE}.corrupt-`));
  expect(aside).toHaveLength(1);
  expect(fs.readFileSync(path.join(dir, aside[0]!), "utf8")).toBe(content);

  s.setCore("/work/api", core("fresh"));
  expect(restart().getCore("/work/api")).toEqual(core("fresh"));
});

test("an old layout is imported only where the store has nothing, and never replaces what it has", () => {
  const s = new WorkspaceStore({ dir });
  s.importLegacy("/a", { core: core("old"), views: { canvas: { v: 2, data: 1 }, bogus: { nope: true } } });
  expect(s.getCore("/a")).toEqual(core("old"));
  expect(s.getView("/a", "canvas")).toEqual({ v: 2, data: 1 });
  expect(s.getView("/a", "bogus")).toBeNull();

  s.setCore("/a", core("new"));
  s.setView("/a", "canvas", { v: 2, data: 2 });
  s.importLegacy("/a", { core: core("older"), views: { canvas: { v: 2, data: 0 }, windows: { v: 1, data: {} } } });

  const again = restart();
  expect(again.getCore("/a")).toEqual(core("new"));
  expect(again.getView("/a", "canvas")).toEqual({ v: 2, data: 2 });
  expect(again.getView("/a", "windows")).toEqual({ v: 1, data: {} });
});

test("bad input is refused with a TypeError and stores nothing", () => {
  const s = new WorkspaceStore({ dir });
  const bad: Array<() => unknown> = [
    () => s.setCore("", core("x")),
    () => s.setCore(42 as never, core("x")),
    () => s.getCore(undefined as never),
    () => s.getView("/a", ""),
    () => s.setView("/a", "x".repeat(257), { v: 1, data: {} }),
    () => s.setView("/a", "canvas", { data: {} } as never),
    () => s.setView("/a", "canvas", { v: Number.NaN, data: {} }),
    () => s.importLegacy("/a", null as never),
  ];
  for (const call of bad) expect(call).toThrow(TypeError);
  expect(fs.existsSync(dir)).toBe(false);
});

test("a write the disk refuses is kept, reported, and written by flush once it can be", () => {
  const blocker = path.join(tmp, "blocked");
  fs.writeFileSync(blocker, "a file where the store's directory should be");
  const blockedDir = path.join(blocker, "workspaces");
  const warnings: string[] = [];
  const s = new WorkspaceStore({ dir: blockedDir, onWarn: (m) => warnings.push(m) });

  s.setCore("/a", core("kept"));
  expect(warnings).toHaveLength(1);
  expect(s.getCore("/a")).toEqual(core("kept"));

  fs.rmSync(blocker);
  s.flush();
  expect(new WorkspaceStore({ dir: blockedDir }).getCore("/a")).toEqual(core("kept"));
});
