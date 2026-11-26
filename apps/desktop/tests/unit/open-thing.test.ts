import { test } from "node:test";
import assert from "node:assert/strict";
import { makeOpenThing } from "../../src/renderer/src/open-thing";

const sent: string[] = [];
const handed: string[] = [];
/** What main keeps as opened by the person. */
const kept: string[] = [];
/** Paths outside the workspace that are there, by what is asked: `~/` is read from home. */
const outside: Record<string, { kind: "file" | "folder"; size: number; path: string }> = {
  "/tmp/shots/crop2.png": { kind: "file", size: 5, path: "/tmp/shots/crop2.png" },
  "/tmp/shots/cosmos2.png": { kind: "file", size: 5, path: "/tmp/shots/cosmos2.png" },
  "/tmp/report.pdf": { kind: "file", size: 5, path: "/tmp/report.pdf" },
  "/tmp/notes.md": { kind: "file", size: 5, path: "/tmp/notes.md" },
  "/tmp/shots": { kind: "folder", size: 0, path: "/tmp/shots" },
  "~/shots/a.png": { kind: "file", size: 5, path: "/home/me/shots/a.png" },
  "/home/me/shots/a.png": { kind: "file", size: 5, path: "/home/me/shots/a.png" },
};
const on: Record<string, { kind: "file" | "folder"; size: number }> = { "src/a.ts": { kind: "file", size: 9 }, "shot.png": { kind: "file", size: 3 } };
(globalThis as { window?: unknown }).window = {
  hive: {
    fileStat: async (repo: string, rel: string) => on[repo === "/w" ? rel : `${repo}:${rel}`] ?? null,
    openPathInApp: async () => ({ ok: true }),
    openLinkOutside: async (url: string) => { sent.push(url); return { ok: true }; },
    outsideFileStat: async (path: string) => outside[path] ?? null,
    personOpensOutside: async (path: string) => { const at = outside[path] ?? null; if (at) kept.push(at.path); return at; },
    openOutsideInApp: async (path: string) => { handed.push(path); return { ok: true }; },
  },
  open: () => null,
};

function opener(answer: "once" | "always" | "cancel" = "cancel") {
  const opened: unknown[] = [];
  const kept: string[] = [];
  const open = makeOpenThing({
    links: () => ({ web: "system", files: "code", allowedSchemes: [] }),
    folderOf: (frameId) => (frameId === "f2" ? "/w-feature" : "/w"),
    folders: () => ["/w", "/w-feature"],
    frameFor: (folder) => (folder === "/w-feature" ? "f2" : folder === "/w" ? null : undefined),
    openUrl: (_f, url) => { opened.push(["url", url]); return "b1"; },
    openFile: (frame, path, at) => { opened.push(["file", frame, path, at]); return "e1"; },
    openImage: (_f, path) => { opened.push(["image", path]); return "i1"; },
    ask: async (scheme) => { opened.push(["asked", scheme]); return answer; },
    allowAlways: (scheme) => kept.push(scheme),
  });
  return { open, opened, kept };
}

test("a file opens in the frame's Code tile by its path there, its column counted from 0", async () => {
  const { open, opened } = opener();
  assert.deepEqual(await open("a.ts:4:7", { frameId: "f1", cwd: "/w/src" }), { to: "code", path: "/w/src/a.ts", line: 4, col: 7, tile: "e1" });
  assert.deepEqual(opened, [["file", "f1", "src/a.ts", { line: 4, col: 6 }]]);
});

test("a file not there is not opened, and says so", async () => {
  const { open, opened } = opener();
  await assert.rejects(open("/w/gone.ts:3", { frameId: null }), { code: "NOT_FOUND" });
  assert.deepEqual(opened, []);
});

test("what the app would ask about is refused, nothing opened", async () => {
  const { open, opened } = opener();
  await assert.rejects(open("/etc/passwd", { frameId: null }), { code: "UNSUPPORTED" });
  await assert.rejects(open("smb://box/share", { frameId: null }), { code: "UNSUPPORTED" });
  assert.deepEqual(opened, []);
});

test("a picture opens in the Image tile", async () => {
  const { open } = opener();
  assert.deepEqual(await open("shot.png", { frameId: null }), { to: "image", path: "/w/shot.png", tile: "i1" });
});

test("a file of another frame's folder opens in that frame, by its path there", async () => {
  const { open, opened } = opener();
  on["/w-feature:src/a.ts"] = { kind: "file", size: 1 };
  await open("/w-feature/src/a.ts:2", { frameId: "f1" });
  assert.deepEqual(opened, [["file", "f2", "src/a.ts", { line: 2 }]]);
});

test("a person's click on an unknown kind of link asks; an agent's or a view's is refused unasked", async () => {
  sent.length = 0;
  const always = opener("always");
  assert.deepEqual(await always.open("vscode://file/x", { frameId: null, person: true }), { to: "system-browser", url: "vscode://file/x" });
  assert.deepEqual([always.opened, always.kept, sent], [[["asked", "vscode"]], ["vscode"], ["vscode://file/x"]]);
  const cancel = opener("cancel");
  await assert.rejects(cancel.open("vscode://file/x", { frameId: null, person: true }), { code: "UNSUPPORTED", quiet: true });
  const agent = opener("once");
  await assert.rejects(agent.open("vscode://file/x", { frameId: null }), { code: "UNSUPPORTED" });
  assert.deepEqual([agent.opened, sent.length], [[], 1]);
});

test("a person's click outside the workspace opens a picture, a text file and the rest in their places; an agent's or a view's is refused", async () => {
  kept.length = 0; handed.length = 0;
  const agent = opener();
  for (const p of ["/tmp/shots/crop2.png", "/tmp/notes.md:3", "/tmp/report.pdf", "/tmp/shots"]) {
    await assert.rejects(agent.open(p, { frameId: "f1" }), { code: "UNSUPPORTED" });
  }
  assert.deepEqual([agent.opened, kept, handed], [[], [], []]);
  const person = opener();
  const by = { frameId: "f1", person: true };
  assert.deepEqual(await person.open("/tmp/shots/crop2.png", by), { to: "image", path: "/tmp/shots/crop2.png", tile: "i1" });
  assert.deepEqual(await person.open("/tmp/notes.md:3:2", by), { to: "code", path: "/tmp/notes.md", line: 3, col: 2, tile: "e1" });
  assert.deepEqual(await person.open("/tmp/report.pdf", by), { to: "os", path: "/tmp/report.pdf" });
  assert.deepEqual(await person.open("/tmp/shots", by), { to: "os", path: "/tmp/shots" });
  assert.deepEqual(await person.open("~/shots/a.png", by), { to: "image", path: "/home/me/shots/a.png", tile: "i1" });
  await assert.rejects(person.open("/tmp/gone.pdf", by), { code: "NOT_FOUND", message: "nothing at /tmp/gone.pdf" });
  assert.deepEqual(person.opened, [["image", "/tmp/shots/crop2.png"], ["file", "f1", "/tmp/notes.md", { line: 3, col: 1 }], ["image", "/home/me/shots/a.png"]]);
  assert.deepEqual([kept, handed], [["/tmp/shots/crop2.png", "/tmp/notes.md", "/tmp/report.pdf", "/tmp/shots", "/home/me/shots/a.png"], ["/tmp/report.pdf", "/tmp/shots"]]);
});

test("a path run on to the next line opens whole when it is there, else the part on the clicked line", async () => {
  const { open, opened } = opener();
  assert.deepEqual(await open("/tmp/shots/cosmos2.png", { frameId: null, person: true, orElse: "mos2.png" }), { to: "image", path: "/tmp/shots/cosmos2.png", tile: "i1" });
  assert.deepEqual(await open("/tmp/shots/crop2.pngDone", { frameId: null, person: true, orElse: "/tmp/shots/crop2.png" }), { to: "image", path: "/tmp/shots/crop2.png", tile: "i1" });
  assert.deepEqual(await open("src/a.tsx", { frameId: null, cwd: "/w", person: true, orElse: "src/a.ts" }), { to: "code", path: "/w/src/a.ts", tile: "e1" });
  assert.deepEqual(opened, [["image", "/tmp/shots/cosmos2.png"], ["image", "/tmp/shots/crop2.png"], ["file", null, "src/a.ts", undefined]]);
});
