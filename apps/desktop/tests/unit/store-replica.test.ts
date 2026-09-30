// A client over a stream holds the layouts it opened (StoreReplica), against the host's store as
// the app serves it (workspace/store.ts on a WorkspaceStore). The transport here answers a moment
// later, and lets every other call overtake the one before it, as requests over HTTP can: what a
// client holds is tested with its answers still on the way, and arriving out of order.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore } from "@hivemind/workspace-host/store";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import { WorkspaceClient } from "@hivemind/workspace-api/client";
import { StoreReplica } from "@hivemind/workspace-api/store-replica";
import type { EventMessage } from "@hivemind/workspace-api/protocol";
import { Layouts } from "../../src/main/workspace/store.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-replica-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let hosts = 0;
const later = () => new Promise((r) => setTimeout(r, 0));
const tile = (id: string) => ({ id, kind: "terminal" });
const core = (...ids: string[]) => ({ v: 1, frames: [], tiles: ids.map(tile) });
const idsOf = (layout: unknown) => ((layout as { tiles?: Array<{ id: string }> } | null)?.tiles ?? []).map((t) => t.id);
async function until(check: () => boolean, ms = 3_000): Promise<void> {
  for (const end = Date.now() + ms; !check(); await later()) if (Date.now() > end) throw new Error("timed out");
}

function host() {
  const dir = path.join(tmp, `host-${hosts++}`);
  let server: WorkspaceServer;
  const store = new WorkspaceStore({ dir, onChange: (c) => server.publishTo((conn) => !layouts.made(conn, c), "store.changed", { repo: c.repo, part: c.part }) });
  const layouts = new Layouts(() => store);
  server = new WorkspaceServer([layouts.domain], new Intents(new AuditLog({ file: path.join(dir, "audit.jsonl") })));
  /** A client over a stream: every answer and every event arrives later, every other call
   *  overtaking the one before it. */
  const client = () => {
    let calls = 0;
    const listeners: Array<(m: EventMessage) => void> = [];
    const connection: Connection = {
      actor: { kind: "person" },
      send: (m) => { const copy = JSON.parse(JSON.stringify(m)) as EventMessage; setTimeout(() => { for (const l of listeners) l(copy); }); },
      closed: new AbortController().signal,
    };
    server.connect(connection);
    const api = new WorkspaceClient({
      call: async (method, params) => {
        await new Promise((r) => setTimeout(r, calls++ % 2 === 0 ? 8 : 0));
        const answer = await server.answer(method, JSON.parse(JSON.stringify(params)), connection);
        await later();
        return JSON.parse(JSON.stringify(answer));
      },
      notice: (method, params) => server.notice(method, params, connection),
      events: (listener) => { listeners.push(listener); },
    });
    return new StoreReplica(api, (m) => { throw new Error(m); });
  };
  return { store, client };
}

test("a client reads what it opened at once, and its writes reach the host in the order it made them", async () => {
  const h = host();
  h.store.setCore("/r", core("t1"));
  const a = h.client();
  await a.open("/r");
  assert.deepEqual(idsOf(a.core("/r")), ["t1"]);
  const opened = a.core("/r");
  a.setCore("/r", core("t1", "t2"), opened);
  assert.deepEqual(idsOf(a.core("/r")), ["t1", "t2"], "held at once");
  a.setCore("/r", core("t1", "t2", "t3"), core("t1", "t2"));
  await until(() => idsOf(h.store.getCore("/r")).length === 3);
  await later();
  assert.deepEqual(idsOf(h.store.getCore("/r")), ["t1", "t2", "t3"]);
});

test("another client's change is told once it is held, with this client's own writes kept in it", async () => {
  const h = host();
  h.store.setCore("/r", core("t1"));
  const [a, b] = [h.client(), h.client()];
  await a.open("/r");
  await b.open("/r");
  const told: string[][] = [];
  b.onChange((c) => { if (c.part === "core") told.push(idsOf(b.core("/r"))); });
  a.setCore("/r", core("t1", "a1"), core("t1"));
  b.setCore("/r", core("t1", "b1"), core("t1")); // b's own, made before it reads a's
  await until(() => told.length > 0);
  assert.deepEqual(told.at(-1)!.sort(), ["a1", "b1", "t1"]);
  assert.deepEqual(idsOf(h.store.getCore("/r")).sort(), ["a1", "b1", "t1"]);
});

test("a reading that the client's own write overtook is read again after it, never held over it", async () => {
  const h = host();
  h.store.setCore("/r", core("t1"));
  const [a, b] = [h.client(), h.client()];
  await a.open("/r");
  await b.open("/r");
  const told: string[][] = [];
  b.onChange((c) => { if (c.part === "core") told.push(idsOf(b.core("/r"))); });
  a.setCore("/r", core("t1", "a1"), core("t1"));
  // b writes while its reading of a's change is on the way.
  await until(() => h.store.getCore("/r") !== null && idsOf(h.store.getCore("/r")).includes("a1"));
  await later();
  await later();
  b.setCore("/r", core("t1", "b1"), core("t1"));
  await until(() => told.length > 0);
  await new Promise((r) => setTimeout(r, 50));
  for (const held of told) assert.ok(held.includes("b1"), `told with b's write kept: ${held}`);
  assert.deepEqual(idsOf(b.core("/r")).sort(), ["a1", "b1", "t1"]);
});

test("an undo answers false at once, and what it took back arrives as a change", async () => {
  const h = host();
  const a = h.client();
  await a.open("/r");
  const note = (id: string, text: string) => ({ id, kind: "note" as const, x: 0, y: 0, w: 200, h: 160, text });
  a.setObjects("/r", [note("n1", "first")], []);
  a.setObjects("/r", [note("n1", "second")], [note("n1", "first")]);
  const texts: string[] = [];
  a.onChange((c) => { if (c.part === "board") texts.push((a.objects("/r")[0] as unknown as { text: string }).text); });
  assert.equal(a.undo("/r"), false);
  await until(() => texts.length > 0);
  assert.deepEqual(texts, ["first"]);
  assert.equal((h.store.getObjects("/r")[0] as unknown as { text: string }).text, "first");
});

test("a read of a workspace not opened answers nothing and opens it; what it holds then arrives as changes", async () => {
  const h = host();
  h.store.setCore("/r", core("t1"));
  h.store.setView("/r", "canvas", { v: 1, data: { positions: {} } });
  const a = h.client();
  const parts: string[] = [];
  a.onChange((c) => parts.push(c.part));
  assert.equal(a.core("/r"), null);
  await until(() => parts.length === 3);
  assert.deepEqual(parts.sort(), ["board", "core", "view:canvas"]);
  assert.deepEqual(idsOf(a.core("/r")), ["t1"]);
});
