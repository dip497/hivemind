// The workspace store through the workspace API (store.ts): each client writes as
// itself, so its undo takes back its own board edits only; it is told of every other writer's
// change and never of its own; a workspace it may only read takes no write, and the client is told
// to read the part again; and it says which workspace it shows, until it goes.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore } from "@hivemind/workspace-host/store";
import { newSeed } from "@hivemind/workspace-host/identity";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import type { EventMessage } from "@hivemind/workspace-api/protocol";
import { Layouts } from "../src/store.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-layouts-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const note = (id: string, text: string) => ({ id, kind: "note" as const, x: 0, y: 0, w: 200, h: 160, text });

function host(mayWrite?: (repo: string) => boolean) {
  let server: WorkspaceServer;
  const store = new WorkspaceStore({ dir: tmp, person: newSeed(), onChange: (c) => server.publishTo((conn) => !layouts.made(conn, c), "store.changed", { repo: c.repo, part: c.part }) });
  const layouts = new Layouts(() => store, mayWrite);
  server = new WorkspaceServer([layouts.domain], new Intents(new AuditLog({ file: path.join(tmp, "audit.jsonl") })));
  const client = () => {
    const closing = new AbortController();
    const told: EventMessage[] = [];
    const c: Connection & { told: EventMessage[]; close(): void } = { actor: { kind: "person" }, told, send: (m) => told.push(m), closed: closing.signal, close: () => closing.abort() };
    server.connect(c);
    return c;
  };
  const call = async (from: Connection, method: string, ...params: unknown[]) => {
    const answer = await server.answer(method, params, from);
    if ("error" in answer) throw new Error(`${answer.error.code}: ${answer.error.message}`);
    return answer.result;
  };
  return { store, layouts, server, client, call };
}

test("each client writes as itself: it is told of the other's change, never of its own, and its undo takes back only its edit", async () => {
  const h = host();
  const [a, b] = [h.client(), h.client()];
  await h.call(a, "store.setObjects", "/board", [note("n1", "a's")], []);
  await h.call(b, "store.setObjects", "/board", [note("n1", "a's"), note("n2", "b's")], [note("n1", "a's")]);
  assert.deepEqual(a.told, [{ event: "store.changed", params: [{ repo: "/board", part: "board" }] }]);
  assert.deepEqual(b.told, [{ event: "store.changed", params: [{ repo: "/board", part: "board" }] }]);
  assert.equal(await h.call(a, "store.undo", "/board"), true);
  assert.deepEqual(h.store.getObjects("/board").map((o) => o.id), ["n2"]);
  assert.equal(await h.call(a, "store.undo", "/board"), false, "b's edit is not a's to take back");
});

test("a layout the store cannot hold is a bad request, and nothing is written", async () => {
  const h = host();
  const a = h.client();
  const answer = await h.server.answer("store.setView", ["/r", "canvas", { data: "not a layout" }], a);
  assert.equal("error" in answer && answer.error.code, "BAD_REQUEST");
  assert.equal(h.store.getView("/r", "canvas"), null);
});

test("a client says which workspace it shows, and where its user is there, until it says none or goes", async () => {
  const h = host();
  const [a, b] = [h.client(), h.client()];
  h.server.notice("store.shown", ["/one", "frame-1"], a);
  h.server.notice("store.shown", ["/two", null], b);
  assert.deepEqual(h.layouts.shownBy(a), { repo: "/one", frame: "frame-1" });
  assert.deepEqual(h.layouts.shownBy(b), { repo: "/two", frame: null });
  h.server.notice("store.shown", [null, null], b);
  assert.equal(h.layouts.shownBy(b), null);
  a.close();
  assert.equal(h.layouts.shownBy(a), null);
  assert.equal(h.layouts.anyShown(), null);
});

test("a workspace the host may only read takes no write, and the client is told to read the part again", async () => {
  const h = host((repo) => repo !== "hive://copy");
  const a = h.client();
  await h.call(a, "store.setObjects", "hive://copy", [note("n1", "mine")], []);
  await h.call(a, "store.setView", "hive://copy", "canvas", { data: { zoom: 2 } }, null);
  assert.deepEqual(h.store.getObjects("hive://copy"), []);
  assert.equal(h.store.getView("hive://copy", "canvas"), null);
  assert.equal(await h.call(a, "store.undo", "hive://copy"), false);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(a.told, [
    { event: "store.changed", params: [{ repo: "hive://copy", part: "board" }] },
    { event: "store.changed", params: [{ repo: "hive://copy", part: "view:canvas" }] },
  ]);
  // Elsewhere it writes as before.
  await h.call(a, "store.setObjects", "/mine", [note("n1", "mine")], []);
  assert.deepEqual(h.store.getObjects("/mine").map((o) => o.id), ["n1"]);
});
