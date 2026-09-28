// The workspace store: synchronous reads, debounced atomic writes, a one-time import of the
// layout saved before it existed, and change events that say who wrote.
import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore, recordFile, type WorkspaceChange } from "../src/store.ts";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-store-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readFile = (repo: string) => JSON.parse(fs.readFileSync(recordFile(dir, repo), "utf8"));
const core = (title: string) => ({ frames: [{ id: "f1", title }], tiles: [{ id: "t1", kind: "claude" }], tileNames: {}, editorTabs: {}, frameOf: { t1: "f1" } });

test("a workspace never written reads as empty", () => {
  const s = new WorkspaceStore({ dir, flushMs: 0 });
  expect(s.load("/repo")).toEqual({ core: null, views: {} });
  expect(s.getCore("/repo")).toBeNull();
  expect(s.getView("/repo", "canvas")).toBeNull();
  expect(fs.readdirSync(dir)).toEqual([]);
});

test("core and views round-trip, per repo, as copies", () => {
  const s = new WorkspaceStore({ dir, flushMs: 0 });
  const c = core("api");
  s.setCore("/a", c);
  s.setView("/a", "canvas", { v: 2, data: { positions: { t1: { x: 1, y: 2 } } } });
  c.frames[0]!.title = "changed after save";
  expect(s.getCore("/a")).toEqual(core("api"));
  expect(s.getView("/a", "canvas")).toEqual({ v: 2, data: { positions: { t1: { x: 1, y: 2 } } } });
  const loaded = s.load("/a") as { core: ReturnType<typeof core> };
  loaded.core.frames[0]!.title = "changed after load";
  expect((s.getCore("/a") as ReturnType<typeof core>).frames[0]!.title).toBe("api");
  expect(s.load("/b")).toEqual({ core: null, views: {} });
});

test("writes are debounced into one file write, then survive a new store", async () => {
  const s = new WorkspaceStore({ dir, flushMs: 30, now: () => 42 });
  s.setCore("/a", core("one"));
  s.setCore("/a", core("two"));
  s.setView("/a", "windows", { v: 1, data: { minimized: ["t1"] } });
  expect(fs.existsSync(recordFile(dir, "/a"))).toBe(false);
  await wait(80);
  expect(readFile("/a")).toEqual({ v: 1, repo: "/a", core: core("two"), views: { windows: { v: 1, data: { minimized: ["t1"] } } }, savedAt: 42 });
  const again = new WorkspaceStore({ dir });
  expect(again.load("/a")).toEqual({ core: core("two"), views: { windows: { v: 1, data: { minimized: ["t1"] } } } });
});

test("flush writes now; close writes what is pending and refuses more", () => {
  const s = new WorkspaceStore({ dir, flushMs: 10_000 });
  s.setCore("/a", core("x"));
  s.flush();
  expect(readFile("/a").core).toEqual(core("x"));
  s.setCore("/a", core("y"));
  s.close();
  expect(readFile("/a").core).toEqual(core("y"));
  expect(() => s.setCore("/a", core("z"))).toThrow("closed");
});

test("a write leaves no temp files, and files are private", () => {
  const s = new WorkspaceStore({ dir, flushMs: 0 });
  s.setCore("/a", core("x"));
  s.setCore("/b", core("y"));
  expect(fs.readdirSync(dir).sort()).toEqual([path.basename(recordFile(dir, "/a")), path.basename(recordFile(dir, "/b"))].sort());
  if (process.platform !== "win32") {
    expect(fs.statSync(recordFile(dir, "/a")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o077).toBe(0);
  }
});

test("an unreadable file is kept aside, reported, and the workspace starts empty", () => {
  fs.writeFileSync(recordFile(dir, "/a"), "{ not json");
  const warnings: string[] = [];
  const s = new WorkspaceStore({ dir, flushMs: 0, now: () => 7, onWarn: (m) => warnings.push(m) });
  expect(s.load("/a")).toEqual({ core: null, views: {} });
  expect(fs.existsSync(`${recordFile(dir, "/a")}.corrupt-7`)).toBe(true);
  expect(warnings.length).toBe(1);
  s.setCore("/a", core("fresh"));
  expect(readFile("/a").core).toEqual(core("fresh"));
});

test("a file that belongs to another repo is not trusted", () => {
  fs.writeFileSync(recordFile(dir, "/a"), JSON.stringify({ v: 1, repo: "/elsewhere", core: core("x"), views: {}, savedAt: 1 }));
  const s = new WorkspaceStore({ dir, flushMs: 0, onWarn: () => {} });
  expect(s.load("/a")).toEqual({ core: null, views: {} });
});

test("importing old layout fills only what is empty and never overwrites", () => {
  const s = new WorkspaceStore({ dir, flushMs: 0 });
  expect(s.importLegacy("/a", { core: core("old"), views: { canvas: { v: 2, data: { a: 1 } }, bogus: { nope: true }, "": { v: 1, data: 0 } } }))
    .toEqual({ core: true, views: ["canvas"] });
  expect(s.getCore("/a")).toEqual(core("old"));
  s.setCore("/a", core("new"));
  s.setView("/a", "canvas", { v: 2, data: { a: 2 } });
  expect(s.importLegacy("/a", { core: core("older"), views: { canvas: { v: 2, data: { a: 0 } }, windows: { v: 1, data: {} } } }))
    .toEqual({ core: false, views: ["windows"] });
  expect(s.getCore("/a")).toEqual(core("new"));
  expect(s.getView("/a", "canvas")).toEqual({ v: 2, data: { a: 2 } });
  expect(readFile("/a").views.windows).toEqual({ v: 1, data: {} });
});

test("every change is announced with its origin; a throwing listener breaks nothing", () => {
  const warnings: string[] = [];
  const s = new WorkspaceStore({ dir, flushMs: 0, onWarn: (m) => warnings.push(m) });
  const seen: WorkspaceChange[] = [];
  s.onChange(() => { throw new Error("boom"); });
  const off = s.onChange((c) => seen.push(c));
  s.setCore("/a", core("x"), "window-1");
  s.setView("/a", "canvas", { v: 1, data: {} });
  off();
  s.setCore("/a", core("y"));
  expect(seen).toEqual([{ repo: "/a", part: "core", origin: "window-1" }, { repo: "/a", part: "view", viewId: "canvas" }]);
  expect(warnings.length).toBe(3);
  expect(s.getCore("/a")).toEqual(core("y"));
});

test("bad input is refused", () => {
  const s = new WorkspaceStore({ dir, flushMs: 0 });
  expect(() => s.load("")).toThrow(TypeError);
  expect(() => s.setView("/a", "", { v: 1, data: {} })).toThrow(TypeError);
  expect(() => s.setView("/a", "canvas", { data: {} } as never)).toThrow(TypeError);
  expect(() => s.setView("/a", "canvas", { v: Number.NaN, data: {} })).toThrow(TypeError);
});

test("file names come from a hash, so any repo path is safe and distinct", () => {
  const a = recordFile(dir, "/Users/me/work/api");
  expect(recordFile(dir, "/Users/me/work/api")).toBe(a);
  expect(recordFile(dir, "/Users/me/work/api/")).not.toBe(a);
  expect(recordFile(dir, "ssh://me@host:22/srv/api")).toMatch(/^[\s\S]*[0-9a-f]{32}\.json$/);
  expect(path.dirname(recordFile(dir, "../../etc/passwd"))).toBe(dir);
});
