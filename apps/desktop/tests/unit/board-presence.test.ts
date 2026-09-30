// Presence on a host (workspace/presence.ts): a window's participant is the person at this
// machine, a peer's the person its device is, whatever name either sends; every client is told who
// is in the workspace as it changes, at once after a quiet spell and at most every 50 ms while
// people move; one who says they left, or whose connection goes, is gone from it, and the others
// are told.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import type { Participant } from "@hivemind/workspace-host/presence";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import type { EventMessage } from "@hivemind/workspace-api/protocol";
import type { Actor } from "@hivemind/workspace-host/intents";
import { PRESENCE_EVERY_MS, presence } from "../../src/main/workspace/presence.ts";

const ME = "a".repeat(64);
const PRIYA = "b".repeat(64);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-presence-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function host() {
  const server: WorkspaceServer = new WorkspaceServer([presence(() => server, () => ME)], new Intents(new AuditLog({ file: path.join(tmp, "audit.jsonl") })));
  const client = (actor: Actor) => {
    const closing = new AbortController();
    const told: EventMessage[] = [];
    const c: Connection & { told: EventMessage[]; close(): void } = { actor, told, send: (m) => told.push(m), closed: closing.signal, close: () => closing.abort() };
    server.connect(c);
    return c;
  };
  /** Who the last `presence.changed` about `repo` that `c` was told of says is there. */
  const seen = (c: { told: EventMessage[] }, repo: string) => {
    const last = c.told.filter((m) => m.event === "presence.changed" && m.params[0] === repo).at(-1);
    return last ? (last.params[1] as Participant[]).map((p) => `${p.person === ME ? "me" : p.person === PRIYA ? "priya" : p.person}:${p.name}@${p.cursor ? `${p.cursor.x},${p.cursor.y}` : "-"}`) : null;
  };
  /** How many times `c` was told who is in `repo`. */
  const times = (c: { told: EventMessage[] }, repo: string) => c.told.filter((m) => m.event === "presence.changed" && m.params[0] === repo).length;
  return { server, client, seen, times };
}
const state = (name: string, x: number | null) => ({ name, color: "", cursor: x === null ? null : { x, y: 0 }, selection: [] });

test("each participant is the person their connection is, and every client is told who is there as it changes", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = host();
  const win = h.client({ kind: "person" });
  const peer = h.client({ kind: "peer", person: PRIYA, device: "d".repeat(64), access: "view" });
  h.server.notice("presence.set", ["/api", state("Me", 1)], win);
  h.server.notice("presence.set", ["/api", state("Not Priya", 2)], peer);
  t.mock.timers.tick(PRESENCE_EVERY_MS);
  const both = ["me:Me@1,0", "priya:Not Priya@2,0"];
  assert.deepEqual(h.seen(win, "/api"), both);
  assert.deepEqual(h.seen(peer, "/api"), both);
  // The name is theirs to choose; who they are is not.
  h.server.notice("presence.set", ["/api", { ...state("Priya", 3), person: ME }], peer);
  t.mock.timers.tick(PRESENCE_EVERY_MS);
  assert.deepEqual(h.seen(win, "/api"), ["me:Me@1,0", "priya:Priya@3,0"]);
});

test("one who says they left, or whose connection goes, is gone from the workspace, and the others are told", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = host();
  const a = h.client({ kind: "person" });
  const b = h.client({ kind: "person" });
  const peer = h.client({ kind: "peer", person: PRIYA, device: "d".repeat(64), access: "view" });
  h.server.notice("presence.set", ["/api", state("Me", 1)], a);
  h.server.notice("presence.set", ["/api", state("Me", null)], b);
  h.server.notice("presence.set", ["/api", state("Priya", 2)], peer);
  h.server.notice("presence.set", ["/web", state("Priya", 3)], peer);

  h.server.notice("presence.set", ["/api", null], a);
  t.mock.timers.tick(PRESENCE_EVERY_MS);
  assert.deepEqual(h.seen(peer, "/api"), ["me:Me@-", "priya:Priya@2,0"]);
  peer.close();
  t.mock.timers.tick(PRESENCE_EVERY_MS);
  assert.deepEqual(h.seen(b, "/api"), ["me:Me@-"]);
  assert.deepEqual(h.seen(b, "/web"), []);
});

test("a move after a quiet spell is told at once; moves in the 50 ms after one told are told together, once, when it has been 50 ms", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = host();
  const win = h.client({ kind: "person" });
  const peer = h.client({ kind: "peer", person: PRIYA, device: "d".repeat(64), access: "view" });
  h.server.notice("presence.set", ["/api", state("Priya", 1)], peer);
  assert.deepEqual([h.times(win, "/api"), h.seen(win, "/api")], [1, ["priya:Priya@1,0"]]);
  for (let x = 2; x <= 5; x++) {
    t.mock.timers.tick(10);
    h.server.notice("presence.set", ["/api", state("Priya", x)], peer);
  }
  assert.equal(h.times(win, "/api"), 1);
  t.mock.timers.tick(PRESENCE_EVERY_MS - 40);
  assert.deepEqual([h.times(win, "/api"), h.seen(win, "/api")], [2, ["priya:Priya@5,0"]]);
  // Another workspace is told on its own.
  h.server.notice("presence.set", ["/web", state("Priya", 9)], peer);
  assert.equal(h.times(win, "/web"), 1);
  t.mock.timers.tick(PRESENCE_EVERY_MS * 4);
  h.server.notice("presence.set", ["/api", state("Priya", 6)], peer);
  assert.deepEqual([h.times(win, "/api"), h.seen(win, "/api")], [3, ["priya:Priya@6,0"]]);
});
