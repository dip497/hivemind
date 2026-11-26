// What is drawn on the board, through the workspace API on a real store: an agent's drawing lands
// beside its tile, in its frame, clear of what is there, and every other client is told; a person
// or program can read, picture and erase it; a note pins on it; and each refusal says why.
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore, type WorkspaceChange } from "@hivemind/workspace-host/store";
import { PresenceHub } from "@hivemind/workspace-host/presence";
import { presence } from "../src/presence.ts";
import { newSeed } from "@hivemind/workspace-host/identity";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import type { EventMessage } from "@hivemind/workspace-api/protocol";
import { mayCall } from "@hivemind/workspace-api/roles";
import type { BoardChanges, BoardDrawn, BoardReading, BoardSelection } from "@hivemind/workspace-api/board";
import type { ArrowObject, ShapeObject } from "@hivemind/workspace-doc/shapes";
import { MAX_SHAPES_ON_BOARD, rectsTouch } from "@hivemind/workspace-doc/drawing";
import { Layouts } from "../src/store.ts";
import { board } from "../src/board.ts";
import { phoneMay } from "../src/peer-links.ts";
import { BoardImages } from "../src/board-images.ts";
import { REVIEW_FILE } from "@hivemind/core/review";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-board-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let made = 0;

function host(o: { mayWrite?: (repo: string) => boolean; png?: boolean; show?: (repo: string, box: unknown) => void; presence?: boolean } = {}) {
  const dir = path.join(tmp, `h${++made}`);
  fs.mkdirSync(dir);
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  let server: WorkspaceServer;
  const heard = new Set<(c: WorkspaceChange) => void>();
  const hub = new PresenceHub();
  const store = new WorkspaceStore({ dir, person: newSeed(), onChange: (c) => {
    server.publishTo((conn) => !layouts.made(conn, c), "store.changed", { repo: c.repo, part: c.part, objects: c.objects });
    for (const l of heard) l(c);
  } });
  const layouts = new Layouts(() => store);
  server = new WorkspaceServer([layouts.domain, board({
    store: () => store,
    mayWrite: o.mayWrite,
    agentName: (tile) => `agent of ${tile}`,
    changes: (l) => { heard.add(l); return () => { heard.delete(l); }; },
    ...(o.presence ? { people: (repo: string) => hub.people(repo) } : {}),
    ...(o.png ? { png: async (svg: string, width: number, height: number) => ({ png: Buffer.from(svg).toString("base64"), width, height }) } : {}),
    ...(o.show ? { show: async (r: string, box: unknown) => o.show!(r, box) } : {}),
    images: new BoardImages({ dir: path.join(dir, "board-images") }),
  }), ...(o.presence ? [presence(() => server, () => "person-here", hub)] : [])], new Intents(new AuditLog({ file: path.join(dir, "audit.jsonl") })));
  const connect = (actor: Connection["actor"]) => {
    const closing = new AbortController();
    const told: EventMessage[] = [];
    const c: Connection & { told: EventMessage[]; close(): void } = { actor, told, send: (m) => told.push(m), closed: closing.signal, close: () => closing.abort() } as never;
    server.connect(c);
    return c;
  };
  const person = connect({ kind: "person" });
  const agent = connect({ kind: "peer", person: "tile-a", device: "tile-a", access: "agents", client: "pi", tile: "hm:tile-a" } as never);
  const call = async (from: Connection, method: string, ...params: unknown[]) => {
    const answer = await server.answer(method, params, from);
    if ("error" in answer) throw Object.assign(new Error(answer.error.message), { code: answer.error.code });
    return answer.result as any;
  };
  /** A workspace with a frame holding the agent's tile, and another tile beside it. */
  const lay = () => {
    store.setCore(repo, {
      frames: [{ id: "f1", title: "api", x: 100, y: 100, w: 1300, h: 900 } as never],
      tiles: [{ id: "tile-a", kind: "claude", label: "pi" }, { id: "tile-b", kind: "shell", label: "shell" }],
      tileNames: {}, editorTabs: {}, frameOf: { "tile-a": "f1" },
    });
    store.setView(repo, "canvas", { v: 1, data: { positions: { "tile-a": { x: 120, y: 160 }, "tile-b": { x: 1600, y: 160 } }, sizes: { "tile-a": { width: 800, height: 600 }, "tile-b": { width: 600, height: 400 } } } });
  };
  return { store, repo, person, agent, call, lay, connect, heard, server };
}

const FLOW = { title: "Flow", boxes: [{ id: "a", text: "A" }, { id: "b", text: "B" }], links: [["a", "b", "goes"], ["b", "me"], ["a", "tile-b"]] };

test("an agent's drawing lands beside its tile, in its frame, clear of what is there, with its links on what they name", async () => {
  const h = host();
  h.lay();
  const drawn = await h.call(h.agent, "board.draw", h.repo, FLOW) as BoardDrawn;
  assert.equal(drawn.frame, "f1");
  assert.deepEqual(drawn.overlaps, []);
  assert.deepEqual(Object.keys(drawn.boxes), ["a", "b"]);
  // A second one lands clear of the first, and says it landed on nothing.
  const second = await h.call(h.agent, "board.draw", h.repo, FLOW) as BoardDrawn;
  assert.deepEqual(second.overlaps, []);
  assert.equal(rectsTouch(second.box, drawn.box), false);
  await h.call(h.agent, "board.erase", h.repo, { drawing: second.drawing });
  // Beside the tile, not on it, and not on the tile further along.
  const beside = { x: 120, y: 160, w: 800, h: 600 };
  assert.equal(rectsTouch(drawn.box, beside), false);
  assert.ok(drawn.box.x >= beside.x + beside.w);
  assert.equal(rectsTouch(drawn.box, { x: 1600, y: 160, w: 600, h: 400 }), false);

  const objects = h.store.getObjects(h.repo);
  const shapes = objects.filter((o) => o.kind === "shape");
  const arrows = objects.filter((o) => o.kind === "arrow");
  assert.equal(shapes.length, 3);
  assert.equal(arrows.length, 3);
  // Kept relative to its frame, so moving the frame changes nothing here; who drew it is said.
  const a = shapes.find((s) => s.id === drawn.boxes.a)!;
  assert.equal(a.frame, "f1");
  assert.equal(a.by, "tile-a");
  assert.equal(a.drawing, drawn.drawing);
  assert.equal(a.x + 100 >= drawn.box.x, true);
  const ends = arrows.map((r) => (r.kind === "arrow" ? `${r.from.id}>${r.to.id}:${r.label}` : "")).sort();
  assert.deepEqual(ends, [`${drawn.boxes.a}>${drawn.boxes.b}:goes`, `${drawn.boxes.b}>tile-a:`, `${drawn.boxes.a}>tile-b:`].sort());
});

test("every other client is told what was drawn, by id, and can read it back in canvas coordinates", async () => {
  const h = host();
  h.lay();
  const drawn = await h.call(h.agent, "board.draw", h.repo, FLOW) as BoardDrawn;
  await new Promise((r) => setTimeout(r, 20));
  const said = h.person.told.filter((m) => m.event === "store.changed").map((m) => m.params[0] as { part: string; objects?: string[] });
  const board = said.find((c) => c.part === "board");
  assert.ok(board, "the person's window is told the board changed");
  assert.deepEqual([...board.objects!].sort(), [...drawn.objects].sort());

  const reading = await h.call(h.person, "board.read", h.repo) as BoardReading;
  assert.deepEqual(reading.drawings.map((d) => [d.id, d.title, d.by, d.objects]), [[drawn.drawing, "Flow", "tile-a", 6]]);
  assert.equal(reading.tiles.find((t) => t.id === "tile-a")!.frame, "f1");
  const item = reading.objects.find((o) => o.id === drawn.boxes.a)!;
  assert.equal(item.text, "A");
  assert.equal(rectsTouch(item.box!, drawn.box), true);
  assert.equal(reading.full, undefined);

  const full = await h.call(h.person, "board.read", h.repo, { drawing: drawn.drawing }) as BoardReading;
  assert.equal(full.full!.length, 6);
  const shape = full.full!.find((o) => o.id === drawn.boxes.a)!;
  assert.ok(shape.kind === "shape" && shape.x >= drawn.box.x);
  const few = await h.call(h.person, "board.read", h.repo, { limit: 2 }) as BoardReading;
  assert.equal(few.objects.length, 2);
  assert.equal(few.more, 4);
});

test("the picture is an SVG of one drawing or of all, showing what an arrow ends on; a PNG needs a window, and a peer's own", async () => {
  const h = host();
  h.lay();
  const one = await h.call(h.agent, "board.draw", h.repo, FLOW) as BoardDrawn;
  const other = await h.call(h.agent, "board.draw", h.repo, { boxes: [{ id: "x", text: "Other" }] }) as BoardDrawn;
  const pic = await h.call(h.person, "board.picture", h.repo, { drawing: one.drawing });
  assert.match(pic.svg, />A</);
  assert.doesNotMatch(pic.svg, /Other/);
  assert.match(pic.svg, />shell</, "a tile an arrow ends on is named");
  assert.match((await h.call(h.person, "board.picture", h.repo)).svg, /Other/);
  await assert.rejects(h.call(h.person, "board.picture", h.repo, { drawing: "nope" }), { code: "NOT_FOUND" });
  await assert.rejects(h.call(h.person, "board.picture", h.repo, { png: true }), { code: "UNSUPPORTED" });
  void other;

  const windowed = host({ png: true });
  windowed.lay();
  await windowed.call(windowed.agent, "board.draw", windowed.repo, FLOW);
  assert.ok((await windowed.call(windowed.agent, "board.picture", windowed.repo, { png: true })).png);
  const guest = windowed.connect({ kind: "peer", person: "p", device: "d", access: "view" } as never);
  await assert.rejects(windowed.call(guest, "board.picture", windowed.repo, { png: true }), { code: "FORBIDDEN" });
});

test("an update whose boxes are all new draws them where the drawing was, also when a person moved it, and erased it takes its arrows", async () => {
  const h = host();
  h.lay();
  const first = await h.call(h.agent, "board.draw", h.repo, { boxes: [{ id: "a", text: "A" }, { id: "b", text: "B" }], links: [["a", "b"]] }) as BoardDrawn;
  // The person moves the whole of it.
  const moved = h.store.getObjects(h.repo).map((o) => (o.kind === "shape" ? { ...o, x: o.x + 500, y: o.y + 300 } : o));
  h.store.editObjects(h.repo, { objects: Object.fromEntries(moved.map((o) => [o.id, o])) }, { writer: "window" });
  const redrawn = await h.call(h.agent, "board.draw", h.repo, { update: first.drawing, boxes: [{ id: "c", text: "C" }] }) as BoardDrawn;
  assert.equal(redrawn.drawing, first.drawing, "an update keeps the drawing's id");
  assert.deepEqual([redrawn.box.x, redrawn.box.y], [first.box.x + 500, first.box.y + 300]);
  assert.deepEqual(h.store.getObjects(h.repo).map((o) => o.id), [redrawn.boxes.c]);
  await assert.rejects(h.call(h.agent, "board.draw", h.repo, { update: "drawing-nope", boxes: [{ id: "c", text: "C" }] }), { code: "NOT_FOUND" });

  const third = await h.call(h.agent, "board.draw", h.repo, { boxes: [{ id: "d", text: "D" }], links: [["d", redrawn.boxes.c]] }) as BoardDrawn;
  assert.deepEqual((await h.call(h.person, "board.erase", h.repo, { ids: [redrawn.boxes.c] })).erased.sort(),
    [redrawn.boxes.c, third.objects.find((id) => id.startsWith("arrow"))].sort(), "an arrow goes with what it ended on");
  assert.deepEqual(h.store.getObjects(h.repo).map((o) => o.id), [third.boxes.d]);
  await assert.rejects(h.call(h.person, "board.erase", h.repo, {}), { code: "BAD_REQUEST" });
  await assert.rejects(h.call(h.person, "board.erase", h.repo, { ids: ["nope"] }), { code: "NOT_FOUND" });
  // `me`: what the caller drew, and nothing a person's own.
  h.store.editObjects(h.repo, { objects: { mine: { id: "mine", kind: "shape", form: "rect", x: 0, y: 0, w: 9, h: 9 } } }, { writer: "window" });
  assert.deepEqual((await h.call(h.agent, "board.erase", h.repo, { by: "me" })).erased, [third.boxes.d]);
  assert.deepEqual(h.store.getObjects(h.repo).map((o) => o.id), ["mine"]);
});

test("what cannot be drawn is refused saying why: a link to nothing, a frame not there, a full board, a board only shared to view", async () => {
  const h = host();
  h.lay();
  await assert.rejects(h.call(h.agent, "board.draw", h.repo, { boxes: [{ id: "a", text: "A" }], links: [["a", "nowhere"]] }), (e: Error & { code: string }) => e.code === "BAD_REQUEST" && e.message.includes("nowhere"));
  assert.deepEqual(h.store.getObjects(h.repo), [], "nothing of a refused drawing is kept");
  await assert.rejects(h.call(h.agent, "board.draw", h.repo, { frame: "nope", boxes: [{ id: "a", text: "A" }] }), { code: "NOT_FOUND" });
  await assert.rejects(h.call(h.agent, "board.draw", h.repo, { near: "nope", boxes: [{ id: "a", text: "A" }] }), { code: "NOT_FOUND" });
  await assert.rejects(h.call(h.agent, "board.draw", h.repo, { boxes: [{ text: "no id" }] }), { code: "BAD_REQUEST" });

  const objects = Object.fromEntries(Array.from({ length: MAX_SHAPES_ON_BOARD }, (_, i) => [`s${i}`, { id: `s${i}`, kind: "shape", form: "rect", x: i, y: 0, w: 1, h: 1 }]));
  h.store.editObjects(h.repo, { objects }, { writer: "window" });
  await assert.rejects(h.call(h.agent, "board.draw", h.repo, { boxes: [{ id: "a", text: "A" }] }), (e: Error & { code: string }) => e.code === "BAD_REQUEST" && e.message.includes("erase some first"));

  const shared = host({ mayWrite: () => false });
  await assert.rejects(shared.call(shared.agent, "board.draw", shared.repo, FLOW), { code: "FORBIDDEN" });
  await assert.rejects(shared.call(shared.agent, "board.erase", shared.repo, { by: "me" }), { code: "FORBIDDEN" });
  fs.mkdirSync(path.join(shared.repo, ".hivemind"));
  await assert.rejects(shared.call(shared.person, "board.note", shared.repo, { body: "x", at: { x: 0, y: 0 } }), { code: "FORBIDDEN" });
  assert.equal(fs.existsSync(path.join(shared.repo, ".hivemind", REVIEW_FILE)), false);
});

test("a drawing placed at a corner stays there, loose unless told; with no tile it goes past what is on the canvas", async () => {
  const h = host();
  h.lay();
  const at = await h.call(h.agent, "board.draw", h.repo, { at: { x: 5000, y: 6000 }, boxes: [{ id: "a", text: "A" }] }) as BoardDrawn;
  assert.deepEqual([at.box.x, at.box.y, at.frame], [5000, 6000, undefined]);
  const person = await h.call(h.person, "board.draw", h.repo, { boxes: [{ id: "a", text: "A" }] }) as BoardDrawn;
  assert.ok(person.box.x > 5000);
  const shape = h.store.getObjects(h.repo).find((o) => o.id === person.boxes.a)!;
  assert.equal(shape.kind === "shape" && shape.by, undefined);
  const near = await h.call(h.person, "board.draw", h.repo, { near: "tile-b", boxes: [{ id: "a", text: "A" }] }) as BoardDrawn;
  assert.equal(near.frame, undefined);
  assert.ok(near.box.x >= 1600 + 600);
  const none = await h.call(h.agent, "board.draw", h.repo, { frame: "none", boxes: [{ id: "a", text: "A" }] }) as BoardDrawn;
  assert.equal(none.frame, undefined);
});

test("a note pins on something, in its author's name, or at a place; what it names must be there", async () => {
  const h = host();
  h.lay();
  const drawn = await h.call(h.agent, "board.draw", h.repo, FLOW) as BoardDrawn;
  const mine = await h.call(h.person, "board.note", h.repo, { body: "  rate limits  ", on: drawn.boxes.a, at: { x: 4, y: 5 } });
  assert.deepEqual([mine.body, mine.author, mine.board], ["rate limits", "you", { on: drawn.boxes.a, x: 4, y: 5, what: "A" }]);
  const theirs = await h.call(h.agent, "board.note", h.repo, { body: "here", on: "me" });
  assert.deepEqual([theirs.author, theirs.board.on, theirs.board.what], ["agent of tile-a", "tile-a", "pi"]);
  const loose = await h.call(h.person, "board.note", h.repo, { body: "there", at: { x: 40, y: 50 } });
  assert.deepEqual(loose.board, { x: 40, y: 50 });
  await assert.rejects(h.call(h.person, "board.note", h.repo, { body: "x", on: "nope" }), { code: "NOT_FOUND" });
  await assert.rejects(h.call(h.person, "board.note", h.repo, { body: "x" }), { code: "BAD_REQUEST" });
  await assert.rejects(h.call(h.person, "board.note", h.repo, { body: " ", at: { x: 0, y: 0 } }), { code: "BAD_REQUEST" });
});

test("a window is asked to show a drawing or an object by where it is; none to ask says so", async () => {
  const shown: unknown[] = [];
  const h = host({ show: (_repo, box) => shown.push(box) });
  h.lay();
  const drawn = await h.call(h.agent, "board.draw", h.repo, FLOW) as BoardDrawn;
  await h.call(h.agent, "board.show", h.repo, drawn.drawing);
  assert.deepEqual(shown, [drawn.box]);
  await h.call(h.agent, "board.show", h.repo, "tile-b");
  assert.deepEqual(shown[1], { x: 1600, y: 160, w: 600, h: 400, name: "shell", kind: "shell" });
  await assert.rejects(h.call(h.agent, "board.show", h.repo, "nope"), { code: "NOT_FOUND" });
  const headless = host();
  await assert.rejects(headless.call(headless.agent, "board.show", headless.repo, "x"), { code: "UNSUPPORTED" });
});

test("who may do what: a viewer reads, an editor and an agent draw, a phone looks, and showing is this machine's", () => {
  const as = (access: "view" | "edit" | "agents", tile?: string) => ({ access, ...(tile ? { tile } : {}) });
  for (const method of ["board.read", "board.picture"]) assert.equal(mayCall(as("view"), method), true, method);
  for (const method of ["board.draw", "board.erase", "board.note"]) {
    assert.equal(mayCall(as("view"), method), false, method);
    assert.equal(mayCall(as("edit"), method), true, method);
    assert.equal(mayCall(as("agents", "hm:t"), method), true, method);
  }
  assert.equal(mayCall(as("agents", "hm:t"), "board.show"), true);
  assert.equal(mayCall(as("edit"), "board.show"), false);
  for (const method of ["board.read", "board.picture"]) assert.equal(phoneMay(method, []), true, method);
  for (const method of ["board.draw", "board.erase", "board.note"]) assert.equal(phoneMay(method, []), false, method);
});

test("reading a page answers what is inside it at any depth; with none, everything on the canvas, in canvas coordinates", async () => {
  const h = host();
  h.lay();
  const { id: page } = await h.call(h.person, "page.new", h.repo, { title: "Payments", at: { x: 3000, y: 2000 } });
  const { id: deeper } = await h.call(h.person, "page.new", h.repo, { title: "Checkout", in: page });
  const inside = await h.call(h.person, "board.draw", h.repo, { boxes: [{ id: "a", text: "Inside" }], page: deeper }) as BoardDrawn;
  const outside = await h.call(h.person, "board.draw", h.repo, { boxes: [{ id: "a", text: "Outside" }] }) as BoardDrawn;
  assert.equal(inside.frame, deeper);

  const there = await h.call(h.person, "board.read", h.repo, { page }) as BoardReading;
  assert.deepEqual(there.drawings.map((d) => d.id), [inside.drawing], "what is in a page inside it is inside it too");
  assert.deepEqual(there.frames.map((f) => f.id), [deeper]);
  const everything = await h.call(h.person, "board.read", h.repo, {}) as BoardReading;
  assert.deepEqual(everything.drawings.map((d) => d.id).sort(), [inside.drawing, outside.drawing].sort());
  assert.ok(everything.frames.some((f) => f.id === page && f.page));
  assert.deepEqual((await h.call(h.person, "page.list", h.repo)).pages, [
    { id: page, title: "Payments", parent: null, objects: 1, tiles: 0 },
    { id: deeper, title: "Checkout", parent: page, objects: 1, tiles: 0 },
  ]);
  await assert.rejects(h.call(h.person, "board.read", h.repo, { page: "nothing" }), { code: "NOT_FOUND" });

  // Moved, it lands where it was asked on the canvas, still in its frame.
  const [shape] = inside.objects;
  await h.call(h.person, "board.change", h.repo, { ids: [shape], to: { x: 3100, y: 2100 } });
  const [moved] = (await h.call(h.person, "board.read", h.repo, { page, ids: [shape] }) as BoardReading).full!;
  assert.deepEqual([(moved as { x: number }).x, (moved as { y: number }).y], [3100, 2100]);
  const kept = h.store.getObjects(h.repo).find((b) => b.id === shape) as { x: number; y: number; frame?: string };
  assert.equal(kept.frame, deeper);
});

test("undo takes back the caller's own last change, never another's, across its connections", async () => {
  const h = host();
  h.lay();
  const shapes = () => new Set(h.store.getObjects(h.repo).map((b) => b.id));
  const mine = await h.call(h.agent, "board.draw", h.repo, { boxes: [{ id: "a", text: "Agent's" }] }) as BoardDrawn;
  const theirs = await h.call(h.person, "board.draw", h.repo, { boxes: [{ id: "a", text: "Person's" }], at: { x: 5000, y: 0 } }) as BoardDrawn;

  assert.deepEqual(await h.call(h.agent, "board.undo", h.repo), { undone: true });
  assert.equal(shapes().has(mine.objects[0]!), false, "the agent's drawing is taken back");
  assert.equal(shapes().has(theirs.objects[0]!), true, "the person's stays");
  assert.deepEqual(await h.call(h.agent, "board.undo", h.repo), { undone: false });
  assert.deepEqual(await h.call(h.agent, "board.redo", h.repo), { redone: true });
  assert.equal(shapes().has(mine.objects[0]!), true);

  // A caller's history outlives its connection: the next `hive ctl` call of the same agent undoes it.
  (h.agent as unknown as { close(): void }).close();
  const again = h.connect({ kind: "peer", person: "tile-a", device: "tile-a", access: "agents", client: "pi", tile: "hm:tile-a" } as never);
  assert.deepEqual(await h.call(again, "board.undo", h.repo), { undone: true });
  assert.equal(shapes().has(mine.objects[0]!), false);
});

test("change locks, unlocks, copies, restacks and keeps what is already on the page asked for, in its frame", async () => {
  const h = host();
  h.lay();
  const drawn = await h.call(h.agent, "board.draw", h.repo, { boxes: [{ id: "a", text: "Lock me" }] }) as BoardDrawn;
  const [shape] = drawn.objects as [string];
  const kept = (id: string) => h.store.getObjects(h.repo).find((b) => b.id === id) as { x: number; y: number; z?: number; frame?: string; locked?: boolean };
  assert.equal(kept(shape).frame, "f1");

  assert.deepEqual(await h.call(h.person, "board.change", h.repo, { ids: [shape], locked: true }), { changed: [shape], locked: [shape] });
  await assert.rejects(h.call(h.agent, "board.change", h.repo, { ids: [shape], to: { x: 0, y: 0 } }), { code: "FORBIDDEN" });
  await h.call(h.person, "board.change", h.repo, { ids: [shape], locked: false });
  await h.call(h.agent, "board.change", h.repo, { ids: [shape], to: { x: 500, y: 600 } });
  assert.deepEqual([kept(shape).x, kept(shape).y, kept(shape).frame], [400, 500, "f1"]);

  const { copies } = await h.call(h.agent, "board.change", h.repo, { ids: [shape], duplicate: { dx: 24, dy: 24 } });
  assert.equal(copies.length, 1);
  assert.deepEqual([kept(copies[0]).x, kept(copies[0]).y, kept(copies[0]).frame], [424, 524, "f1"]);
  await h.call(h.agent, "board.change", h.repo, { ids: [shape], stack: "front" });
  assert.ok(kept(shape).z! > kept(copies[0]).z!);

  // In no page: moving it out of pages leaves it in its frame.
  assert.deepEqual((await h.call(h.agent, "board.change", h.repo, { ids: [shape], page: null })).changed, []);
  assert.equal(kept(shape).frame, "f1");
});

test("a caller's history is forgotten after an hour unused, and the least recently used goes past 64 callers", async () => {
  const h = host();
  h.lay();
  const agent = (n: number) => h.connect({ kind: "peer", person: `t${n}`, device: `t${n}`, access: "agents", client: "pi", tile: `hm:t${n}` } as never);
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    await h.call(agent(0), "board.draw", h.repo, { boxes: [{ id: "a", text: "Old" }], at: { x: 0, y: 3000 } });
    mock.timers.tick(61 * 60 * 1000);
    await h.call(agent(1), "board.draw", h.repo, { boxes: [{ id: "a", text: "New" }], at: { x: 400, y: 3000 } });
    assert.deepEqual(await h.call(agent(0), "board.undo", h.repo), { undone: false }, "idle an hour: forgotten");
    assert.deepEqual(await h.call(agent(1), "board.undo", h.repo), { undone: true });

    for (let n = 2; n <= 66; n++) await h.call(agent(n), "board.draw", h.repo, { boxes: [{ id: "a", text: `${n}` }], at: { x: n * 300, y: 4000 } });
    assert.deepEqual(await h.call(agent(2), "board.undo", h.repo), { undone: false }, "crowded out by 64 newer callers");
    assert.deepEqual(await h.call(agent(66), "board.undo", h.repo), { undone: true });
  } finally {
    mock.timers.reset();
  }
});

test("the app's window draws as a view: the view's undo takes back its own drawing, the person's undo does not", async () => {
  const h = host();
  h.lay();
  const shapes = () => new Set(h.store.getObjects(h.repo).map((b) => b.id));
  const view = { writer: "view:@ada/map" };
  const viewDrew = await h.call(h.person, "board.draw", h.repo, { boxes: [{ id: "a", text: "View's" }], at: { x: 5000, y: 0 } }, view) as BoardDrawn;
  assert.deepEqual(await h.call(h.person, "board.undo", h.repo), { undone: false }, "the person's own history holds nothing");
  assert.equal(shapes().has(viewDrew.objects[0]!), true);
  assert.deepEqual(await h.call(h.person, "board.undo", h.repo, view), { undone: true });
  assert.equal(shapes().has(viewDrew.objects[0]!), false);
});

test("writing as a view is refused to any caller but the app's window, and to a writer that is not a view's", async () => {
  const h = host();
  h.lay();
  const token = h.connect({ kind: "peer", person: "ada", device: "ci", access: "agents", client: "script" } as never);
  (token as { may?: (m: string) => boolean }).may = () => true;
  const forbidden = (e: { code?: string }) => e.code === "FORBIDDEN";
  await assert.rejects(h.call(token, "board.draw", h.repo, { boxes: [{ id: "a", text: "x" }] }, { writer: "view:@ada/map" }), forbidden);
  await assert.rejects(h.call(token, "board.undo", h.repo, { writer: "view:@ada/map" }), forbidden);
  for (const writer of ["person", "api:tile-a", "view:", "view:has space", 7]) {
    await assert.rejects(h.call(h.person, "board.draw", h.repo, { boxes: [{ id: "a", text: "x" }] }, { writer }), forbidden, `writer ${String(writer)}`);
  }
  assert.equal(h.store.getObjects(h.repo).length, 0, "nothing was drawn");
});

const shapeOf = (h: ReturnType<typeof host>, id: string): ShapeObject => h.store.getObjects(h.repo).find((o) => o.id === id) as ShapeObject;
const byId = (h: ReturnType<typeof host>) => [...h.store.getObjects(h.repo)].sort((a, b) => a.id.localeCompare(b.id));

test("an update keeps a box the person moved where they put it, places a new box beside what it links to, erases what it no longer names, and is one undo step", async () => {
  const h = host();
  h.lay();
  const first = await h.call(h.agent, "board.draw", h.repo, { boxes: [{ id: "web", text: "Web" }, { id: "api", text: "API" }, { id: "db", text: "DB" }], links: [["web", "api"], ["api", "db"]] }) as BoardDrawn;
  // The person moves the API box well away, as the window's move does, and widens it.
  const [placed] = (await h.call(h.person, "board.read", h.repo, { ids: [first.boxes.api] }) as BoardReading).full!;
  await h.call(h.person, "board.change", h.repo, { ids: [first.boxes.api], to: { x: (placed as ShapeObject).x + 40, y: (placed as ShapeObject).y + 700 } });
  const api = shapeOf(h, first.boxes.api!);
  assert.equal(api.key, "api", "a move keeps the box's key");
  h.store.editObjects(h.repo, { objects: { [api.id]: { ...api, w: api.w + 60 } } }, { writer: "client:1" });
  const before = byId(h);
  const web = shapeOf(h, first.boxes.web!);

  // Bare ids keep their words; the new box's link to the agent's tile comes first, and still it goes beside the API box.
  const up = await h.call(h.agent, "board.draw", h.repo, { update: first.drawing, text: "cache[Cache] --> me\nweb --> api\napi --> cache" }) as BoardDrawn;
  assert.equal(up.drawing, first.drawing);
  const moved = shapeOf(h, first.boxes.api!);
  assert.deepEqual([moved.x, moved.y, moved.w, moved.h, moved.text], [api.x, api.y, api.w + 60, api.h, "API"], "the box the person moved keeps its place, size and words");
  assert.deepEqual(shapeOf(h, first.boxes.web!), web, "a box nothing new was said of is not written");
  assert.deepEqual(up.changed, []);
  const dbArrow = before.find((o): o is ArrowObject => o.kind === "arrow" && o.to.id === first.boxes.db)!.id;
  assert.deepEqual(up.erased!.sort(), [first.boxes.db!, dbArrow].sort());
  const cache = shapeOf(h, up.boxes.cache!);
  assert.equal(cache.key, "cache");
  assert.ok(cache.x >= moved.x + moved.w && cache.x < moved.x + moved.w + 400 && Math.abs(cache.y - moved.y) < 1, `the new box sits right of the box it follows: ${cache.x},${cache.y} beside ${moved.x},${moved.y}`);
  const toCache = h.store.getObjects(h.repo).find((o): o is ArrowObject => o.kind === "arrow" && o.to.id === cache.id)!;
  assert.equal(toCache.from.id, moved.id);
  const toMe = h.store.getObjects(h.repo).find((o): o is ArrowObject => o.kind === "arrow" && o.from.id === cache.id)!;
  assert.equal(toMe.to.id, "tile-a");
  assert.deepEqual(up.added!.sort(), [cache.id, toCache.id, toMe.id].sort());

  assert.equal((await h.call(h.agent, "board.undo", h.repo)).undone, true);
  assert.deepEqual(byId(h), before, "one undo takes the whole update back");
});

test("a drawing read back as text and sent back as an update changes nothing: title, links to tiles, forms, colours, two-line words, dashes, a pen stroke, a moved box", async () => {
  const h = host();
  h.lay();
  const first = await h.call(h.agent, "board.draw", h.repo, {
    title: "Flow",
    boxes: [{ id: "a", text: "Line one\nline two" }, { id: "b", text: "B", form: "hexagon", color: "blue" }, { id: "c", text: "Choice", form: "diamond" }, { id: "d", text: "Round", form: "ellipse" }],
    links: [{ from: "a", to: "b", label: "goes", dash: "dashed" }, ["b", "me"], ["a", "tile-b"], ["a", "c"], { from: "c", to: "d", dash: "dotted" }],
    shapes: [{ form: "pen", points: [[0, 0], [10, 10], [20, 5]] }],
  }) as BoardDrawn;
  const c = shapeOf(h, first.boxes.c!);
  h.store.editObjects(h.repo, { objects: { [c.id]: { ...c, x: c.x + 300, y: c.y + 200 } } }, { writer: "client:1" });
  const before = byId(h);

  const { text } = await h.call(h.agent, "board.read", h.repo, { drawing: first.drawing, as: "text" }) as BoardReading;
  assert.match(text!, /^title Flow$/m);
  assert.match(text!, /^a\[Line one<br>line two\]$/m);
  assert.match(text!, /^c\{Choice\}$/m);
  assert.match(text!, /^a -\.-> b: goes$/m);
  assert.match(text!, /^b --> tile-a$/m);
  assert.match(text!, /^keep shape-/m);
  const again = await h.call(h.agent, "board.draw", h.repo, { update: first.drawing, text }) as BoardDrawn;
  assert.deepEqual([again.added, again.changed, again.erased], [[], [], []]);
  assert.deepEqual(byId(h), before);
});

test("an update leaves what the person locked and says so, and refuses a place, or a keep that is not of the drawing", async () => {
  const h = host();
  h.lay();
  const first = await h.call(h.agent, "board.draw", h.repo, { boxes: [{ id: "a", text: "A" }, { id: "b", text: "B" }], links: [["a", "b"]] }) as BoardDrawn;
  await h.call(h.person, "board.change", h.repo, { ids: [first.boxes.b], locked: true });
  const up = await h.call(h.agent, "board.draw", h.repo, { update: first.drawing, boxes: [{ id: "a", text: "A" }] }) as BoardDrawn;
  assert.deepEqual(up.locked, [first.boxes.b]);
  assert.ok(shapeOf(h, first.boxes.b!), "the locked box stays");
  await assert.rejects(h.call(h.agent, "board.draw", h.repo, { update: first.drawing, at: { x: 0, y: 0 }, boxes: [{ id: "a", text: "A" }] }), { code: "BAD_REQUEST" });
  await assert.rejects(h.call(h.agent, "board.draw", h.repo, { update: first.drawing, boxes: [{ id: "a", text: "A" }], keep: ["shape-nope"] }), { code: "BAD_REQUEST" });
  await assert.rejects(h.call(h.agent, "board.draw", h.repo, { boxes: [{ id: "a", text: "A" }], keep: [first.boxes.a] }), { code: "BAD_REQUEST" });
});

test("what each window has selected reaches an agent, from what the window says of itself", async () => {
  const h = host({ presence: true });
  h.lay();
  const drawn = await h.call(h.agent, "board.draw", h.repo, FLOW) as BoardDrawn;
  assert.deepEqual((await h.call(h.agent, "board.selected", h.repo) as BoardSelection).windows, []);
  h.server.notice("presence.set", [h.repo, { name: "Dip", color: "#112233", cursor: null, over: null, viewport: null, selection: [drawn.boxes.a, "tile-b", "f1", "not-there"] }], h.person);
  const { windows } = await h.call(h.agent, "board.selected", h.repo) as BoardSelection;
  assert.equal(windows.length, 1);
  assert.equal(windows[0]!.name, "Dip");
  assert.deepEqual(windows[0]!.selected.map((i) => [i.id, i.kind]), [[drawn.boxes.a, "shape"], ["tile-b", "tile"], ["f1", "frame"]]);
  const bare = host();
  await assert.rejects(bare.call(bare.agent, "board.selected", bare.repo), { code: "UNSUPPORTED" });
});

test("the board's changes say who made each, a follower is told as they come until it goes, and a seq past the feed's is said lost", async () => {
  const h = host();
  h.lay();
  const start = await h.call(h.agent, "board.changes", h.repo) as BoardChanges;
  assert.deepEqual(start, { seq: 0, changes: [], erased: [] });
  const follower = h.connect({ kind: "person" });
  await h.call(follower, "board.changes", h.repo, 0, true);

  const drawn = await h.call(h.agent, "board.draw", h.repo, { boxes: [{ id: "a", text: "A" }] }) as BoardDrawn;
  h.store.editObjects(h.repo, { objects: { [drawn.boxes.a!]: null } }, { writer: "client:1" });
  await h.call(h.person, "board.draw", h.repo, { boxes: [{ id: "v", text: "V" }] }, { writer: "view:@me/flow" });
  const feed = await h.call(h.agent, "board.changes", h.repo, start.seq) as BoardChanges;
  assert.deepEqual(feed.changes.map((c) => [c.seq, c.by, c.who ?? null]), [[1, "agent", "tile-a"], [2, "person", null], [3, "view", "@me/flow"]]);
  assert.deepEqual(feed.changes[0]!.objects, [drawn.boxes.a]);
  assert.deepEqual(feed.erased, [drawn.boxes.a]);
  const told = () => follower.told.filter((m) => m.event === "board.changed").map((m) => (m.params[1] as { seq: number }).seq);
  assert.deepEqual(told(), [1, 2, 3]);

  follower.close();
  await new Promise((r) => setTimeout(r, 0));
  h.store.editObjects(h.repo, { objects: { x: { id: "x", kind: "shape", form: "rect", x: 0, y: 0, w: 9, h: 9 } } }, { writer: "client:1" });
  assert.deepEqual(told(), [1, 2, 3], "a follower that went is told nothing more");
  assert.deepEqual((await h.call(h.agent, "board.changes", h.repo, 4)).changes, []);
  assert.equal((await h.call(h.agent, "board.changes", h.repo, 99)).lost, true, "a seq past the feed's: it started again");
});

test("a titled drawing updated with only new boxes draws them under its title, where the person moved it", async () => {
  const h = host();
  h.lay();
  const first = await h.call(h.agent, "board.draw", h.repo, { title: "Plan", boxes: [{ id: "a", text: "A" }, { id: "b", text: "B" }], links: [["a", "b"]] }) as BoardDrawn;
  await h.call(h.person, "board.change", h.repo, { ids: [first.drawing], to: { x: 2000, y: 1500 } });
  const up = await h.call(h.agent, "board.draw", h.repo, { update: first.drawing, title: "Plan", boxes: [{ id: "c", text: "C" }, { id: "d", text: "D" }], links: [["c", "d"]] }) as BoardDrawn;
  const full = (await h.call(h.person, "board.read", h.repo, { drawing: first.drawing }) as BoardReading).full!.filter((o): o is ShapeObject => o.kind === "shape");
  const title = full.find((o) => o.text === "Plan")!;
  const c = full.find((o) => o.id === up.boxes.c)!;
  assert.deepEqual([title.x, title.y], [2000, 1500], "the title stays where the person put it");
  assert.deepEqual([c.x, c.y], [2000, 1544], "the new boxes are laid out under it, as a fresh drawing would be");
  assert.deepEqual(up.changed, []);
});

test("words that look like flowchart text, and the way a drawing runs, come back through text unchanged", async () => {
  const h = host();
  h.lay();
  const words = ["a --> b", "100%% sure", "x -.-> y | z", "ends;", "R&#38;D <br> \"quoted\""];
  const first = await h.call(h.agent, "board.draw", h.repo, {
    title: "Down -- 50%% ==> done;", direction: "down",
    boxes: words.map((text, i) => ({ id: `n${i}`, text })),
    links: [{ from: "n0", to: "n1", label: "goes --> on %% here" }, ["n1", "n2"], ["n2", "n3"], ["n3", "n4"]],
  }) as BoardDrawn;
  const before = byId(h);
  const { text } = await h.call(h.agent, "board.read", h.repo, { drawing: first.drawing, as: "text" }) as BoardReading;
  assert.match(text!, /^direction down$/m);
  const again = await h.call(h.agent, "board.draw", h.repo, { update: first.drawing, text }) as BoardDrawn;
  assert.deepEqual([again.added, again.changed, again.erased], [[], [], []]);
  assert.deepEqual(byId(h), before);
  // The way it runs places what is added: below the box it follows.
  const grown = await h.call(h.agent, "board.draw", h.repo, { update: first.drawing, text: `${text}n4 --> n5[Next]\n` }) as BoardDrawn;
  const [last, next] = [shapeOf(h, first.boxes.n4!), shapeOf(h, grown.boxes.n5!)];
  assert.ok(next.y >= last.y + last.h && Math.abs(next.x - last.x) < 1, `below: ${next.x},${next.y} after ${last.x},${last.y}`);
});

test("a picture kept for the board is drawn as a box links end on, listed with its hash and alt text, round-trips as text, and is fetched by anyone who may read the board", async () => {
  const h = host();
  h.lay();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  png.writeUInt32BE(1600, 16);
  png.writeUInt32BE(900, 20);
  const data = png.toString("base64");
  const kept = await h.call(h.agent, "board.keepImage", h.repo, { type: "image/png", data });
  assert.deepEqual({ type: kept.type, width: kept.width, height: kept.height }, { type: "image/png", width: 1600, height: 900 });

  const drawn = await h.call(h.agent, "board.draw", h.repo, { boxes: [{ id: "shot", image: kept.hash, alt: "the login page" }, { id: "api", text: "API" }], links: [["shot", "api", "posts"]] }) as BoardDrawn;
  const shot = h.store.getObjects(h.repo).find((o) => o.id === drawn.boxes.shot) as ShapeObject;
  // Drawn at its own shape, no wider than a box in a drawing, in the frame beside the agent.
  assert.deepEqual([shot.form, shot.w, shot.h, shot.frame, shot.alt, shot.image], ["image", 320, 180, "f1", "the login page", kept]);
  const arrow = h.store.getObjects(h.repo).find((o) => o.kind === "arrow") as ArrowObject;
  assert.equal(arrow.from.id, shot.id);

  const reading = await h.call(h.agent, "board.read", h.repo) as BoardReading;
  assert.deepEqual(reading.objects.find((o) => o.id === shot.id), { id: shot.id, kind: "shape", form: "image", box: { x: shot.x + 100, y: shot.y + 100, w: 320, h: 180 }, text: "the login page", image: kept.hash, by: "tile-a", drawing: drawn.drawing, frame: "f1" });

  // As text, and back as an update: nothing changes.
  const { text } = await h.call(h.agent, "board.read", h.repo, { drawing: drawn.drawing, as: "text" }) as BoardReading;
  assert.match(text!, new RegExp(`^image shot ${kept.hash}: the login page$`, "m"));
  const before = JSON.stringify(h.store.getObjects(h.repo));
  const again = await h.call(h.agent, "board.draw", h.repo, { text, update: drawn.drawing }) as BoardDrawn;
  assert.deepEqual([again.added, again.changed, again.erased], [[], [], []]);
  assert.equal(JSON.stringify(h.store.getObjects(h.repo)), before);

  // Its bytes, to anyone who may read the board, the phone among them; keeping one takes editing.
  assert.deepEqual(await h.call(h.person, "board.image", h.repo, kept.hash), { type: "image/png", data });
  assert.equal(mayCall({ access: "view" }, "board.image"), true);
  assert.equal(mayCall({ access: "view" }, "board.keepImage"), false);
  assert.equal(phoneMay("board.image", []), true);
  // The picture of the board shows it, from its bytes.
  const pic = await h.call(h.agent, "board.picture", h.repo, { drawing: drawn.drawing });
  assert.ok(pic.svg.includes(`href="data:image/png;base64,${data}"`));

  await assert.rejects(h.call(h.agent, "board.draw", h.repo, { boxes: [{ id: "x", image: "b".repeat(64) }] }), { code: "BAD_REQUEST", message: /no picture b+ is kept for this board/ });
  await assert.rejects(h.call(h.agent, "board.draw", h.repo, { shapes: [{ form: "image", x: 0, y: 0 }] }), { code: "BAD_REQUEST", message: /a picture is a box/ });
  await assert.rejects(h.call(h.person, "board.image", h.repo, "c".repeat(64)), { code: "NOT_FOUND" });
  // A box called image, in flowchart text, is still a box.
  assert.equal(Object.keys((await h.call(h.agent, "board.draw", h.repo, { text: "image --> registry" }) as BoardDrawn).boxes).join(), "image,registry");
});
