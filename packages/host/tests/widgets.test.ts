// Widgets on a host (widgets.ts): one window of the person's per workspace runs them, until it lets
// go or goes, and the others are told to ask again; someone else's device never runs them. What they draw is kept in memory,
// never in the document; every client is told, at most every 250 ms per widget with the latest
// drawing; only the runner draws, and nothing too big.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import type { EventMessage } from "@hivemind/workspace-api/protocol";
import type { Actor } from "@hivemind/workspace-host/intents";
import { WIDGET_EVERY_MS, widgets } from "../src/widgets.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-widgets-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("a drawing is told to every client, at most every 250 ms with the latest; a peer's or too big a one is refused", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const server: WorkspaceServer = new WorkspaceServer([widgets(() => server)], new Intents(new AuditLog({ file: path.join(tmp, "audit.jsonl") })));
  const client = (actor: Actor) => {
    const told: EventMessage[] = [];
    const c: Connection & { told: EventMessage[] } = { actor, told, send: (m) => told.push(m), closed: new AbortController().signal };
    server.connect(c);
    return c;
  };
  const win = client({ kind: "person" });
  assert.deepEqual(await server.answer("widget.run", ["/api"], win), { result: true });
  const peer = client({ kind: "peer", person: "b".repeat(64), device: "d".repeat(64), access: "edit" });
  const drawn = (c: { told: EventMessage[] }) => c.told.filter((m) => m.event === "widget.drawn").map((m) => (m.params[2] as { n: number } | null)?.n ?? null);

  server.notice("widget.draw", ["/api", "w1", { n: 1 }], win);
  server.notice("widget.draw", ["/api", "w1", { n: 2 }], win);
  server.notice("widget.draw", ["/api", "w1", { n: 3 }], win);
  assert.deepEqual(drawn(peer), [1]);
  t.mock.timers.tick(WIDGET_EVERY_MS);
  assert.deepEqual(drawn(peer), [1, 3]);

  server.notice("widget.draw", ["/api", "w1", { n: 9 }], peer);
  server.notice("widget.draw", ["/api", "w1", { n: 8, pad: "x".repeat(20_000) }], win);
  t.mock.timers.tick(WIDGET_EVERY_MS * 2);
  assert.deepEqual(drawn(win), [1, 3]);
  const all = await server.answer("widget.all", ["/api"], win);
  assert.deepEqual(all, { result: { w1: { n: 3 } } });
});

test("one window runs a workspace's widgets; when it lets go or goes, the others are told and one takes over; someone else's device never runs them", async () => {
  const server: WorkspaceServer = new WorkspaceServer([widgets(() => server)], new Intents(new AuditLog({ file: path.join(tmp, "audit2.jsonl") })));
  const client = (actor: Actor) => {
    const told: EventMessage[] = [];
    const closing = new AbortController();
    const c: Connection & { told: EventMessage[]; close(): void } = { actor, told, send: (m) => told.push(m), closed: closing.signal, close: () => closing.abort() };
    server.connect(c);
    return c;
  };
  const run = async (c: Connection, repo = "/api") => ((await server.answer("widget.run", [repo], c)) as { result?: boolean }).result;
  const a = client({ kind: "person" });
  const b = client({ kind: "person" });
  const peer = client({ kind: "peer", person: "b".repeat(64), device: "d".repeat(64), access: "edit" });
  assert.equal(await run(a), true);
  assert.equal(await run(a), true, "asking again keeps it");
  assert.equal(await run(b), false);
  assert.equal(await run(b, "/web"), true, "each workspace has its own");
  assert.equal(await run(peer, "/other"), false);

  server.notice("widget.draw", ["/api", "w1", { n: 1 }], b);
  assert.equal(b.told.filter((m) => m.event === "widget.drawn").length, 0, "only the runner draws");

  server.notice("widget.release", ["/api"], a);
  assert.ok(b.told.some((m) => m.event === "widget.runner" && m.params[0] === "/api"));
  assert.equal(await run(b), true);
  const before = a.told.filter((m) => m.event === "widget.runner").length;
  b.close();
  assert.equal(a.told.filter((m) => m.event === "widget.runner").length, before + 2, "told for both of b's workspaces");
  assert.equal(await run(a), true);
});

test("the person's own device runs the widgets of a host with no window; someone else's never, and is given no code", async () => {
  const pkg = { id: "@ada/pet", name: "Pet", options: [], chrome: "card" as const, permissions: [], assets: {}, placement: "screen" as const, size: { w: 200, h: 160 }, code: "hive.on('start', () => {})" };
  const server: WorkspaceServer = new WorkspaceServer([widgets(() => server, async () => null, async () => [pkg])], new Intents(new AuditLog({ file: path.join(tmp, "audit-2.jsonl") })));
  const client = (actor: Actor) => {
    const c: Connection = { actor, send: () => {}, closed: new AbortController().signal };
    server.connect(c);
    return c;
  };
  const laptop = client({ kind: "peer", person: "a".repeat(64), device: "1".repeat(64), access: "owner" });
  const guest = client({ kind: "peer", person: "b".repeat(64), device: "2".repeat(64), access: "edit" });
  assert.deepEqual(await server.answer("widget.run", ["/api"], guest), { result: false });
  assert.deepEqual(await server.answer("widget.run", ["/api"], laptop), { result: true });
  assert.deepEqual(await server.answer("widget.packages", ["/api"], laptop), { result: [pkg] });
  assert.deepEqual(await server.answer("widget.packages", ["/api"], guest), { result: [{ ...pkg, code: "" }] });
});

test("a press where a widget's code does not run reaches the window that runs it, and only that window", async () => {
  const server: WorkspaceServer = new WorkspaceServer([widgets(() => server)], new Intents(new AuditLog({ file: path.join(tmp, "audit-3.jsonl") })));
  const client = (actor: Actor) => {
    const told: EventMessage[] = [];
    const c: Connection & { told: EventMessage[] } = { actor, told, send: (m) => told.push(m), closed: new AbortController().signal };
    server.connect(c);
    return c;
  };
  const runner = client({ kind: "person" });
  const guest = client({ kind: "peer", person: "b".repeat(64), device: "2".repeat(64), access: "edit" });
  assert.deepEqual(await server.answer("widget.run", ["/api"], runner), { result: true });
  const pressed = (c: { told: EventMessage[] }) => c.told.filter((m) => m.event === "widget.pressed").map((m) => m.params);
  server.notice("widget.press", ["/api", "w1", { action: "inc" }], guest);
  server.notice("widget.press", ["/api", "w1", { click: true }], guest);
  server.notice("widget.press", ["/api", "w1", { action: "x".repeat(2_000) }], guest);
  server.notice("widget.press", ["/other", "w1", { action: "inc" }], guest);
  assert.deepEqual(pressed(runner), [["/api", "w1", { action: "inc" }], ["/api", "w1", { click: true }]]);
  assert.deepEqual(pressed(guest), []);
});

test("a view of the workspace's widgets sees each drawn and each changed on the board, and its press reaches the runner", async () => {
  const pkg = { id: "@ada/pet", name: "Pet", options: [], chrome: "none" as const, permissions: [], assets: { "dog.png": "data:image/png;base64,AA==", "big.png": "data:image/png;base64,BB==" }, placement: "screen" as const, size: { w: 200, h: 160 }, code: "…" };
  let board: Array<{ kind: string; id: string; widget: string; text?: string }> = [{ kind: "widget", id: "w1", widget: "@ada/pet" }];
  const host = widgets(() => server, async () => null, async () => [pkg], () => board);
  const server: WorkspaceServer = new WorkspaceServer([host], new Intents(new AuditLog({ file: path.join(tmp, "audit-4.jsonl") })));
  const told: EventMessage[] = [];
  const runner: Connection = { actor: { kind: "person" }, send: (m) => told.push(m), closed: new AbortController().signal };
  server.connect(runner);
  await server.answer("widget.run", ["/api"], runner);
  const seen: unknown[][] = [];
  const stop = host.watch("/api", (w) => seen.push(w.map((x) => [x.id, x.tree, Object.keys(x.images), x.text ?? null])));
  await new Promise((r) => setTimeout(r, 0));
  // A runner sends a drawing: its tree, and the card it sits on.
  server.notice("widget.draw", ["/api", "w1", { tree: { type: "image", src: "dog.png" }, chrome: "none" }], runner);
  board = [{ kind: "widget", id: "w1", widget: "@ada/pet", text: "hi" }];
  server.publish("store.changed", { repo: "/api", part: "board" });
  server.publish("store.changed", { repo: "/other", part: "board" });
  assert.deepEqual(seen, [
    [["w1", null, [], null]],
    [["w1", { type: "image", src: "dog.png" }, ["dog.png"], null]],
    [["w1", { type: "image", src: "dog.png" }, ["dog.png"], "hi"]],
  ]);
  host.press("/api", "w1", { action: "pat" });
  assert.deepEqual(told.filter((m) => m.event === "widget.pressed").map((m) => m.params), [["/api", "w1", { action: "pat" }]]);
  stop();
  server.notice("widget.draw", ["/api", "w1", null], runner);
  assert.equal(seen.length, 3, "a watch stopped hears nothing more");
});
