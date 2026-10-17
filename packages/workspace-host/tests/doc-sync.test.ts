// A workspace's document between its host and a replica (doc-sync.ts, design §4.3): a replica
// catches up when it connects, each side's changes reach the other as they are made, a viewer's
// changes never reach the host, and a replica that connects again gets what it missed.
import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore, type WorkspaceChange } from "../src/store.ts";
import { writeBoard } from "./board.ts";
import { changeHub, parseSync, replicate, serveReplica, type SyncChannel } from "../src/doc-sync.ts";
import type { Access } from "../src/access.ts";
import { newSeed } from "../src/identity.ts";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doc-sync-")); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const core = (title: string) => ({ frames: [{ id: "f1", title }], tiles: [{ id: "t1", kind: "claude" }], tileNames: {}, editorTabs: {}, frameOf: { t1: "f1" } });
const note = (text: string) => ({ id: "n1", kind: "widget" as const, widget: "note", placement: "board" as const, x: 10, y: 20, w: 200, h: 160, text });

/** A store that tells a set of listeners of its changes. */
function storeWith(dir: string, person?: Uint8Array) {
  const listeners = new Set<(c: WorkspaceChange) => void>();
  const store = new WorkspaceStore({ dir: path.join(tmp, dir), person, onChange: (c) => { for (const l of listeners) l(c); } });
  const changes = (l: (c: WorkspaceChange) => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
  return { store, changes };
}
/** Room on a channel's link, there always unless `full`; `free` gives it back. */
function linkRoom() {
  let full = false;
  const waiting = new Set<() => void>();
  return {
    fill: () => { full = true; },
    free: () => { full = false; const told = [...waiting]; waiting.clear(); for (const l of told) l(); },
    hasRoom: () => !full,
    whenRoom: (l: () => void) => { waiting.add(l); if (!full) queueMicrotask(() => { if (waiting.delete(l)) l(); }); return () => { waiting.delete(l); }; },
  };
}
/** Two ends of a channel (frames delivered in order, at once), on a link with `room`. */
function channel(room = linkRoom()): [SyncChannel, SyncChannel] {
  const a = new Set<(t: string) => void>();
  const b = new Set<(t: string) => void>();
  const { hasRoom, whenRoom } = room;
  return [
    { send: (t) => { for (const l of b) l(t); }, on: (l) => { a.add(l); return () => { a.delete(l); }; }, hasRoom, whenRoom },
    { send: (t) => { for (const l of a) l(t); }, on: (l) => { b.add(l); return () => { b.delete(l); }; }, hasRoom, whenRoom },
  ];
}
/** Connect a replica of `/a` to the host, as a peer with `access`: the host answers its hello. */
function connect(host: ReturnType<typeof storeWith>, guest: ReturnType<typeof storeWith>, access: Access, dropped: string[] = []) {
  const [h, g] = channel();
  let stopHost = () => {};
  const off = h.on((text) => {
    const m = parseSync(text);
    if (m?.t !== "hello") return;
    off();
    stopHost = serveReplica(host.store, "/a", h, { seen: m.seen, access, changes: host.changes, writer: "peer:priya", onDropped: (w) => dropped.push(w) });
  });
  const welcomed: Access[] = [];
  const stopGuest = replicate(guest.store, "hive://w", g, { workspace: "w", changes: guest.changes, onWelcome: (a) => welcomed.push(a) });
  return { welcomed, stop: () => { stopGuest(); stopHost(); } };
}

test("a replica catches up when it connects, and each side's changes reach the other as they are made", () => {
  const host = storeWith("host", newSeed());
  const guest = storeWith("shared");
  host.store.setCore("/a", core("api"));
  const { welcomed } = connect(host, guest, "edit");
  expect(welcomed).toEqual(["edit"]);
  expect(guest.store.getCore("hive://w")).toEqual(core("api"));

  writeBoard(guest.store, "hive://w", [note("from the guest")], { writer: "window" });
  expect(host.store.getObjects("/a")).toEqual([note("from the guest")]);
  host.store.setView("/a", "canvas", { v: 2, data: { positions: { t1: { x: 5, y: 6 } } } });
  expect(guest.store.getView("hive://w", "canvas")).toEqual({ v: 2, data: { positions: { t1: { x: 5, y: 6 } } } });
  // Neither side has anything the other lacks.
  expect(guest.store.version("hive://w")).toEqual(host.store.version("/a"));
});

test("a viewer's changes never reach the host", () => {
  const host = storeWith("host", newSeed());
  const guest = storeWith("shared");
  host.store.setCore("/a", core("api"));
  const dropped: string[] = [];
  connect(host, guest, "view", dropped);
  writeBoard(guest.store, "hive://w", [note("not mine to write")], { writer: "window" });
  expect(host.store.getObjects("/a")).toEqual([]);
  expect(dropped).toEqual(["a viewer's change"]);
  // The host's own changes still reach the viewer.
  host.store.setCore("/a", core("api, renamed"));
  expect(guest.store.getCore("hive://w")).toEqual(core("api, renamed"));
});

test("a replica that connects again gets what it missed, and what it wrote meanwhile reaches the host", () => {
  const host = storeWith("host", newSeed());
  const guest = storeWith("shared");
  host.store.setCore("/a", core("api"));
  connect(host, guest, "edit").stop();
  host.store.setCore("/a", core("api, while away"));
  writeBoard(guest.store, "hive://w", [note("written offline")], { writer: "window" });
  connect(host, guest, "edit");
  expect(guest.store.getCore("hive://w")).toEqual(core("api, while away"));
  expect(host.store.getObjects("/a")).toEqual([note("written offline")]);
  // And both carry on from there.
  writeBoard(guest.store, "hive://w", [note("written offline"), { ...note("and after"), id: "n2" }], { writer: "window" });
  expect(host.store.getObjects("/a").map((o) => o.id).sort()).toEqual(["n1", "n2"]);
  expect(guest.store.version("hive://w")).toEqual(host.store.version("/a"));
});

test("a guest who edits the board changes it, but what would start something on the host, or say where a frame runs, never reaches it; one who drives agents may start one", () => {
  const host = storeWith("host", newSeed());
  host.store.setCore("/a", { ...core("api"), frames: [{ id: "f1", title: "api", workspacePath: "/work/api" }] });
  const was = host.store.getCore("/a")!;
  const editor = storeWith("editor");
  const dropped: string[] = [];
  connect(host, editor, "edit", dropped);
  // Moving and naming: taken.
  const theirs = editor.store.getCore("hive://w")!;
  editor.store.setCore("hive://w", { ...theirs, tileNames: { t1: "build" } }, { writer: "window", base: theirs });
  expect(host.store.getCore("/a")!.tileNames).toEqual({ t1: "build" });
  // A shell of theirs: not taken, and said why.
  const named = editor.store.getCore("hive://w")!;
  editor.store.setCore("hive://w", { ...named, tiles: [...named.tiles, { id: "t9", kind: "shell", label: "sh", cmd: "/bin/sh" }] }, { writer: "window", base: named });
  expect(host.store.getCore("/a")!.tiles.map((t) => t.id)).toEqual(["t1"]);
  expect(dropped).toEqual([expect.stringMatching(/^a change its role does not allow: adding tile t9/)]);
  // Nor is the frame's folder, though they may drive agents; their shell is taken.
  const driver = storeWith("driver");
  const refused: string[] = [];
  connect(host, driver, "agents", refused);
  const at = driver.store.getCore("hive://w")!;
  driver.store.setCore("hive://w", { ...at, frames: [{ id: "f1", title: "api", workspacePath: "/" }] }, { writer: "window", base: at });
  expect(host.store.getCore("/a")!.frames).toEqual(was.frames);
  expect(refused).toEqual([expect.stringMatching(/where frame f1 runs is the owner's/)]);
  const driving = storeWith("driving");
  connect(host, driving, "agents");
  const now = driving.store.getCore("hive://w")!;
  driving.store.setCore("hive://w", { ...now, tiles: [...now.tiles, { id: "t8", kind: "shell", label: "sh", cmd: "/bin/sh" }] }, { writer: "window", base: now });
  expect(host.store.getCore("/a")!.tiles.map((t) => t.id)).toEqual(["t1", "t8"]);
});

test("a listener that throws keeps no change from the replica listening after it", () => {
  const errors: string[] = [];
  const hub = changeHub((m) => errors.push(m));
  const store = new WorkspaceStore({ dir: path.join(tmp, "hub"), person: newSeed(), onChange: hub.tell });
  hub.changes(function brokenNotices() { throw new Error("boom"); });
  const heard: WorkspaceChange[] = [];
  hub.changes((c) => heard.push(c));
  store.setCore("/a", core("one"));
  expect(heard.length).toBeGreaterThan(0);
  expect(errors[0]).toContain("brokenNotices failed: boom");
});

/** A guest edits offline while its host restarts from disk, then connects again; `restartGuest`
 *  restarts the guest's app too before it does. */
function offlineAcrossHostRestart(restartGuest: boolean) {
  const seed = newSeed();
  const host = storeWith("host", seed);
  host.store.setCore("/a", core("api"));
  writeBoard(host.store, "/a", [note("hello")]);
  let guest = storeWith("shared");
  const dropped: string[] = [];
  const failed: string[] = [];
  const first = connect(host, guest, "edit", dropped);
  first.stop();

  const was = guest.store.getObjects("hive://w");
  const mine = { ...note("from the guest, offline"), id: "n2" };
  writeBoard(guest.store, "hive://w", [...was, mine], { writer: "window", base: was });
  const hosts = host.store.getObjects("/a");
  writeBoard(host.store, "/a", [{ ...hosts[0]!, text: "hello from the host" }], { writer: "window", base: hosts });

  const restarted = storeWith("host", seed);
  if (restartGuest) guest = storeWith("shared");
  const [h, g] = channel();
  const off = h.on((text) => {
    const m = parseSync(text);
    if (m?.t !== "hello") return;
    off();
    serveReplica(restarted.store, "/a", h, { seen: m.seen, access: "edit", changes: restarted.changes, writer: "peer:priya", onDropped: (w) => dropped.push(w) });
  });
  replicate(guest.store, "hive://w", g, { workspace: "w", changes: guest.changes, onFailed: (w) => failed.push(w) });
  return { host: restarted.store, guest: guest.store, dropped, failed };
}

test.each([
  ["while its app stays open", false],
  ["and its app restarts too", true],
])("a guest that edited offline while its host restarted gets the host's changes and gives it its own, %s", (_name, restartGuest) => {
  const { host, guest, dropped, failed } = offlineAcrossHostRestart(restartGuest);
  expect({ dropped, failed }).toEqual({ dropped: [], failed: [] });
  const texts = (objects: { id: string; text?: string }[]) => objects.map((o) => `${o.id}: ${o.text}`);
  expect(texts(host.getObjects("/a"))).toEqual(["n1: hello from the host", "n2: from the guest, offline"]);
  expect(texts(guest.getObjects("hive://w"))).toEqual(texts(host.getObjects("/a")));
  // And what either writes from then on reaches the other.
  const now = guest.getObjects("hive://w");
  writeBoard(guest, "hive://w", now.map((o) => (o.id === "n2" ? { ...o, text: "and later" } : o)), { writer: "window", base: now });
  expect(texts(host.getObjects("/a"))).toEqual(["n1: hello from the host", "n2: and later"]);
});

test("a new guest is welcomed with the workspace as it is, not with every change since its host started", () => {
  const host = storeWith("host", newSeed());
  host.store.setCore("/a", core("api"));
  let board = [note("moved about")];
  writeBoard(host.store, "/a", board);
  for (let x = 0; x < 2000; x++) {
    const next = [{ ...board[0]!, x }];
    writeBoard(host.store, "/a", next, { base: board });
    board = next;
  }
  const guest = storeWith("shared");
  const [h, g] = channel();
  const sent: string[] = [];
  const spied: SyncChannel = { ...h, send: (t) => { sent.push(t); h.send(t); } };
  const off = h.on((text) => { const m = parseSync(text); if (m?.t !== "hello") return; off(); serveReplica(host.store, "/a", spied, { seen: m.seen, access: "edit", changes: host.changes, writer: "peer:priya" }); });
  replicate(guest.store, "hive://w", g, { workspace: "w", changes: guest.changes });
  const welcome = sent.map((t) => parseSync(t)).find((m) => m?.t === "welcome") as { data: string };
  expect(guest.store.getObjects("hive://w")).toEqual(host.store.getObjects("/a"));
  expect(Buffer.from(welcome.data, "base64").length).toBeLessThan(host.store.exportSince("/a", null).length / 4);
}, 30_000);

test("a guest that cannot take another guest's offline change, made before it joined, asks again and ends with it", () => {
  const host = storeWith("host", newSeed());
  host.store.setCore("/a", core("api"));
  writeBoard(host.store, "/a", [note("hello")]);
  const early = storeWith("early");
  connect(host, early, "edit").stop();
  writeBoard(host.store, "/a", [note("hello from the host")]);
  const late = storeWith("late");
  connect(host, late, "edit");
  const was = early.store.getObjects("hive://w");
  writeBoard(early.store, "hive://w", [...was, { ...note("from early, offline"), id: "n2" }], { writer: "window", base: was });
  connect(host, early, "edit");

  const texts = (objects: { id: string; text?: string }[]) => objects.map((o) => `${o.id}: ${o.text}`);
  expect(texts(host.store.getObjects("/a"))).toEqual(["n1: hello from the host", "n2: from early, offline"]);
  expect(texts(late.store.getObjects("hive://w"))).toEqual(texts(host.store.getObjects("/a")));
  const now = late.store.getObjects("hive://w");
  writeBoard(late.store, "hive://w", now.map((o) => (o.id === "n2" ? { ...o, text: "and from late" } : o)), { writer: "window", base: now });
  expect(texts(host.store.getObjects("/a"))).toEqual(["n1: hello from the host", "n2: and from late"]);
});

test("while the link has no room the host sends a guest nothing; when room returns, one update holds every change made meanwhile", () => {
  const host = storeWith("host", newSeed());
  host.store.setCore("/a", core("api"));
  writeBoard(host.store, "/a", [note("a")]);
  const guest = storeWith("shared");
  const room = linkRoom();
  const [h, g] = channel(room);
  const sent: string[] = [];
  const spied: SyncChannel = { ...h, send: (t) => { sent.push(t); h.send(t); } };
  const off = h.on((text) => { const m = parseSync(text); if (m?.t !== "hello") return; off(); serveReplica(host.store, "/a", spied, { seen: m.seen, access: "edit", changes: host.changes, writer: "peer:priya" }); });
  replicate(guest.store, "hive://w", g, { workspace: "w", changes: guest.changes });
  expect(sent.map((t) => parseSync(t)?.t)).toEqual(["welcome"]);

  room.fill();
  let board = host.store.getObjects("/a");
  for (const text of ["ab", "abc", "abcd"]) {
    const next = [{ ...board[0]!, text }];
    writeBoard(host.store, "/a", next, { base: board });
    board = next;
  }
  expect(sent.length).toBe(1);
  room.free();
  expect(sent.map((t) => parseSync(t)?.t)).toEqual(["welcome", "update"]);
  expect(guest.store.getObjects("hive://w")).toEqual(host.store.getObjects("/a"));
});
