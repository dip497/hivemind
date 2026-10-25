// How busy watched terminals are (tile-activity.ts), at the workspace API: each client keeps its own
// watch (`terminal.watchActivity`), so one window's watch never takes another's place; a change goes
// only to the clients that watch that tile; one that starts watching a busy tile is told its level
// at once; a client that went is told nothing more. How bytes become levels is pty-activity.test.ts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import type { EventMessage } from "@hivemind/workspace-api/protocol";
import { SAMPLE_MS } from "../src/pty-activity.ts";
import { TileActivity } from "../src/tile-activity.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-tile-activity-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function host() {
  const activity = new TileActivity(() => server);
  const server = new WorkspaceServer([activity.domain], new Intents(new AuditLog({ file: path.join(tmp, "audit.jsonl") })));
  const client = () => {
    const closing = new AbortController();
    const told: EventMessage[] = [];
    const c: Connection & { told: EventMessage[]; close(): void } = { actor: { kind: "person" }, told, send: (m) => told.push(m), closed: closing.signal, close: () => closing.abort() };
    server.connect(c);
    return c;
  };
  const watch = (c: Connection, tiles: string[]) => server.notice("terminal.watchActivity", [tiles], c);
  /** Each `terminal.activity` `c` was told, oldest first. */
  const heard = (c: { told: EventMessage[] }) => c.told.filter((m) => m.event === "terminal.activity").map((m) => m.params[0]);
  /** `bare` prints heavily for one sample. */
  const busy = (bare: string) => activity.note(bare, 1_000_000);
  return { client, watch, heard, busy };
}

test("each client keeps its own watch: a window's watch does not replace another's, and a level goes to the clients that watch its tile alone", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = host();
  const [a, b] = [h.client(), h.client()];
  h.watch(a, ["t1"]);
  h.watch(b, ["t2"]);
  h.busy("t1");
  h.busy("t2");
  t.mock.timers.tick(SAMPLE_MS);
  assert.deepEqual(h.heard(a), [{ t1: 3 }]);
  assert.deepEqual(h.heard(b), [{ t2: 3 }]);
});

test("a client that starts watching a tile already busy is told its level at once, by its bare id", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = host();
  const [a, b] = [h.client(), h.client()];
  h.watch(a, ["t1"]);
  h.busy("t1");
  t.mock.timers.tick(SAMPLE_MS);
  h.watch(b, ["hm:t1"]);
  assert.deepEqual(h.heard(b), [{ t1: 3 }]);
  h.watch(b, ["t1"]);
  assert.equal(h.heard(b).length, 1, "a tile it watched already is not told again");
});

test("once a client goes, or watches nothing, it is told nothing more, and the others still are", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = host();
  const [a, b, c] = [h.client(), h.client(), h.client()];
  h.watch(a, ["t1"]);
  h.watch(b, ["t1"]);
  h.watch(c, ["t1"]);
  a.close();
  h.watch(b, []);
  h.busy("t1");
  t.mock.timers.tick(SAMPLE_MS);
  assert.deepEqual([h.heard(a), h.heard(b), h.heard(c)], [[], [], [{ t1: 3 }]]);
});

test("once the last client watching a tile goes, its output is no longer measured", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = host();
  const a = h.client();
  h.watch(a, ["t1"]);
  a.close();
  h.busy("t1");
  t.mock.timers.tick(SAMPLE_MS);
  const b = h.client();
  h.watch(b, ["t1"]);
  assert.deepEqual(h.heard(b), [], "what it printed while no one watched was not counted");
});
