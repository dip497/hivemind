// A workspace's document between its host and a replica (doc-sync.ts, design §4.3): a replica
// catches up when it connects, each side's changes reach the other as they are made, a viewer's
// changes never reach the host, and a replica that connects again gets what it missed.
import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore, type WorkspaceChange } from "../src/store.ts";
import { parseSync, replicate, serveReplica, type SyncChannel } from "../src/doc-sync.ts";
import type { Access } from "../src/access.ts";
import { newSeed } from "../src/identity.ts";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doc-sync-")); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const core = (title: string) => ({ frames: [{ id: "f1", title }], tiles: [{ id: "t1", kind: "claude" }], tileNames: {}, editorTabs: {}, frameOf: { t1: "f1" } });
const note = (text: string) => ({ id: "n1", kind: "note" as const, x: 10, y: 20, w: 200, h: 160, text });

/** A store that tells a set of listeners of its changes. */
function storeWith(dir: string, person?: Uint8Array) {
  const listeners = new Set<(c: WorkspaceChange) => void>();
  const store = new WorkspaceStore({ dir: path.join(tmp, dir), person, onChange: (c) => { for (const l of listeners) l(c); } });
  const changes = (l: (c: WorkspaceChange) => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
  return { store, changes };
}
/** Two ends of a channel (frames delivered in order, at once). */
function channel(): [SyncChannel, SyncChannel] {
  const a = new Set<(t: string) => void>();
  const b = new Set<(t: string) => void>();
  return [
    { send: (t) => { for (const l of b) l(t); }, on: (l) => { a.add(l); return () => { a.delete(l); }; } },
    { send: (t) => { for (const l of a) l(t); }, on: (l) => { b.add(l); return () => { b.delete(l); }; } },
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

  guest.store.setObjects("hive://w", [note("from the guest")], { writer: "window" });
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
  guest.store.setObjects("hive://w", [note("not mine to write")], { writer: "window" });
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
  guest.store.setObjects("hive://w", [note("written offline")], { writer: "window" });
  connect(host, guest, "edit");
  expect(guest.store.getCore("hive://w")).toEqual(core("api, while away"));
  expect(host.store.getObjects("/a")).toEqual([note("written offline")]);
  // And both carry on from there.
  guest.store.setObjects("hive://w", [note("written offline"), { ...note("and after"), id: "n2" }], { writer: "window" });
  expect(host.store.getObjects("/a").map((o) => o.id).sort()).toEqual(["n1", "n2"]);
  expect(guest.store.version("hive://w")).toEqual(host.store.version("/a"));
});
